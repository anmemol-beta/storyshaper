const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// narration.js in a sandbox: fetch answers that every line is ready, Audio records what plays, timers are manual.
function load({ready = true, autoEnd = true, hang = false, stallAudio = false, autoPlay = true, refusePlay = false} = {}) {
  const played = [];
  const timers = [];
  const posted = [];
  const clips = [], spoken = [], pauses = [], storage = new Map(), beacons = [];
  class Audio {
    constructor(src) { this.src = src; clips.push(this); this.events = {}; }
    play() { played.push(this.src); if (refusePlay) return Promise.reject(new Error('NotAllowedError'));
      queueMicrotask(() => this.events.playing?.()); return Promise.resolve(); }   // "ends" only when the test calls finish()
    pause() { pauses.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    load() { if (ready && !stallAudio && autoPlay) queueMicrotask(() => this.events.canplay?.()); }
  }
  const sandbox = {
    URLSearchParams, JSON, Math, Promise, Blob, AbortController, queueMicrotask,
    location: {search: ''},
    localStorage: {getItem: key => storage.get(key) || null, setItem:(key,value) => storage.set(key,value), removeItem:key => storage.delete(key)},
    navigator: {sendBeacon(url, body) { beacons.push({url, body}); return true; }},
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      posted.push(body);
      if (hang) return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      return {ok: true, json: async () => ({clips: body.lines.map((l, i) => ({url: `/audio/default/${body.language}-${l.text.length}-${i}.mp3`, ready}))})};
    },
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Audio,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {paused:false, current:null,
      speak(utterance) { this.current = utterance; spoken.push(utterance);
        queueMicrotask(() => { if (this.current === utterance) { utterance.onstart?.(); if (autoEnd && !this.paused) utterance.onend?.(); } }); },
      cancel() { this.current = null; }, pause() {this.paused = true; pauses.push('browser');},
      resume() {this.paused = false; pauses.push('resume'); if (autoEnd && this.current) {const utterance = this.current; queueMicrotask(() => {if (this.current === utterance) utterance.onend?.();});}}},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/narration.js'), 'utf8') + '\n;this.Narration = Narration;', sandbox);
  const runTimer = ms => { const t = timers.find(t => t.fn && t.ms === ms); assert.ok(t, `a ${ms} ms timer`); const fn = t.fn; t.fn = null; fn(); };
  return {Narration: sandbox.Narration, played, posted, runTimer, timers, clips, spoken, pauses, storage, beacons,
    setFetch: fn => { sandbox.fetch = fn; }, nativeSpeech: sandbox.speechSynthesis};
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

test('long lines are voiced sentence by sentence; short ones and tiny pieces stay together', () => {
  const {Narration} = load();
  const s = text => Array.from(Narration.sentences(text));
  assert.deepEqual(s('The wolf blew.'), ['The wolf blew.']);
  assert.deepEqual(s('The wolf puffs, and the light paper walls blow away. The pigs step safely away.'),
    ['The wolf puffs, and the light paper walls blow away.', 'The pigs step safely away.']);
  assert.deepEqual(s('늑대가 후 불자 종이 벽이 팔랑팔랑 흔들렸어요. 가벼운 종이 벽은 바람에 날아갔어요. 돼지들은 안전하게 피했어요.'),
    ['늑대가 후 불자 종이 벽이 팔랑팔랑 흔들렸어요.', '가벼운 종이 벽은 바람에 날아갔어요.', '돼지들은 안전하게 피했어요.']);
  assert.deepEqual(s('Oh! The little pig looked up at the sky and saw a big gray cloud.'),
    ['Oh! The little pig looked up at the sky and saw a big gray cloud.']);
  assert.deepEqual(s('But the wolf came back. "Whoo… whoo… CRASH!" The wood house tumbled down.'),
    ['But the wolf came back. "Whoo… whoo… CRASH!"', 'The wood house tumbled down.']);   // the sound effect stays with the sentence before it
});

test('split dialogue keeps its speaker and delivery metadata without voicing the directions', async () => {
  const h = load();
  const line = {speakerId:'wolf', kind:'dialogue', tone:'playful', emotion:'confident',
    text:'I will puff at this little house until the walls wobble! Here comes my biggest puff!'};
  const highlights = [];
  const reading = h.Narration.speak([line], {key:'dialogue', onLine:i => highlights.push(i)});
  await tick();
  const texts = Array.from(h.Narration.sentences(line.text));
  assert.equal(texts.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.posted[0].lines)), texts.map(text => ({...line, text})));
  assert.equal(h.posted[0].lines.some(part => 'line' in part), false, 'Playback indexes are not model inputs');
  for (let i = 0; i < texts.length; i++) { h.clips.at(-1).onended(); await tick(); }
  await reading;
  assert.deepEqual(highlights, [0, -1], 'Sentence splitting keeps one highlighted dialogue line');
  assert.equal(h.spoken.length, 0);
});

