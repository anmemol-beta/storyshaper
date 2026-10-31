// Inspect the real Android Chrome tab after adb forward tcp:9223 localabstract:chrome_devtools_remote.
const tabsUrl = 'http://127.0.0.1:9223/json';

async function main() {
  const tabs = await (await fetch(tabsUrl)).json();
  const tab = tabs.find(item => item.type === 'page' && /\/prototype\/(index|live)\.html/.test(item.url));
  if (!tab) throw Error('Open the reader in Android Chrome first.');
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
  try {
    await cdp('Page.reload', {ignoreCache: true});
    await new Promise(resolve => setTimeout(resolve, 1200));
    const manifest = await cdp('Page.getAppManifest');
    const errors = await cdp('Page.getInstallabilityErrors');
    const runtime = await cdp('Runtime.evaluate', {expression: `({href:location.href, standalone:matchMedia('(display-mode: standalone)').matches,
      secure:isSecureContext, manifest:document.querySelector('link[rel=manifest]')?.href})`, returnByValue: true});
    console.log(JSON.stringify({page: runtime.result.value, manifestUrl: manifest.url,
      manifestErrors: manifest.errors, installabilityErrors: errors.installabilityErrors}, null, 2));
    if (!manifest.url || manifest.errors?.length || errors.installabilityErrors?.length) process.exitCode = 1;
  } finally { socket.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
