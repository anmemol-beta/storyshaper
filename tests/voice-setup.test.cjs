const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const flush = () => new Promise(setImmediate);

class Element {
  constructor() {
    this.hidden = false; this.disabled = false; this.checked = false;
    this.value = ''; this.textContent = ''; this.dataset = {}; this.style = {};
    this.children = []; this.classes = new Set();
    this.classList = {add: value => this.classes.add(value), remove: value => this.classes.delete(value),
      toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value), contains: value => this.classes.has(value)};
  }
  addEventListener(type, fn) { this[type] = fn; }
  setAttribute(key, value) { this[key] = value; }
  toggleAttribute() {}
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
}

async function harness() {
  const elements = new Map(), sections = new Map(), timers = new Map(), intervals = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const step of ['who', 'find', 'pick', 'listen', 'done']) {
    const section = new Element(); section.dataset.step = step; sections.set(step, section);
  }
  const relation = {value: 'me'};
  const settings = {available: true, uploadFails: false, wavFails: false, clipFails: false};
  const requests = [], recorders = [], tracks = [], storage = new Map();
  let timerId = 0, micCalls = 0;
  class MediaRecorder {
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({data: new Blob(['recorded audio'], {type: this.mimeType})});
      this.onstop();
    }
  }
  const context = vm.createContext({
    document: {documentElement: {}, getElementById: element, createElement: () => new Element(),
      querySelectorAll: selector => selector === 'main > section[data-step]' ? [...sections.values()] : [],
      querySelector: selector => selector.includes('input[name=relation]') ? relation
        : selector === '.ideas' ? element('ideas') : sections.get(selector.match(/data-step="(\w+)"/)?.[1]) || new Element()},
    location: {search: '?lang=ko'}, localStorage: {getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    navigator: {mediaDevices: {getUserMedia: async () => {
      micCalls++;
      return {getTracks: () => [{stop() { tracks.push('stopped'); }}]};
    }}},
    MediaRecorder, Blob, URLSearchParams, AbortController, AbortSignal, Float32Array, console,
    Audio: class {
      play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
      pause() {}
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, {fn, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; intervals.set(id, {fn, ms}); return id; },
    clearInterval: id => intervals.delete(id), cancelAnimationFrame() {},
    fetch: async (url, options = {}) => {
      requests.push({url, ...options});
      if (!settings.available) throw new TypeError('Failed to fetch');
      if (url.endsWith('/full.wav')) return {ok: !settings.wavFails, status: settings.wavFails ? 500 : 200,
        arrayBuffer: async () => new ArrayBuffer(8)};
      if (options.method === 'POST' && url.includes('recorded=1')) {
        if (settings.uploadFails) throw new TypeError('Failed to fetch');
        return {ok: true, json: async () => ({id: 'aaaaaaaaaaaa', suggestions: [{start: 0, end: 10, speech: .8}]})};
      }
      if (url.endsWith('/clip')) {
        if (settings.clipFails) throw new TypeError('Failed to fetch');
        return {ok: true, json: async () => ({quality: {duration: 10, speech: .8, snrDb: 30, ok: true}})};
      }
      if (url.endsWith('/preview')) return {ok: true, json: async () => ({url: '/audio/preview.mp3'})};
      if (url.endsWith('/save')) {
        settings.saved = {id: 'aaaaaaaaaaaa', name: '아빠'};
        return {ok: true, json: async () => settings.saved};
      }
      return {ok: true, json: async () => ({voices: settings.saved ? [settings.saved] : []})};
    },
  });
  context.window = {scrollTo() {}, AudioContext: class {
    async decodeAudioData() { return {duration: 30, getChannelData: () => new Float32Array(48000).fill(.1)}; }
    close() {}
  }};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/voice-setup.js'), 'utf8'), context);
  await flush();
  element('name').value = '아빠'; element('attest').checked = true;
  element('next').onclick();
  const record = async () => {
    const promise = element('record').onclick();
    for (let i = 0; i < 3; i++) {
      await flush();
      const entry = [...timers].find(([, timer]) => timer.ms === 1000);
      if (entry) { timers.delete(entry[0]); entry[1].fn(); }
    }
    await promise;
  };
  const finish = async () => {
    for (let i = 0; i < 30; i++) for (const timer of [...intervals.values()]) timer.fn();
    await flush(); await flush();
  };
  return {element, sections, settings, requests, tracks, timers, recorders, storage, record, finish, micCalls: () => micCalls};
}

test('missing voice service is reported before taking a 30-second recording', async () => {
  const h = await harness(); h.settings.available = false;
  await h.record();
  assert.equal(h.micCalls(), 0, 'Do not capture and discard a recording while its service is offline');
  assert.match(h.element('findError').textContent, /서버/);
  assert.equal(h.element('record').disabled, false);
});

test('automatic recording completion uploads audio and opens checked clip selection', async () => {
  const h = await harness(); await h.record(); await h.finish();
  assert.equal(h.sections.get('pick').hidden, false);
  assert.equal(h.element('next').disabled, false);
  assert.equal(h.tracks.length, 1);
  const upload = h.requests.find(request => request.url.includes('recorded=1'));
  assert.ok(upload.body.size > 0);
});

test('failed upload keeps the recording and retries without recording again', async () => {
  const h = await harness(); await h.record(); h.settings.uploadFails = true; await h.finish();
  assert.equal(h.element('retryUpload').hidden, false);
  assert.equal(typeof h.element('retryUpload').onclick, 'function');
  h.settings.uploadFails = false;
  await h.element('retryUpload').onclick(); await flush();
  assert.equal(h.sections.get('pick').hidden, false);
  const uploads = h.requests.filter(request => request.url.includes('recorded=1'));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].body, uploads[1].body, 'Retry must reuse the captured Blob');
  assert.equal(h.micCalls(), 1);
});

test('failed waveform download retries the existing uploaded draft', async () => {
  const h = await harness(); await h.record(); h.settings.wavFails = true; await h.finish();
  assert.equal(h.sections.get('find').hidden, false);
  assert.equal(h.element('retryUpload').hidden, false);
  h.settings.wavFails = false;
  await h.element('retryUpload').onclick(); await flush();
  assert.equal(h.sections.get('pick').hidden, false);
  assert.equal(h.requests.filter(request => request.url.includes('recorded=1')).length, 1);
});

test('completed recording proceeds through preview and saves the selected voice', async () => {
  const h = await harness(); await h.record(); await h.finish();
  h.element('next').onclick(); await flush();
  assert.equal(h.sections.get('listen').hidden, false);
  assert.equal(h.element('next').disabled, false, 'Finished preview must allow saving');
  await h.element('next').onclick(); await flush();
  assert.equal(h.sections.get('done').hidden, false);
  assert.equal(h.storage.get('story-voice'), 'aaaaaaaaaaaa');
  assert.deepEqual(JSON.parse(h.requests.find(request => request.url.endsWith('/save')).body),
    {name: '아빠', relation: 'me', attested: true});
});