test('preparation, prefetch, readiness and voice-ahead preserve dialogue metadata', async () => {
  const h = load();
  const line = {speakerId:'pig2', kind:'dialogue', tone:'eager', emotion:'hopeful', text:'Let us build together!'};
  await h.Narration.prepare([line], {language:'ko'});
  await h.Narration.prefetch([line], {language:'ko'});
  await h.Narration.readyCount([line], {language:'ko'});
  for (const request of h.posted) {
    assert.deepEqual(JSON.parse(JSON.stringify(request.lines)), [line]);
    assert.equal(request.language, 'ko');
  }
  assert.equal(h.Narration.voiceAhead([line], {language:'ko'}), true);
  const ahead = JSON.parse(await h.beacons[0].body.text());
  assert.deepEqual(ahead.lines, [line]);
  assert.equal(ahead.language, 'ko');
  assert.equal(h.played.length, 0, 'Warming a voice does not read the passage');
});

test('unready parent clips are waited for; only a line still not voiced after 30 s is read by the browser', async () => {
  const h = load({ready:false});
  const reading = h.Narration.speak([{text:'Read this now.'}, {text:'Keep the story moving.'}], {key:'cold', language:'ko'});
  await tick();
  assert.match(h.clips.at(-1).src, /\?wait=30$/, 'every unready line waits for the parent voice');
  assert.equal(h.spoken.length, 0, 'a slow line is not read by the machine voice');
  h.runTimer(30800); await tick();
  assert.equal(h.spoken.length, 1);
  assert.match(h.clips.at(-1).src, /\?wait=30$/);
  h.runTimer(30800); await tick();
  assert.equal(h.spoken.length, 2);
  await reading;
  assert.equal(h.played.length, 0);
});

test('a parent clip voiced during its wait is read in the parent voice, and stops the filler then', async () => {
  const h = load({autoPlay:false});
  h.Narration.interject('en'); await tick();
  const filler = h.clips.at(-1);
  h.setFetch(async (url, options) => ({ok: true, json: async () => ({clips: JSON.parse(options.body).lines.map((l, i) => ({url: `/audio/default/late-${i}.mp3`, ready: false}))})}));
  const reading = h.Narration.speak([{text:'Ready a moment later.'}], {key:'late'});
  await tick();
  const line = h.clips.at(-1);
  assert.match(line.src, /\?wait=30$/);
  assert.ok(!h.pauses.includes(filler), 'the filler keeps talking while the first line is voiced');
  line.events.canplay(); await tick();               // the server finished the line within the wait
  assert.ok(h.pauses.includes(filler));
  assert.equal(h.played.at(-1), line.src);
  assert.equal(h.spoken.length, 0);
  line.onended(); await reading;
});

test('ready parent clips still use the selected parent voice', async () => {
  const h = load();
  const reading = h.Narration.speak([{text:'Ready parent audio.'}], {key:'warm'});
  await tick();
  assert.equal(h.played.length, 1);
  assert.equal(h.spoken.length, 0);
  h.clips.at(-1).onended(); await reading;
});

