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
async function harness(initialAvailable = true) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('mode').value = 'mock';
  const calls = [];
  const settings = {available:initialAvailable};
  const language = {language:'en', set(value) {this.language = value;},
    text(source, values={}) {return source.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);}};
  const document = {getElementById:element, querySelectorAll:() => [], createElement:() => new Element()};
  const context = vm.createContext({document, AgentLanguage:language,
    AbortController, crypto:require('node:crypto'), setTimeout:() => 1, clearTimeout() {},
    fetch:async (url, options={}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({url, body});
      const data = url === '/api/config' ? {liveAvailable:settings.available, model:'test-model'}
        : snapshot(body.mode, `session-${calls.length}`);
      return {ok:true, json:async () => data};
    }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/agent.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return {element, calls, settings};
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
