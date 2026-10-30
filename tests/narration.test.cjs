const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// narration.js in a sandbox: fetch answers that every line is ready, Audio records what plays, timers are manual.
function load() {
  const played = [];
  const timers = [];
  const posted = [];
  class Audio {
    constructor(src) { this.src = src; }
    play() { played.push(this.src); return Promise.resolve(); }   // "ends" only when the test calls finish()
    pause() {}
  }
  const sandbox = {
    URLSearchParams, JSON, Math, Promise, Blob,
    location: {search: ''},
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    navigator: {},
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      posted.push(body);
      return {ok: true, json: async () => ({clips: body.lines.map((l, i) => ({url: `/audio/default/${body.language}-${l.text.length}-${i}.mp3`, ready: true}))})};
    },
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Audio,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/narration.js'), 'utf8') + '\n;this.Narration = Narration;', sandbox);
  const runTimer = ms => { const t = timers.find(t => t.fn && t.ms === ms); assert.ok(t, `a ${ms} ms timer`); const fn = t.fn; t.fn = null; fn(); };
  return {Narration: sandbox.Narration, played, posted, runTimer, timers};
}
const tick = () => new Promise(r => setImmediate(r));

test('fillers keep coming every 8 s while the answer is being written, at most three', async () => {
  const {Narration, played, runTimer, timers} = load();
  Narration.interject('ko');
  await tick();
  assert.equal(played.length, 1);
  assert.match(played[0], /\/audio\/default\/ko-/);
  // The first one is still "talking": a second can't start on top of it.
  runTimer(8000); await tick();
  assert.equal(played.length, 1);
  assert.equal(timers.filter(t => t.fn && t.ms === 8000).length, 1, 'the third is still scheduled');
});

test('the story starting stops further fillers', async () => {
  const {Narration, played, posted, timers} = load();
  Narration.interject('en');
  await tick();
  assert.equal(played.length, 1);
  Narration.stop();                       // e.g. the microphone opened, or a new passage arrived and cut in
  assert.equal(timers.filter(t => t.fn && t.ms === 8000).length, 0);
  assert.equal(posted[0].language, 'en');
});

test('languages without a cloned voice get no filler', async () => {
  const {Narration, played, posted} = load();
  Narration.interject('fr');
  await tick();
  assert.equal(played.length, 0);
  assert.equal(posted.length, 0);
});