test('onSpeak reports a line when its voice is heard, once per line, not when it is queued', async () => {
  const h = load({autoPlay:false});
  const lines = [], heard = [], sentences = [];
  const reading = h.Narration.speak([{text:'The wolf took a very deep breath. Then he puffed at the walls.'}, {text:'Whoosh!'}],
    {key:'cue', onLine: i => lines.push(i), onSpeak: i => heard.push(i),
      onSentence: (i, text) => sentences.push([i, text])});
  await tick();
  assert.deepEqual(lines, [0]);
  assert.deepEqual(heard, [], 'nothing is heard while the clip is still being voiced');
  h.clips.at(-1).events.canplay(); await tick();
  assert.deepEqual(heard, [0]);
  assert.deepEqual(sentences, [[0, 'The wolf took a very deep breath.']]);
  h.clips.at(-1).onended(); await tick();
  h.clips.at(-1).events.canplay(); await tick();     // the second sentence of the same line
  assert.deepEqual(heard, [0]);
  assert.deepEqual(sentences[1], [0, 'Then he puffed at the walls.']);
  h.clips.at(-1).onended(); await tick();
  h.clips.at(-1).events.canplay(); await tick();
  assert.deepEqual(heard, [0, 1]);
  h.clips.at(-1).onended(); await reading;
});

test('a clip the browser refuses to play is not reported as heard; the browser voice that reads it is', async () => {
  const h = load({refusePlay:true, autoEnd:false});
  const heard = [];
  const reading = h.Narration.speak([{text:'Autoplay is blocked here.'}], {key:'cue-refused', onSpeak: i => heard.push(i)});
  await tick();
  assert.equal(h.played.length, 1, 'the parent clip was tried');
  assert.equal(h.spoken.length, 1, 'the browser voice took over');
  assert.deepEqual(heard, [0], 'reported once, when the browser voice started');
  h.nativeSpeech.current.onend(); await reading;
});

test('onSpeak fires once when the browser voice reads a line whose clip failed', async () => {
  const h = load({stallAudio:true});
  const heard = [];
  const reading = h.Narration.speak([{text:'The file is missing.'}], {key:'cue-broken', onSpeak: i => heard.push(i)});
  await tick();
  assert.deepEqual(heard, []);
  h.runTimer(800); await tick();
  assert.deepEqual(heard, [0]);
  assert.equal(h.spoken.length, 1);
  await reading;
});

test('a stalled voice service gets a bounded fallback instead of a silent pending fetch', async () => {
  const h = load({hang:true});
  const reading = h.Narration.speak([{text:'Start reading.'}], {key:'slow'});
  await tick();
  h.runTimer(4000); await tick();
  assert.equal(h.spoken.length, 1);
  await reading;
});

test('a ready clip that fails to load cannot stall the narration indefinitely', async () => {
  const h = load({stallAudio:true});
  const reading = h.Narration.speak([{text:'The file is missing.'}], {key:'broken'});
  await tick(); h.runTimer(800); await tick();
  assert.equal(h.spoken.length, 1);
  await reading;
});

test('pause and resume keep the same parent clip and playback position', async () => {
  const h = load();
  const reading = h.Narration.speak([{text:'A ready parent clip.'}], {key:'pause'});
  await tick();
  const clip = h.clips.at(-1); clip.currentTime = 1.25;
  h.Narration.pause();
  assert.equal(h.Narration.playbackState(), 'paused');
  h.Narration.resume();
  assert.equal(h.Narration.playbackState(), 'playing');
  assert.equal(h.clips.length, 1);
  assert.equal(clip.currentTime, 1.25);
  assert.equal(h.posted.length, 1);
  clip.onended(); await reading;
  assert.equal(h.Narration.playbackState(), 'idle');
});

test('pausing while preparing a passage prevents delayed autoplay', async () => {
  const h = load();
  const reading = h.Narration.speak([{text:'Wait for play.'}], {key:'pending-pause'});
  h.Narration.pause(); await tick();
  assert.equal(h.Narration.playbackState(), 'paused');
  assert.equal(h.played.length, 0);
  h.Narration.resume(); await tick();
  assert.equal(h.played.length, 1);
  h.clips.at(-1).onended(); await reading;
});

