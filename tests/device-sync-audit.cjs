// Manual audit of the connected Android WebAPK via adb forward tcp:9223.
// It uses only StoryShaper controls and prints only StoryShaper page state.
const endpoint = 'http://127.0.0.1:9223/json';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const expression = `(() => ({
  visible: document.visibilityState,
  standalone: matchMedia('(display-mode: standalone)').matches,
  state: document.querySelector('#book')?.dataset.state,
  question: document.querySelector('#question')?.textContent,
  status: document.querySelector('#status')?.textContent,
  current: [...document.querySelectorAll('.art > img')].map(img => ({
    id: img.id, src: img.getAttribute('src'), className: img.className,
    opacity: getComputedStyle(img).opacity, z: getComputedStyle(img).zIndex
  })),
  motion: document.querySelectorAll('.motion-stage').length,
  sprites: document.querySelectorAll('.motion-stage img').length,
  animations: [...document.querySelectorAll('.art img.is-current, .motion-stage')]
    .flatMap(el => el.getAnimations().map(animation => animation.playState)),
  video: {hidden: document.querySelector('#storyVideo')?.hidden,
    time: document.querySelector('#storyVideo')?.currentTime},
  playback: document.querySelector('#narrationStatus')?.textContent,
  events: window.__storySyncEvents || []
}))()`;

async function inspect(tab) {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once:true});
      socket.addEventListener('error', reject, {once:true});
    }),
    new Promise((_, reject) => setTimeout(() => reject(Error('CDP connect timeout')), 3000)),
  ]);
  try {
    let id = 0;
    const send = (method, params = {}) => {
      const commandId = ++id;
      return Promise.race([
        new Promise((resolve, reject) => {
          const listener = event => {
            const message = JSON.parse(event.data);
            if (message.id !== commandId) return;
            socket.removeEventListener('message', listener);
            message.error ? reject(Error(message.error.message)) : resolve(message.result);
          };
          socket.addEventListener('message', listener);
          socket.send(JSON.stringify({id:commandId, method, params}));
        }),
        new Promise((_, reject) => setTimeout(() => reject(Error(`CDP ${method} timeout`)), 5000)),
      ]);
    };
    const evaluate = async (source = expression) => (await send('Runtime.evaluate',
      {expression:source, returnByValue:true, awaitPromise:true})).result.value;
    const until = async (source, timeout = 20000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(source)) return;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw Error(`Timed out waiting for StoryShaper: ${source}`);
    };
    let result = await evaluate();
    if (result.visible === 'visible' && process.argv.includes('--reload')) {
      await send('Page.reload', {ignoreCache:true});
      await new Promise(resolve => setTimeout(resolve, 2500));
      result = await evaluate();
    }
    const action = process.argv.find(arg => arg.startsWith('--action='))?.slice(9);
    if (result.visible === 'visible' && action) {
      if (action === 'start') {
        await evaluate(`(() => { window.__storySyncEvents = []; const old = StoryMotion.prototype.cue;
          StoryMotion.prototype.cue = function(index, key, sentence) {
            const event = old.call(this, index, key, sentence);
            window.__storySyncEvents.push({ms:Math.round(performance.now()), line:index, sentence,
              event, cover:!!document.querySelector('.story-cue-cover')}); return event;
          }; document.querySelector('#cover').click(); return true; })()`);
        await until(`['ASKING', 'VOICING'].includes(document.querySelector('#book').dataset.state)`);
      } else if (action === 'straw' || action === 'predict') {
        const oldQuestion = await evaluate(`document.querySelector('#question').textContent`);
        await evaluate(`document.querySelector('#mic').click()`);
        await until(`!document.querySelector('#choices').hidden && !!document.querySelector('#choices button')`);
        await evaluate(`(() => { const buttons=[...document.querySelectorAll('#choices button')];
          (buttons.find(b => ${JSON.stringify(action)} === 'straw' && /짚|straw/i.test(b.textContent)) || buttons[0]).click(); return true; })()`);
        await until(`document.querySelector('#question').textContent !== ${JSON.stringify(oldQuestion)}
          && document.querySelector('#book').dataset.state === 'ASKING'`, 30000);
      } else if (action === 'pause' || action === 'resume' || action === 'replay') {
        const button = action === 'pause' ? '#pauseNarration' : '#playNarration';
        await until(`!document.querySelector('${button}').disabled`);
        await evaluate(`document.querySelector('${button}').click()`);
        await until(`document.querySelector('#narrationStatus').textContent.includes(${JSON.stringify(
          action === 'pause' ? '일시정지' : '읽는 중')})`);
      } else throw Error(`Unknown action: ${action}`);
      result = await evaluate();
    }
    if (result.visible === 'visible' && process.argv.includes('--screenshot')) {
      const shot = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
      const file = path.join(os.tmpdir(), 'storyshaper-sync-audit.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      result.screenshot = file;
    }
    return result;
  } finally { socket.close(); }
}

(async () => {
  const tabs = (await (await fetch(endpoint)).json()).filter(tab => tab.type === 'page'
    && tab.url.endsWith('/prototype/index.html'));
  const states = await Promise.all(tabs.map(inspect));
  console.log(JSON.stringify(states.find(state => state.visible === 'visible') || states[0] || {}, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
