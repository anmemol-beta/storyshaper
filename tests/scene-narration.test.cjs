const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const LINES = [
  {speakerId: 'narrator', text: 'The first sentence is ready.'},
  {speakerId: 'pig1', text: 'The next sentence is still being made.'},
];

// The server voices scene sentences in order; a sentence that is not voiced yet answers 504 after its wait.
// voice(k) makes sentence k answer with audio. Blob URLs play at once; play() "ends" when the test calls end().
function sceneHarness({voiced = [0], pack = null, missingFiles = []} = {}) {
  const played = [], spoken = [], audios = [], requests = [], timers = [], revoked = [];
  const ready = new Set(voiced), waiting = new Map();
  const storage = new Map();
  let blobNumber = 0;
  class Audio {
    constructor(src) { this.src = src; this.events = new Map(); audios.push(this); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    emit(name) { this[`on${name}`]?.(); this.events.get(name)?.(); }
    load() { queueMicrotask(() => this.emit('canplay')); }
    play() { played.push(this.src); queueMicrotask(() => this.emit('playing')); return Promise.resolve(); }
    pause() {}
    end() { this.emit('ended'); }
  }
  class MockURL extends URL {
    static createObjectURL(blob) { return `blob:${blob.line}-${++blobNumber}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const answer = k => ({ok: true, status: 200, blob: async () => Object.assign(new Blob(['ID3']), {line: k})});
  const sandbox = {
    URL: MockURL, URLSearchParams, JSON, Math, Promise, Blob, AbortController, queueMicrotask,
    location: {search: ''},
    localStorage: {getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k)},
    navigator: {sendBeacon() { return true; }},
    fetch: async (url, options = {}) => {
      requests.push(String(url));
      if (String(url) === 'audio/pack/manifest.json') {
        return pack ? {ok: true, json: async () => ({voices: pack})} : {ok: false, status: 404};
      }
      if (String(url).endsWith('/preview')) return {ok: true, json: async () => ({url: '/audio/abcdef123456/sample.mp3'})};
      if (String(url).startsWith('audio/pack/')) {
        if (missingFiles.includes(String(url))) return {ok: false, status: 404};
        return {ok: true, status: 200, blob: async () => Object.assign(new Blob(['ID3']), {line: 'app'})};
      }
      if (String(url).includes('/api/voice/lines')) {
        const lines = JSON.parse(options.body).lines;
        return {ok: true, json: async () => ({clips: lines.map((line, k) => ({url: `/audio/default/line${k}.mp3`, ready: ready.has(k)}))})};
      }
      const k = Number(/line(\d+)\.mp3/.exec(url)[1]);
      if (ready.has(k)) return answer(k);
      return new Promise((resolve, reject) => {          // the server holds the ask while it voices the line
        waiting.set(k, resolve);
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    },
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Audio,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {cancel() {}, resume() {}, speak(utterance) { spoken.push(utterance.text); }},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/narration.js'), 'utf8') + '\nthis.Narration = Narration;', sandbox);
  return {
    Narration: sandbox.Narration, played, spoken, audios, requests, revoked, storage,
    voice(k) { ready.add(k); waiting.get(k)?.(answer(k)); waiting.delete(k); },
    stillVoicing(k) { const resolve = waiting.get(k); waiting.delete(k); resolve?.({ok: false, status: 504}); },
    playing: () => audios.at(-1),
  };
}

test('a scene opens as soon as its first sentence is voiced, while the next is still being made', async () => {
  const h = sceneHarness();
  let prepared = null;
  h.Narration.prepareScene(LINES, {language: 'en'}).then(asset => { prepared = asset; });
  await tick();
  assert.ok(prepared, 'the page must not wait for the second sentence');
  assert.ok(h.requests.some(url => url.endsWith('/audio/default/line1.mp3?wait=30')), 'the second sentence is already being fetched');
});

test('sentences play in order; a sentence still being voiced is waited for in the same voice', async () => {
  const h = sceneHarness();
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  const lines = [], sentences = [];
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'in-order', language: 'en',
    onLine: index => lines.push(index), onSentence: (index, text) => sentences.push([index, text])});
  await tick();
  assert.deepEqual(h.played, ['blob:0-1']);
  assert.deepEqual(lines, [0]);
  h.playing().end(); await tick();
  assert.equal(h.played.length, 1, 'nothing plays while the second sentence is being voiced');
  h.voice(1); await tick();
  assert.deepEqual(h.played, ['blob:0-1', 'blob:1-2']);
  assert.deepEqual(sentences, [[0, LINES[0].text], [1, LINES[1].text]]);
  h.playing().end(); await reading;
  assert.deepEqual(lines, [0, 1, -1]);
  assert.deepEqual(h.spoken, [], 'never the browser voice');
});

test('a sentence the server is still voicing is asked for again rather than given up', async () => {
  const h = sceneHarness();
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  h.stillVoicing(1); await tick();
  assert.equal(h.requests.filter(url => url.endsWith('line1.mp3?wait=30')).length, 2);
  h.voice(1); await tick();
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'asked-again', language: 'en'});
  await tick(); h.playing().end(); await tick(); h.playing().end();
  await reading;
  assert.equal(h.played.length, 2);
});

test('a sentence that is never voiced stops the scene and drops it from the replay cache', async () => {
  const h = sceneHarness();
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  for (let i = 0; i < 6; i++) { h.stillVoicing(1); await tick(); }
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'never', language: 'en'});
  await tick(); h.playing().end();
  await assert.rejects(reading);
  assert.equal(h.Narration.getPreparedScene(LINES, {language: 'en'}), null);
  assert.deepEqual(h.spoken, []);
});

test('aborting before the first sentence is voiced rejects and keeps nothing', async () => {
  const h = sceneHarness({voiced: []});
  const controller = new AbortController();
  const preparation = h.Narration.prepareScene(LINES, {language: 'en', signal: controller.signal});
  await tick();
  controller.abort();
  await assert.rejects(preparation);
  assert.equal(h.Narration.getPreparedScene(LINES, {language: 'en'}), null);
});

test('replaying a prepared scene plays the downloaded sentences again without asking the server', async () => {
  const h = sceneHarness({voiced: [0, 1]});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  await tick();
  const asked = h.requests.length;
  for (const key of ['replay-1', 'replay-2']) {
    const reading = h.Narration.speak(LINES, {scene: true, prepared, key, language: 'en'});
    await tick(); h.playing().end(); await tick(); h.playing().end();
    await reading;
  }
  assert.equal(h.requests.length, asked);
  assert.deepEqual(h.played, ['blob:0-1', 'blob:1-2', 'blob:0-1', 'blob:1-2']);
});

test('changing the voice discards prepared scenes and cannot play them in the previous voice', async () => {
  const h = sceneHarness({voiced: [0, 1]});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  await tick();
  h.Narration.selectVoice('abcdef123456', 'Mom');
  assert.deepEqual([...h.revoked].sort(), ['blob:0-1', 'blob:1-2']);
  await assert.rejects(h.Narration.speak(LINES, {scene: true, prepared, key: 'old-voice', language: 'en'}));
  assert.equal(h.played.length, 0);
});

test('only a few scenes are kept for going back', async () => {
  const h = sceneHarness({voiced: [0]});
  const first = await h.Narration.prepareScene([{speakerId: 'narrator', text: 'Scene 0.'}], {language: 'en'});
  for (let i = 1; i <= 6; i++) await h.Narration.prepareScene([{speakerId: 'narrator', text: `Scene ${i}.`}], {language: 'en'});
  assert.equal(h.Narration.getPreparedScene([{speakerId: 'narrator', text: 'Scene 0.'}], {language: 'en'}), null);
  assert.equal(first.invalid, true);
});

test('fixed lines in the storybook voice play from the app without asking the server', async () => {
  const pack = {default: {'en|narrator||||The first sentence is ready.': 'a.mp3', 'en|pig1||||The next sentence is still being made.': 'b.mp3'}};
  const h = sceneHarness({voiced: [], pack});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  await tick();
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'packed', language: 'en'});
  await tick(); h.playing().end(); await tick(); h.playing().end();
  await reading;
  assert.deepEqual(h.played, ['blob:app-1', 'blob:app-2']);
  assert.deepEqual(h.requests, ['audio/pack/manifest.json', 'audio/pack/a.mp3', 'audio/pack/b.mp3']);
});

test('only the lines the app does not have are sent to the server, and a missing app file is voiced there', async () => {
  const pack = {default: {'en|narrator||||The first sentence is ready.': 'a.mp3'}};
  const h = sceneHarness({voiced: [0], pack, missingFiles: ['audio/pack/a.mp3']});
  await h.Narration.prepareScene(LINES, {language: 'en'});
  const queued = h.requests.filter(url => url.endsWith('/api/voice/lines'));
  assert.equal(queued.length, 2, 'the missing sentence first, then the app file that was not found');
  assert.ok(h.requests.some(url => url.endsWith('/audio/default/line0.mp3?wait=30')));
});

test("a parent's voice never plays the storybook voice's app files", async () => {
  const pack = {default: {'en|narrator||||The first sentence is ready.': 'a.mp3'}};
  const h = sceneHarness({voiced: [0, 1], pack});
  h.storage.set('story-voice', 'abcdef123456');
  await h.Narration.prepareScene(LINES, {language: 'en'});
  assert.ok(!h.requests.some(url => url.startsWith('audio/pack/') && url.endsWith('.mp3')));
});

test("the built-in male narrator reads from its own app files and shares the characters' files", async () => {
  const pack = {default: {'en|narrator||||The first sentence is ready.': 'a.mp3', 'en|pig1||||The next sentence is still being made.': 'b.mp3'},
    '000000007127': {'en|narrator||||The first sentence is ready.': 'm.mp3'}};
  const h = sceneHarness({voiced: [], pack});
  h.storage.set('story-voice', '000000007127');
  await h.Narration.prepareScene(LINES, {language: 'en'});
  await tick();
  assert.deepEqual(h.requests, ['audio/pack/manifest.json', 'audio/pack/m.mp3', 'audio/pack/b.mp3']);
});

test("a voice's sample is the story's first line: the app's file for a storybook voice, the server for a parent", async () => {
  const pack = {default: {'ko|narrator|narration|warm|calm|옛날 옛적에 아기돼지 삼형제가 집을 지으러 나섰어요.': 'first.mp3'}};
  const h = sceneHarness({pack});
  assert.equal(await h.Narration.sample(null, 'ko'), 'audio/pack/first.mp3');
  assert.ok(!h.requests.some(url => url.includes('/preview')));
  assert.match(await h.Narration.sample('abcdef123456', 'ko'), /\/audio\/abcdef123456\/sample\.mp3\?wait=30$/);
  assert.ok(h.requests.some(url => url.endsWith('/api/voices/abcdef123456/preview')));
});
