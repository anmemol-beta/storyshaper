// Manual Z Fold browser check after: adb reverse tcp:8000 tcp:8000,
// adb forward tcp:9223 localabstract:chrome_devtools_remote, media.server on 8000.
// Run with Node 24+: node tests/device-motion-smoke.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const tabs = await (await fetch('http://127.0.0.1:9223/json')).json();
  const tab = tabs.find(item => item.type === 'page' && item.url.includes('/prototype/motion-review.html'));
  if (!tab) throw Error('Open /prototype/motion-review.html in phone Chrome first.');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    response.error ? entry.reject(Error(response.error.message)) : entry.resolve(response.result);
  });
  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function screenshot(name) {
    const result = await cdp('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    const file = path.join(os.tmpdir(), `storyshaper-phone-${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
  try {
    const ready = await evaluate(`({image:document.querySelector('#pictureImage')?.naturalWidth || 0,
      picture:document.querySelector('#picture')?.value, action:document.querySelector('#action')?.value,
      width:innerWidth,height:innerHeight,devicePixelRatio})`);
    if (!ready.image) throw Error('The picture has not loaded on the phone.');
    const still = await screenshot('still');
    await evaluate(`document.querySelector('#play').click()`);
    await delay(700);
    const playing = await evaluate(`({sprites:document.querySelectorAll('.motion-stage img').length,
      canvas:!!document.querySelector('.motion-stage canvas'),
      animations:document.querySelector('#art').getAnimations({subtree:true}).filter(a=>a.playState==='running').length,
      stage:!!document.querySelector('.motion-stage')})`);
    const frame1 = await screenshot('motion-1');
    await delay(450);
    const frame2 = await screenshot('motion-2');
    console.log(JSON.stringify({device: ready, playing, screenshots: [still, frame1, frame2]}, null, 2));
    if (!playing.stage || !playing.canvas || !playing.sprites || !playing.animations)
      throw Error('Motion stage, sprites, or running animations missing on the phone.');
  } finally {
    try { await evaluate(`document.querySelector('#still').click()`); } catch {}
    socket.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
