const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../prototype', name), 'utf8');
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject}; };

class Element {
  constructor() {
    this.children = []; this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {};
    this.textContent = ''; this.checked = false;
    this.classList = {toggle() {}};
  }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  replaceChildren(...children) { this.children = children; }
  pause() {}
  load() {}
  play() { return Promise.resolve(); }
  click() { if (!this.disabled && !this.hidden) return this.onclick?.(); }
}
function state(mode = 'live', overrides = {}) {
  return {sessionId:'session-1', version:0, sceneId:'house1_choose', language:'en', providerMode:mode,
    question:{id:'house1_choose', text:'What material?', choices:[
      {id:'paper', label:'Paper', answer:'Build with paper'},
      {id:'straw', label:'Straw', answer:'Build with straw'},
      {id:'cookie', label:'Cookies', answer:'Build with cookies'}]},
    lines:[{speakerId:'narrator', text:'The story begins.'}], decision:'ready', choiceMode:false,
    storyState:{houseIndex:1}, mediaPlan:null, diagnostics:{}, ...overrides};
}
function accepted(mode = 'live', overrides = {}) {
  return state(mode, {version:1, sceneId:'house1_predict', decision:'accept', mediaPlan:{approved:true},
    question:{id:'house1_predict', text:'What will happen?', choices:[
      {id:'predict_1', label:'Blow away', answer:'The walls might blow away.'},
      {id:'predict_2', label:'Stay the same', answer:'The walls might stay the same.'},
      {id:'predict_3', label:'Watch together', answer:'Let us watch together.'}]},
    lines:[{speakerId:'narrator', text:'A new paper house.'}], ...overrides});
}
function imageResult(snapshot, overrides = {}) {
  return {sessionId:snapshot.sessionId, sceneId:snapshot.sceneId, version:snapshot.version, jobId:'job-1',
    apply:true, status:'ready', generated:snapshot.providerMode === 'live', generationRequested:snapshot.providerMode === 'live',
    source:snapshot.providerMode === 'live' ? 'muse_image' : 'local_assets',
    image:{url:snapshot.providerMode === 'live' ? '/api/media/images/picture?sessionId=session-1' : '/prototype/img/paper_house.jpg', reviewed:true},
    ...overrides};
}

async function harness() {
  const elements = new Map(), calls = [], shows = [], timers = new Map(), voiceCalls = [], narrations = [], cameraCalls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('mode').options = [new Element(), new Element()];
  const settings = {answer:null, language:null, media:null, session:null, transcript:'paper', recordError:null,
    transcriptionError:null, recording:null, transcription:null, camera:null, object:'paper'};
  let timerId = 0;
  const document = {documentElement:{}, hidden:false, getElementById:element, createElement:() => new Element(),
    addEventListener(type, fn) { this[type] = fn; }};
  const storage = new Map([['story-language', 'en']]);
  const context = vm.createContext({document, window:{addEventListener() {}}, crypto:require('node:crypto'),
    AbortController, Date, localStorage:{getItem:key => storage.get(key) ?? null, setItem:(key, value) => storage.set(key, value)},
    setTimeout:(callback, ms) => { const id = ++timerId; timers.set(id, {callback, ms}); return id; },
    clearTimeout:id => timers.delete(id),
    StoryImageTransition:class {
      constructor(current, next) { this.current = current; this.next = next; }
      cancel() {}
      show(url, options) { shows.push({url, ...options}); }
    },
    VoiceInput:{supported:() => true, record:async () => {
      voiceCalls.push('record');
      if (settings.recordError) throw settings.recordError;
      return settings.recording || {stop() {voiceCalls.push('stop');}, done:Promise.resolve({blob:{size:10}, ms:1000})};
    }, transcribe:async () => {
      voiceCalls.push('transcribe');
      if (settings.transcriptionError) throw settings.transcriptionError;
      return settings.transcription ? settings.transcription.promise : settings.transcript;
    }},
    CameraInput:{supported:() => true, open:async () => {
      cameraCalls.push('open');
      return settings.camera ? settings.camera.promise : {close() {cameraCalls.push('close');}, snap:async () => ({})};
    }, name:async () => { cameraCalls.push('name'); return settings.object; }},
    Narration:{stop() {}, voiceName:() => null, speak:(lines, options) => {
      narrations.push({lines, options}); return new Promise(() => {});
    }},
    fetch:async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({url, body, signal:options.signal});
      let data;
      if (url === '/api/config') data = {liveAvailable:true, mediaAvailable:true, imageGenerationAvailable:true,
        speechAvailable:true, visionAvailable:true};
      else if (url === '/api/sessions') data = settings.session || state(body.mode, {sessionId:`session-${calls.filter(c => c.url === url).length}`});
      else if (url === '/api/answer') data = settings.answer || accepted(body.mode);
      else if (url === '/api/language') data = settings.language;
      else if (url === '/api/media/cancel') data = {};
      else if (url.startsWith('/api/media/jobs')) data = settings.media || new Promise(() => {});
      else throw new Error(`Unexpected URL: ${url}`);
      data = await data;
      return {ok:!data?.error, json:async () => data};
    }});
  vm.runInContext(read('story-media.js'), context);
  vm.runInContext(read('live-book.js'), context);
  await flush();
  const start = async (mode = 'live') => {
    element('mode').value = mode;
    await element('mode').onchange();
    await element('cover').onclick();
    await flush();
  };
  const submit = async (value = 'paper') => {element('answer').value = value; await element('send').onclick(); await flush();};
  return {element, calls, settings, shows, timers, voiceCalls, narrations, cameraCalls, document, start, submit};
}