test('browser speech resumes its current sentence and pause suspends its end guard', async () => {
  const h = load({ready:false, autoEnd:false});
  const reading = h.Narration.speak([{text:'Keep this sentence.'}], {key:'browser-pause'});
  await tick(); h.runTimer(30800); await tick();
  assert.equal(h.Narration.voiceSource(), 'browser');
  h.Narration.pause();
  assert.equal(h.timers.filter(t => t.fn && t.ms === 30000).length, 0);
  h.Narration.resume();
  assert.equal(h.spoken.length, 1);
  h.spoken[0].onend(); await reading;
});

test('stopping paused or preparing audio cancels the old passage', async () => {
  const h = load();
  const reading = h.Narration.speak([{text:'Old passage.'}], {key:'old'});
  h.Narration.pause(); await tick(); h.Narration.stop(); await reading;
  assert.equal(h.played.length, 0);
  assert.equal(h.Narration.playbackState(), 'idle');
});

test('warmup is background work and uses the requested language only', async () => {
  const h = load(); h.Narration.warm('ko'); await tick();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].language, 'ko');
  assert.equal(h.posted[0].priority, 'background');
});

test('voice selection stores the profile and clears a paused old reader', async () => {
  const h = load();
  const reading = h.Narration.speak([{text:'An old reader.'}], {key:'old-reader'});
  await tick(); h.Narration.pause(); h.Narration.selectVoice('saved-id', 'Mom'); await reading;
  assert.equal(h.Narration.voiceId(), 'saved-id');
  assert.equal(h.Narration.voiceName(), 'Mom');
  assert.equal(h.Narration.playbackState(), 'idle');
  h.Narration.selectVoice(null);
  assert.equal(h.Narration.voiceId(), null);
});

test('saved voices can be fetched without changing pages', async () => {
  const h = load();
  h.setFetch(async url => {
    assert.match(url, /\/api\/voices$/);
    return {ok:true, json:async () => ({voices:[{id:'saved-id', name:'Mom'}]})};
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.Narration.listVoices())), [{id:'saved-id',name:'Mom'}]);
});

test('changing a paused browser reader cannot leave the next passage globally paused', async () => {
  const h = load({ready:false, autoEnd:false});
  const first = h.Narration.speak([{text:'The old voice.'}], {key:'old-pause'});
  await tick(); h.runTimer(30800); await tick(); h.Narration.pause();
  assert.equal(h.nativeSpeech.paused, true);
  h.Narration.selectVoice('mom', 'Mom'); await first;
  const next = h.Narration.speak([{text:'New voice starts.'}], {key:'new-reader'});
  await tick(); h.runTimer(30800); await tick();
  assert.equal(h.nativeSpeech.paused, false, 'Native speech must resume when a paused reader is replaced');
  h.spoken.at(-1).onend(); await next;
});

test('a late resume rejection cannot interrupt a newer parent clip', async () => {
  const h = load();
  const first = h.Narration.speak([{text:'The old parent clip.'}], {key:'old-resume'});
  await tick();
  const oldClip = h.clips.at(-1);
  let rejectResume;
  oldClip.play = () => new Promise((resolve, reject) => { rejectResume = reject; });
  h.Narration.pause(); h.Narration.resume();
  h.Narration.stop(); await first;
  const next = h.Narration.speak([{text:'The new parent clip.'}], {key:'new-after-resume'});
  await tick();
  const newClip = h.clips.at(-1);
  assert.notEqual(newClip, oldClip);
  rejectResume(new Error('Old play request rejected late'));
  await tick();
  assert.equal(h.spoken.length, 0, 'A rejected old play request must not force the new clip into browser fallback');
  assert.equal(h.Narration.voiceSource(), 'parent');
  assert.equal(h.Narration.playbackState(), 'playing');
  newClip.onended(); await next;
});
