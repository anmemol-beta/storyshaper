// Manual connected Android Chrome smoke test for the real offline reader.
// Requires media.server on :8000 and adb reverse/forward as in device-motion-smoke.cjs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const tabs = await (await fetch('http://127.0.0.1:9223/json')).json();
  const tab = tabs.find(item => item.type === 'page' && item.url.includes('/prototype/live.html'));
  if (!tab) throw Error('Open /prototype/live.html in phone Chrome first.');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data), entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    response.error ? entry.reject(Error(response.error.message)) : entry.resolve(response.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await evaluate(expression);
      if (result) return result;
      await delay(200);
    }
    throw Error(`Timed out: ${expression}`);
  }
  async function screenshot(name) {
    const result = await cdp('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    const file = path.join(os.tmpdir(), `storyshaper-reader-${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
  const state = `({page:document.querySelector('#book').dataset.state,
    image:document.querySelector('#imgCur').getAttribute('src'),
    question:document.querySelector('#question').textContent,
    status:document.querySelector('#status').textContent,
    sprites:document.querySelectorAll('.motion-stage img').length,
    animations:document.querySelector('.art')?.getAnimations({subtree:true}).filter(a=>a.playState==='running').length || 0})`;
  let oldReadAloud;
  try {
    await until(`!!document.querySelector('#cover')`);
    oldReadAloud = await evaluate(`document.querySelector('#readAloud').checked`);
    if (oldReadAloud) await evaluate(`document.querySelector('#readAloud').click()`);
    await evaluate(`document.querySelector('#cover').click()`);
    await until(`document.querySelector('#book').dataset.state==='ASKING'`);
    const steps = [await evaluate(state)];
    let target = null;
    for (let i = 0; i < 7; i += 1) {
      const before = steps.at(-1);
      await evaluate(`document.querySelector('#mic').click()`);
      await until(`!document.querySelector('#choices').hidden && document.querySelector('#choices button')`);
      const selected = await evaluate(`(() => { const list=[...document.querySelectorAll('#choices button')];
        const choice=list.find(b=>/straw|짚/i.test(b.textContent)) || list[0];
        const text=choice.textContent; choice.click(); return text; })()`);
      await until(`(() => { const q=document.querySelector('#question').textContent;
        const image=document.querySelector('#imgCur').getAttribute('src');
        return (q!==${JSON.stringify(before.question)} || image!==${JSON.stringify(before.image)}) &&
          document.querySelector('#book').dataset.state!=='DRAWING'; })()`, 45000);
      await delay(300);
      const next = await evaluate(state);
      steps.push({...next, selected});
      if (/wolf_straw|straw_blown_away/.test(next.image)) { target = next; break; }
      if (next.page === 'COMPLETE') break;
    }
    if (!target) throw Error(`Did not reach a straw/wolf scene: ${JSON.stringify(steps)}`);
    await until(`document.querySelectorAll('.motion-stage img').length > 0`);
    const frame1 = await screenshot('motion-1');
    await delay(400);
    const frame2 = await screenshot('motion-2');
    console.log(JSON.stringify({steps, target: await evaluate(state), screenshots: [frame1, frame2]}, null, 2));
  } finally {
    if (oldReadAloud) {
      try { await evaluate(`document.querySelector('#readAloud').click()`); } catch {}
    }
    socket.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