test('index is the child reader with offline/AI selection and no developer navigation', () => {
  const html = read('index.html');
  assert.equal(html, read('live.html'));
  for (const file of ['image-transitions.js', 'story-media.js', 'voice-input.js', 'camera-input.js', 'narration.js', 'live-book.js'])
    assert.ok(html.includes(`src="${file}"`));
  assert.match(html, /오프라인 버전/);
  assert.match(html, /AI 버전/);
  assert.doesNotMatch(html, /agent\.html|agent\.js|diagnosticsJson/);
  assert.match(read('agent.html'), /diagnosticsJson/);
});

test('generated bytes do not open the next question until the image is displayed', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('narrative').children[0].textContent, 'The story begins.');
  for (const id of ['send', 'answer', 'mic', 'cameraButton', 'language', 'mode']) assert.equal(h.element(id).disabled, true, id);
  const count = h.calls.filter(c => c.url === '/api/answer').length;
  await h.element('send').onclick();
  await h.element('answer').onkeydown({key:'Enter', preventDefault() {}});
  await h.element('mic').onclick();
  await h.element('cameraButton').onclick();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').length, count);
  assert.equal(h.voiceCalls.length, 0);
  assert.equal(h.cameraCalls.length, 0);
  assert.equal(h.narrations.length, 1, 'New narration waits for the displayed picture');
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.element('send').disabled, false);
  assert.equal(h.element('loading').hidden, true);
  assert.equal(h.narrations.length, 2);
});

test('running generation and polling keep the old page and all answers locked', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next;
  h.settings.media = imageResult(next, {status:'running', image:null, generated:false});
  await h.submit();
  assert.equal(h.element('mic').disabled, true);
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.shows.length, 1, 'Only the cover picture has been requested');
  h.settings.media = imageResult(next);
  await [...h.timers.values()].find(timer => timer.ms === 750).callback();
  await flush();
  assert.equal(h.element('send').disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('send').disabled, false);
});

test('failed generation, wrong binding and prepared AI fallback never unlock continuation', async () => {
  for (const variant of ['failed', 'fallback', 'binding', 'decode']) {
    const h = await harness(); await h.start();
    const next = accepted(); h.settings.answer = next;
    h.settings.media = variant === 'binding' ? imageResult(next, {version:99})
      : variant === 'failed' ? imageResult(next, {image:null, generated:false, status:'failed'})
      : variant === 'fallback' ? imageResult(next, {status:'fallback', generated:false, source:'local_assets',
        image:{url:'/prototype/img/paper_house.jpg'}}) : imageResult(next);
    await h.submit();
    if (variant === 'fallback') h.shows.at(-1).onComplete();
    if (variant === 'decode') h.shows.at(-1).onError();
    assert.equal(h.element('send').disabled, true, variant);
    assert.equal(h.element('question').textContent, 'What material?', variant);
    assert.equal(h.element('retryMedia').hidden, false, variant);
  }
});

test('reloading a failed image reattaches its binding and unlocks only after display', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit(); h.shows.at(-1).onError();
  await h.element('retryMedia').onclick(); await flush();
  assert.equal(h.calls.filter(c => c.url === '/api/media/cancel').length, 0);
  const jobs = h.calls.filter(c => c.url === '/api/media/jobs');
  assert.deepEqual(jobs[0].body, jobs[1].body);
  assert.equal(h.element('send').disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('send').disabled, false);
});

test('restart ignores stale image decode and late generation responses', async () => {
  for (const afterDecode of [true, false]) {
    const h = await harness(); await h.start();
    const next = accepted(), late = deferred(); h.settings.answer = next;
    h.settings.media = afterDecode ? imageResult(next) : late.promise;
    await h.submit();
    const oldShow = h.shows.at(-1);
    await h.element('restart').onclick(); await flush();
    if (afterDecode) oldShow.onComplete();
    else {late.resolve(imageResult(next)); await flush();}
    assert.equal(h.element('question').textContent, 'What material?');
    assert.equal(h.element('loading').hidden, true);
    assert.equal(h.element('send').disabled, false);
  }
});

