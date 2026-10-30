const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class Element {
  constructor() {
    this.dataset = {}; this.children = []; this.listeners = {};
    this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
  }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  fire(name) { return this.listeners[name]?.({preventDefault() {}}); }
  querySelector() { return this.option ||= new Element(); }
  querySelectorAll() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
}
function snapshot(mode, id) {
  return {sessionId:id, version:0, sceneId:'house1_choose', language:'en',
    question:{id:'house1_choose', text:'What material?', intent:'choose_material', choices:[]},
    lines:[{speakerId:'narrator', text:'The story begins.'}], decision:'ready', reason:'story_started',
    attempts:0, choiceMode:false, storyState:{language:'en'}, mediaPlan:null, diagnostics:{}, providerMode:mode};
}
async function harness(initialAvailable = true, globals = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('mode').value = 'mock';
  const calls = [];
  const settings = {available:initialAvailable, answerResult:null, languageResult:null, vision:Boolean(globals.CameraInput)};
  const languageButtons = ['en', 'ko'].map(value => { const button = new Element(); button.dataset.language = value; return button; });
  const document = {documentElement:{}, getElementById:element, querySelectorAll:selector => selector === '[data-language]' ? languageButtons : [], createElement:() => new Element()};
  const context = vm.createContext({document, localStorage:{getItem() {return null;}, setItem() {}},
    AbortController, crypto:require('node:crypto'), setTimeout:() => 1, clearTimeout() {}, ...globals,
    fetch:async (url, options={}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({url, body});
      const data = url === '/api/config' ? {liveAvailable:settings.available, model:'test-model', visionAvailable:settings.vision}
        : url === '/api/answer' && settings.answerResult ? settings.answerResult
        : url === '/api/language' && settings.languageResult ? settings.languageResult
        : snapshot(body.mode, `session-${calls.length}`);
      return {ok:true, json:async () => data};
    }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/agent-i18n.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/agent.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return {element, calls, settings, languageButtons};
}

test('changing from an active mock session to live starts a real live session', async () => {
  const {element, calls} = await harness();
  element('mode').value = 'mock';
  await element('startButton').fire('click');
  assert.equal(calls.filter(call => call.url === '/api/sessions').at(-1).body.mode, 'mock');
  element('mode').value = 'live';
  await element('mode').fire('change');
  const starts = calls.filter(call => call.url === '/api/sessions');
  assert.equal(starts.length, 2, 'Selecting Live must replace the existing mock session');
  assert.equal(starts.at(-1).body.mode, 'live');
  assert.equal(element('modeBadge').textContent, 'Live model');
});

test('mode selection before a session only changes the selected mode', async () => {
  const {element, calls} = await harness();
  element('mode').value = 'mock';
  await element('mode').fire('change');
  assert.equal(calls.filter(call => call.url === '/api/sessions').length, 0);
  assert.match(element('modeBadge').textContent, /no model call/);
});

test('refreshing connection discovers a newly configured live key', async () => {
  const {element, calls, settings} = await harness(false);
  assert.equal(element('mode').value, 'mock');
  settings.available = true;
  await element('refreshConfig').fire('click');
  assert.equal(calls.filter(call => call.url === '/api/config').length, 2);
  assert.equal(element('mode').value, 'live');
  assert.equal(element('modeBadge').textContent, 'Live model');
});

test('connection refresh does not disguise an active mock session as live', async () => {
  const {element, settings} = await harness(false);
  await element('startButton').fire('click');
  settings.available = true;
  await element('refreshConfig').fire('click');
  assert.equal(element('mode').value, 'mock');
  assert.match(element('modeBadge').textContent, /no model call/);
});


test('custom material image notice preserves story input, translates, and clears on restart', async () => {
  const {element, settings, languageButtons} = await harness();
  await element('startButton').fire('click');
  const result = snapshot('mock', 'custom-session');
  Object.assign(result, {version:1, sceneId:'house1_predict', decision:'accept', reason:'answer_accepted',
    storyState:{language:'en', houseIndex:1, stage:'predict', houses:[{houseId:'house1', material:'custom'}]}});
  settings.answerResult = result;
  element('answer').value = 'vinyl';
  await element('answerForm').fire('submit');
  await new Promise(setImmediate);
  assert.equal(element('mediaNotice').hidden, false);
  assert.match(element('mediaNotice').textContent, /picture for this material is not available/);
  assert.equal(element('answer').disabled, false, 'Missing artwork must not stop the next story answer');
  settings.languageResult = {...result, language:'ko', storyState:{...result.storyState, language:'ko'}};
  await languageButtons[1].fire('click');
  assert.equal(element('mediaNotice').hidden, false);
  assert.match(element('mediaNotice').textContent, /이 재료의 그림은 아직 준비되지 않았어요/);
  await element('startButton').fire('click');
  assert.equal(element('mediaNotice').hidden, true);
  assert.equal(element('mediaNotice').textContent, '');
});

test('unsupported material explanation uses readable words in English', async () => {
  const {element, settings} = await harness();
  await element('startButton').fire('click');
  settings.answerResult = {...snapshot('mock', 'session'), decision:'clarify', reason:'unsupported_material', attempts:1};
  element('answer').value = 'cloud';
  await element('answerForm').fire('submit');
  await new Promise(setImmediate);
  assert.match(element('attemptNote').textContent, /safe story branch for that material is not available/);
  assert.doesNotMatch(element('attemptNote').textContent, /unsupported_material/);
  assert.equal(element('mediaNotice').hidden, true);
});

function fakeCamera(name) {
  const camera = {opened:0, named:[], supported:() => true,
    async open() { camera.opened += 1; return {async snap() { return 'frame'; }, close() {}}; },
    async name(blob, language) { camera.named.push([blob, language]); return name; }};
  return camera;
}
const blobUrls = {createObjectURL:() => 'blob:frame', revokeObjectURL() {}};

test('a camera answer fills the answer box and waits for Continue', async () => {
  const camera = fakeCamera('a cookie');
  const {element, calls} = await harness(true, {CameraInput:camera, URL:blobUrls});
  await element('startButton').fire('click');
  assert.equal(element('cameraButton').hidden, false);
  await element('cameraButton').fire('click');
  assert.equal(element('cameraPanel').hidden, false);
  assert.equal(element('micButton').disabled, true);
  await element('snapButton').fire('click');
  assert.deepEqual(camera.named, [['frame', 'en']]);
  assert.equal(element('answer').value, 'a cookie');
  assert.match(element('requestStatus').textContent, /The camera saw: “a cookie”/);
  assert.equal(calls.filter(call => call.url === '/api/answer').length, 0);
  await element('answerForm').fire('submit');
  await new Promise(setImmediate);
  assert.equal(calls.filter(call => call.url === '/api/answer').at(-1).body.answer, 'a cookie');
  assert.equal(element('cameraPanel').hidden, true);
});

test('a frame with nothing clear is not sent and not counted as a try', async () => {
  const camera = fakeCamera('');
  const {element, calls} = await harness(true, {CameraInput:camera, URL:blobUrls});
  await element('startButton').fire('click');
  await element('cameraButton').fire('click');
  await element('snapButton').fire('click');
  assert.equal(element('answer').value, '');
  assert.match(element('requestStatus').textContent, /not counted as a try/);
  assert.equal(calls.filter(call => call.url === '/api/answer').length, 0);
  assert.equal(element('snapButton').textContent, 'Show something else');
});

test('the camera button hides once the server reports no camera', async () => {
  const {element, settings} = await harness(true, {CameraInput:fakeCamera('a cookie'), URL:blobUrls});
  await element('startButton').fire('click');
  assert.equal(element('cameraButton').hidden, false);
  settings.vision = false;
  await element('refreshConfig').fire('click');
  assert.equal(element('cameraButton').hidden, true);
});
