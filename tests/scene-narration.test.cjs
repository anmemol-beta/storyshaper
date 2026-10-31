const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
const LINES = [
  {speakerId: 'narrator', text: 'The first sentence is ready.'},
  {speakerId: 'pig1', text: 'The next sentence is still being made.'},
];

// Exercise the public narration path. The server can finish synthesis before
// its WAV has downloaded, and an Audio element can finish loading still later.
function sceneHarness({ready = false, autoDownload = true, autoCanPlay = true, status = 'pending', mutateResponse = null} = {}) {
  const played = [], spoken = [], audios = [], requests = [], timers = [], revoked = [];
  const storage = new Map();
  const downloads = [];
  let synthesized = ready;
  let sceneStatus = status;
  let blobNumber = 0;
  class Audio {
    constructor(src) {
      this.src = src;
      this.currentTime = 0;
      this.duration = 2;
      this.readyState = 0;
      this.paused = true;
      this.events = new Map();
      audios.push(this);
    }
    addEventListener(name, fn, options) {
      const entries = this.events.get(name) || [];
      entries.push({fn, once: options?.once});
      this.events.set(name, entries);
    }
    removeEventListener(name, fn) {
      this.events.set(name, (this.events.get(name) || []).filter(entry => entry.fn !== fn));
    }
    emit(name) {
      if (name === 'canplay' || name === 'canplaythrough' || name === 'loadeddata') this.readyState = 4;
      this[`on${name}`]?.();
      for (const entry of [...(this.events.get(name) || [])]) {
        if (entry.once) this.removeEventListener(name, entry.fn);
        entry.fn();
      }
    }
    load() {
      // The /first.mp3 rule keeps the original line-by-line implementation
      // red-capable: it starts the cached first line while the next is cold.
      if (this.src.includes('/first.mp3') || (this.src.startsWith('blob:') && autoCanPlay)) {
        queueMicrotask(() => this.emit('canplay'));
      }
    }
    play() { this.paused = false; played.push(this.src); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  class MockURL extends URL {
    static createObjectURL() { return `blob:scene-${++blobNumber}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const sandbox = {
    URL: MockURL, URLSearchParams, JSON, Math, Promise, Blob, AbortController, DOMException, queueMicrotask,
    location: {search: ''},
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    navigator: {sendBeacon() { return true; }},
    fetch: async (url, options = {}) => {
      requests.push({url: String(url), options});
      if (String(url).includes('/api/voice/scene')) {
        const lines = JSON.parse(options.body).lines;
        const response = {
          sceneKey: '0123456789abcdef', status: synthesized ? 'ready' : sceneStatus,
          ready: synthesized ? lines.length : 1, total: lines.length,
          url: synthesized ? '/audio/default/scene-0123456789abcdef.wav' : null,
          segments: synthesized ? lines.map((line, index) => (
            {lineIndex: index, speakerId: line.speakerId, start: index, end: index + 1, text: line.text})) : [],
          duration: synthesized ? lines.length : 0,
        };
        mutateResponse?.(response);
        return {ok: true, json: async () => response};
      }
      if (String(url).includes('/api/voice/lines')) {
        return {ok: true, json: async () => ({clips: [
          {url: '/audio/default/first.mp3', ready: true},
          {url: '/audio/default/second.mp3', ready: false},
        ]})};
      }
      const bytes = new Uint8Array([82, 73, 70, 70]);
      const download = () => {
        if (autoDownload) return Promise.resolve(new Blob([bytes], {type: 'audio/wav'}));
        return new Promise((resolve, reject) => {
          const done = () => resolve(new Blob([bytes], {type: 'audio/wav'}));
          downloads.push(done);
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        });
      };
      return {ok: true, headers: {get: () => '4'}, blob: download,
        arrayBuffer: async () => (await download()).arrayBuffer()};
    },
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Audio,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {cancel() {}, resume() {}, speak(utterance) { spoken.push(utterance.text); }},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/narration.js'), 'utf8')
    + '\nthis.Narration = Narration;', sandbox);
  return {
    Narration: sandbox.Narration, played, spoken, audios, requests, timers, revoked,
    makeReady() { synthesized = true; },
    fail() { synthesized = false; sceneStatus = 'failed'; },
    finishDownload() { for (const resolve of downloads.splice(0)) resolve(); },
    runTimer(ms) {
      const timer = timers.find(timer => timer.fn && timer.ms === ms);
      assert.ok(timer, `expected a ${ms} ms timer`);
      const fn = timer.fn; timer.fn = null; fn();
    },
  };
}

test('a scene does not begin while a later sentence still needs synthesis', async () => {
  const h = sceneHarness();
  const reading = h.Narration.speak(LINES, {scene: true, key: 'scene-with-cold-tail', language: 'en'});
  try {
    await tick();
    assert.deepEqual(h.played, [], 'all scene sentences must be ready before any story audio starts');
    assert.deepEqual(h.spoken, [], 'partial parent audio must not turn into per-line browser fallback');
  } finally {
    h.Narration.stop();
    await reading.catch(() => {});
  }
});

test('scene preparation waits for all synthesis, the full WAV download and canplay', async () => {
  const h = sceneHarness({autoDownload: false, autoCanPlay: false});
  let settled = false;
  const preparation = h.Narration.prepareScene(LINES, {language: 'en'}).then(asset => {
    settled = true; return asset;
  });
  await tick();
  assert.equal(settled, false);
  assert.equal(h.audios.length, 0);
  assert.deepEqual(h.played, []);
  h.makeReady();
  h.runTimer(400);
  await tick();
  assert.equal(settled, false, 'server ready is not the same as a downloaded audio file');
  assert.equal(h.audios.length, 0);
  h.finishDownload();
  await tick();
  assert.equal(settled, false, 'the complete file must still become playable');
  assert.equal(h.audios.length, 1);
  h.audios[0].emit('canplay');
  const asset = await preparation;
  assert.ok(asset);
  assert.deepEqual(h.played, [], 'preparing a scene never plays its story');
  h.Narration.stop();
});

test('a prepared scene uses one continuous audio file with no requests between speakers', async () => {
  const h = sceneHarness({ready: true});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  const before = h.requests.length;
  const highlights = [];
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'continuous', language: 'en',
    onLine: index => highlights.push(index)});
  await tick();
  assert.equal(h.audios.length, 1);
  assert.equal(h.played.length, 1);
  assert.match(h.played[0], /^blob:/);
  assert.deepEqual(highlights, [0]);
  const audio = h.audios[0];
  audio.currentTime = 1.2;
  audio.emit('timeupdate');
  assert.deepEqual(highlights, [0, 1]);
  assert.equal(h.requests.length, before, 'nothing is synthesized or downloaded mid-scene');
  assert.deepEqual(h.spoken, []);
  audio.emit('ended');
  await reading;
  assert.deepEqual(highlights, [0, 1, -1]);
});

test('split sentences and the final question keep their original line highlights and delivery', async () => {
  const h = sceneHarness({ready: true});
  const character = {speakerId: 'wolf', kind: 'dialogue', tone: 'playful', emotion: 'confident',
    text: 'I will puff at this little house until the walls wobble! Here comes my biggest puff!'};
  const question = {speakerId: 'narrator', kind: 'narration', tone: 'curious', emotion: 'curious',
    text: 'What do you think will happen?'};
  const lines = [character, question];
  const prepared = await h.Narration.prepareScene(lines, {language: 'en'});
  const posted = JSON.parse(h.requests[0].options.body).lines;
  assert.deepEqual(posted, [
    {...character, text: 'I will puff at this little house until the walls wobble!'},
    {...character, text: 'Here comes my biggest puff!'},
    question,
  ]);
  const highlights = [];
  const reading = h.Narration.speak(lines, {scene: true, prepared, key: 'split-scene', language: 'en',
    onLine: index => highlights.push(index)});
  await tick();
  h.audios[0].currentTime = 1.2;
  h.audios[0].emit('timeupdate');
  assert.deepEqual(highlights, [0], 'the second sentence still belongs to the same character line');
  h.audios[0].currentTime = 2.2;
  h.audios[0].emit('timeupdate');
  assert.deepEqual(highlights, [0, 1], 'the final spoken question belongs to the question line');
  h.audios[0].emit('ended');
  await reading;
  assert.deepEqual(highlights, [0, 1, -1]);
});

test('pause, resume and stopping keep the prepared scene position and cancel its highlights', async () => {
  const h = sceneHarness({ready: true});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  const highlights = [];
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'controls', language: 'en',
    onLine: index => highlights.push(index)});
  await tick();
  const audio = h.audios[0];
  audio.currentTime = .4;
  h.Narration.pause();
  assert.equal(h.Narration.playbackState(), 'paused');
  h.Narration.resume();
  assert.equal(audio.currentTime, .4);
  assert.equal(h.audios.length, 1);
  assert.equal(h.Narration.playbackState(), 'playing');
  h.Narration.stop();
  await reading;
  const stopped = [...highlights];
  audio.currentTime = 1.2;
  audio.emit('timeupdate');
  audio.emit('ended');
  assert.deepEqual(highlights, stopped, 'late events from the old scene cannot highlight the next scene');
  assert.equal(h.Narration.playbackState(), 'idle');
});

test('replaying a prepared scene restarts from zero without preparing or downloading it again', async () => {
  const h = sceneHarness({ready: true});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  const before = h.requests.length;
  const first = h.Narration.speak(LINES, {scene: true, prepared, key: 'replay-1', language: 'en'});
  await tick();
  h.audios.at(-1).currentTime = 2;
  h.audios.at(-1).emit('ended');
  await first;
  const second = h.Narration.speak(LINES, {scene: true, prepared, key: 'replay-2', language: 'en'});
  await tick();
  assert.equal(h.audios.at(-1).currentTime, 0);
  assert.equal(h.played.length, 2);
  assert.equal(h.played[0], h.played[1]);
  assert.equal(h.requests.length, before);
  h.audios.at(-1).emit('ended');
  await second;
});

test('aborting scene preparation cancels a cold tail without partial audio or browser fallback', async () => {
  const h = sceneHarness();
  const controller = new AbortController();
  const preparation = h.Narration.prepareScene(LINES, {language: 'en', signal: controller.signal});
  await tick();
  controller.abort();
  await assert.rejects(preparation);
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.spoken, []);
});

test('a failed scene is not replaced with partial parent audio or per-line browser narration', async () => {
  const h = sceneHarness({status: 'failed'});
  await assert.rejects(h.Narration.prepareScene(LINES, {language: 'en'}));
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.spoken, []);
});

test('changing the voice cannot play a prepared scene in the previous voice', async () => {
  const h = sceneHarness({ready: true});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  h.Narration.selectVoice('another-voice', 'Another voice');
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'stale-voice', language: 'en'});
  await assert.rejects(reading);
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.spoken, []);
});

test('a playback error removes the broken prepared scene from the replay cache', async () => {
  const h = sceneHarness({ready: true});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  const reading = h.Narration.speak(LINES, {scene: true, prepared, key: 'broken-playback', language: 'en'});
  await tick();
  h.audios[0].emit('error');
  await assert.rejects(reading, /playback/);
  assert.equal(h.Narration.getPreparedScene(LINES, {language: 'en'}), null,
    'a failed MediaElement must not be offered again as ready scene audio');
});

test('explicit scene retry downloads and preloads a fresh asset instead of returning the old cache entry', async () => {
  const h = sceneHarness({ready: true});
  const first = await h.Narration.prepareScene(LINES, {language: 'en'});
  const before = h.requests.length;
  const retried = await h.Narration.prepareScene(LINES, {language: 'en', retry: true});
  assert.notEqual(retried, first);
  assert.notEqual(retried.url, first.url);
  assert.equal(h.audios.length, 2);
  assert.equal(h.requests.length, before + 2, 'retry asks for the scene manifest and its complete file again');
  assert.equal(h.requests.at(-1).options.cache, 'reload', 'retry also bypasses an old HTTP audio response');
  assert.ok(h.revoked.includes(first.url));
  assert.deepEqual(h.played, []);
});

test('an evicted scene asset cannot be replayed after its blob URL was revoked', async () => {
  const h = sceneHarness({ready: true});
  const first = await h.Narration.prepareScene(LINES, {language: 'en'});
  for (let i = 0; i < 6; i++) {
    await h.Narration.prepareScene([{speakerId: 'narrator', text: `Another complete scene ${i}.`}], {language: 'en'});
  }
  assert.equal(h.Narration.getPreparedScene(LINES, {language: 'en'}), null);
  assert.ok(h.revoked.includes(first.url));
  let failure = null;
  const reading = h.Narration.speak(LINES, {scene: true, prepared: first, key: 'evicted', language: 'en'})
    .catch(error => { failure = error; });
  try {
    await tick();
    assert.deepEqual(h.played, [], 'a retained caller reference must not bypass scene cache eviction');
    assert.ok(failure, 'a stale prepared scene is rejected so the caller can prepare it again');
  } finally {
    h.Narration.stop();
    await reading;
  }
});

test('reselecting the same voice invalidates retained assets whose blob URLs were revoked', async () => {
  const h = sceneHarness({ready: true});
  const prepared = await h.Narration.prepareScene(LINES, {language: 'en'});
  h.Narration.selectVoice(null);
  assert.equal(h.Narration.getPreparedScene(LINES, {language: 'en'}), null);
  assert.ok(h.revoked.includes(prepared.url));
  await assert.rejects(h.Narration.speak(LINES, {scene: true, prepared, key: 'same-voice', language: 'en'}), /expired/);
  assert.deepEqual(h.played, []);
});

const mismatchedScenes = {
  'another voice folder': response => { response.url = '/audio/aaaaaaaaaaaa/scene-0123456789abcdef.wav'; },
  'another scene key': response => { response.sceneKey = 'fedcba9876543210'; },
  'a partially ready scene': response => { response.ready = 1; },
  'an inconsistent line total': response => { response.ready = response.total = 3; },
  'a different spoken sentence': response => { response.segments[0].text = 'Not the current story.'; },
  'a different speaker': response => { response.segments[0].speakerId = 'wolf'; },
  'a gap between line cues': response => { response.segments[1].start = 1.1; },
  'a duration beyond the last cue': response => { response.duration = 2.1; },
};
for (const [description, mutateResponse] of Object.entries(mismatchedScenes)) {
  test(`a ready response with ${description} cannot load audio for the current scene`, async () => {
    const h = sceneHarness({ready: true, mutateResponse});
    await assert.rejects(h.Narration.prepareScene(LINES, {language: 'en'}), /invalid_scene/);
    assert.equal(h.requests.length, 1, 'reject the manifest before downloading mismatched audio');
    assert.equal(h.audios.length, 0);
    assert.deepEqual(h.played, []);
    assert.deepEqual(h.spoken, []);
  });
}