test('first rejection shows exactly three keywords and blocks every free input path', async () => {
  const h = await harness(); await h.start();
  h.settings.answer = state('live', {version:1, decision:'retry', choiceMode:true});
  await h.submit('nonsense');
  assert.equal(h.element('choices').hidden, false);
  assert.deepEqual(h.element('choices').children.map(button => button.textContent), ['Paper', 'Straw', 'Cookies']);
  assert.equal(h.element('freeInput').hidden, true);
  assert.equal(h.element('inputActions').hidden, true);
  for (const id of ['send', 'mic', 'answer', 'cameraButton']) assert.equal(h.element(id).disabled, true);
  await h.submit('paper');
  await h.element('answer').onkeydown({key:'Enter', preventDefault() {}});
  await h.element('mic').onclick(); await h.element('cameraButton').onclick();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 1);
  assert.equal(h.voiceCalls.length, 0);
  const next = accepted('live', {version:2}); h.settings.answer = next; h.settings.media = imageResult(next);
  const card = h.element('choices').children[0];
  await card.onclick(); await flush();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').at(-1).body.choiceId, 'paper');
  assert.equal(card.disabled, true);
  assert.equal(h.element('freeInput').hidden, true, 'Choice-only presentation lasts until the new picture is displayed');
  assert.equal(h.element('inputActions').hidden, true);
  assert.equal(h.element('choices').hidden, false);
  await card.onclick();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 2);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('choices').hidden, true);
  assert.equal(h.element('freeInput').hidden, false);
  assert.equal(h.element('mic').disabled, false);
  await card.onclick();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 2, 'Old choice cannot answer the next question');
});

test('microphone refusal, empty recognition and service failure lock to choices without a blank answer request', async () => {
  for (const variant of ['permission', 'empty', 'service']) {
    const h = await harness(); await h.start();
    if (variant === 'permission') h.settings.recordError = new Error('NotAllowedError');
    if (variant === 'empty') h.settings.transcript = '';
    if (variant === 'service') h.settings.transcriptionError = new Error('speech_unavailable');
    await h.element('mic').onclick();
    assert.equal(h.element('choices').hidden, false, variant);
    assert.equal(h.element('choices').children.length, 3);
    assert.equal(h.element('inputActions').hidden, true);
    assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 0);
    const previous = h.voiceCalls.length;
    await h.element('mic').onclick();
    assert.equal(h.voiceCalls.length, previous);
  }
});

test('local choice lock survives a language switch and read-aloud changes for the same question', async () => {
  const h = await harness(); await h.start();
  h.settings.recordError = new Error('denied'); await h.element('mic').onclick();
  const oldCard = h.element('choices').children[0];
  const old = state();
  h.settings.language = state('live', {version:1, language:'ko', diagnostics:{languageChanged:true},
    question:{...old.question, text:'무엇으로 지을까?', choices:old.question.choices.map((choice, i) =>
      ({...choice, label:['종이', '짚', '과자'][i]}))}});
  h.element('language').value = 'ko'; await h.element('language').onchange();
  h.element('readAloud').checked = false; h.element('readAloud').onchange();
  h.element('readAloud').checked = true; h.element('readAloud').onchange();
  assert.equal(h.element('freeInput').hidden, true);
  assert.deepEqual(h.element('choices').children.map(button => button.textContent), ['종이', '짚', '과자']);
  assert.equal(h.calls.filter(c => c.url === '/api/media/jobs').length, 0);
  await oldCard.onclick();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 0, 'Queued choice from the old language version is stale');
});

test('late transcription cannot change a restarted session or a hidden-tab cancelled answer', async () => {
  for (const restart of [true, false]) {
    const h = await harness(); await h.start();
    h.settings.transcription = deferred();
    const listening = h.element('mic').onclick(); await flush();
    if (restart) await h.element('restart').onclick();
    else {h.document.hidden = true; h.document.visibilitychange();}
    h.settings.transcription.resolve('late transcript'); await listening;
    assert.notEqual(h.element('answer').value, 'late transcript');
    assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 0);
    assert.equal(h.element('mic').disabled, false);
  }
});

test('offline mode uses prepared assets and choices without microphone, camera or model inference', async () => {
  const h = await harness(); await h.start('mock');
  await h.element('mic').onclick();
  assert.equal(h.element('choices').hidden, false);
  assert.equal(h.voiceCalls.length, 0);
  const next = accepted('mock'); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.element('choices').children[0].onclick(); await flush();
  assert.equal(h.element('send').disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('send').disabled, false);
  assert.equal(h.voiceCalls.length, 0);
  assert.equal(h.cameraCalls.length, 0);
  assert.equal(h.calls.filter(c => c.url === '/api/sessions')[0].body.mode, 'mock');
});

test('camera answers reuse the public module and respect the image gate', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.element('cameraButton').onclick();
  assert.equal(h.element('cameraPanel').hidden, false);
  await h.element('cameraSnap').onclick(); await flush();
  assert.equal(h.element('cameraPanel').hidden, true);
  assert.equal(h.calls.filter(c => c.url === '/api/answer').length, 0);
  assert.equal(h.element('answer').value, 'paper');
  await h.element('send').onclick(); await flush();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').at(-1).body.answer, 'paper');
  assert.equal(h.element('mic').disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('mic').disabled, false);
});

test('language-only presentation changes keep the displayed image without generating again', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit(); h.shows.at(-1).onComplete();
  h.settings.language = {...next, language:'ko', version:2, diagnostics:{languageChanged:true}};
  h.element('language').value = 'ko'; await h.element('language').onchange();
  assert.equal(h.calls.filter(c => c.url === '/api/media/jobs').length, 1);
  assert.equal(h.element('mic').disabled, false);
});
