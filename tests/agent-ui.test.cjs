const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class Element {
  constructor() {
    this.dataset = {}; this.children = []; this.listeners = {};
    this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    const classes = new Set();
    this.classList = {toggle:(name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains:name => classes.has(name)};
  }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  fire(name) { if (!this.disabled) return this.listeners[name]?.({preventDefault() {}}); }
  querySelector() { return this.option ||= new Element(); }
  querySelectorAll() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
}
function snapshot(mode, id) {
  return {sessionId:id, version:0, sceneId:'house1_choose', language:'en',
    question:{id:'house1_choose', text:'What material?', intent:'choose_material', choices:[
      {id:'paper', label:'Paper', answer:'Build with paper'},
      {id:'straw', label:'Straw', answer:'Build with straw'},
      {id:'cookie', label:'Cookies', answer:'Build with cookies'}]},
    lines:[{speakerId:'narrator', text:'The story begins.'}], decision:'ready', reason:'story_started',
    attempts:0, choiceMode:false, storyState:{language:'en'}, mediaPlan:null, diagnostics:{}, providerMode:mode};
}
async function harness(initialAvailable = true, speechAvailable = false, narrationAvailable = false, globals = {}) {
  if (typeof speechAvailable === "object") { globals = speechAvailable; speechAvailable = false; }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('mode').value = 'mock';
  const calls = [];
  const settings = {available:initialAvailable, speechAvailable, vision:Boolean(globals.CameraInput), answerResult:null, languageResult:null,
    recordError:null, transcribeError:null, transcript:'paper', recordPromise:null, transcribePromise:null, voiceSupported:true};
  const speech = [], voiceCalls = [], stops = [];
  const narrationCalls = [];
  const narration = {
    warm:() => narrationCalls.push({type:'warm'}),
    stop:() => narrationCalls.push({type:'stop'}),
    interject:language => narrationCalls.push({type:'interject', language}),
    speak:(lines, options) => {
      narrationCalls.push({type:'speak', lines, options});
      return new Promise(() => {}); // A pending parent voice must never block the cards.
    }
  };
  const voice = {
    supported: () => settings.voiceSupported,
    record: async () => {
      voiceCalls.push('record');
      if (settings.recordError) throw settings.recordError;
      if (settings.recordPromise) return settings.recordPromise;
      return {stop: () => stops.push('stop'), done:Promise.resolve({ms:1000, blob:{size:10}})};
    },
    transcribe: async (clip, options) => {
      voiceCalls.push({transcribe:clip, signal:options.signal});
      if (settings.transcribeError) throw settings.transcribeError;
      if (settings.transcribePromise) return settings.transcribePromise;
      return settings.transcript;
    }
  };
  const languageButtons = ['en', 'ko'].map(value => { const button = new Element(); button.dataset.language = value; return button; });
  const document = {documentElement:{}, getElementById:element, querySelectorAll:selector => selector === '[data-language]' ? languageButtons : [], createElement:() => new Element()};
  const context = vm.createContext({document, localStorage:{getItem() {return null;}, setItem() {}},
    AbortController, VoiceInput:voice, ...(narrationAvailable ? {Narration:narration} : {}),
    SpeechSynthesisUtterance:class {constructor(text) {this.text = text;}},
    speechSynthesis:{speak:utterance => speech.push(utterance), cancel() {}},
    crypto:require('node:crypto'), setTimeout:() => 1, clearTimeout() {}, ...globals,
    fetch:async (url, options={}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const call = {url, body};
      calls.push(call);
      const data = url === '/api/config' ? {liveAvailable:settings.available, speechAvailable:settings.speechAvailable, model:'test-model', visionAvailable:settings.vision,
        mediaAvailable:Boolean(globals.StoryMediaPlayer), imageGenerationAvailable:Boolean(globals.StoryMediaPlayer)}
        : url === '/api/answer' && settings.answerResult ? settings.answerResult
        : url === '/api/language' && settings.languageResult ? settings.languageResult
        : snapshot(body.mode, `session-${calls.length}`);
      call.result = data;
      return {ok:true, json:async () => data};
    }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/agent-i18n.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/agent.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return {element, calls, settings, languageButtons, speech, voiceCalls, stops, narrationCalls};
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

test('pending live drawing does not block the microphone or first-failure touch cards', async () => {
  const mediaCalls = [];
  class PendingMedia {
    constructor(current, next, options) { this.notify = options.onState; }
    configure(config) { mediaCalls.push(config); }
    reset() { this.notify({state:'reference'}); }
    update(state) { if (state.mediaPlan) this.notify({state:'generating'}); }
    cancel() {}
  }
  const {element, calls, settings} = await harness(true, true, true, {StoryMediaPlayer:PendingMedia});
  await element('startButton').fire('click');
  settings.answerResult = {...snapshot('live', calls.at(-1).result.sessionId), version:1,
    sceneId:'house1_predict', decision:'accept', mediaPlan:{approved:true}};
  element('answer').value = 'paper';
  await element('answerForm').fire('submit');
  await new Promise(setImmediate);
  assert.equal(mediaCalls[0].imageGenerationAvailable, true);
  assert.equal(element('imagePanel')['aria-busy'], 'true');
  assert.equal(element('micButton').disabled, false);
  settings.recordError = {name:'NotAllowedError'};
  await element('micButton').fire('click');
  assert.equal(element('choicePanel').hidden, false);
  assert.equal(element('choices').children.length, 3);
  assert.ok(element('choices').children.every(button => !button.disabled));
  const answersBeforeTap = calls.filter(call => call.url === '/api/answer').length;
  await element('choices').children[0].fire('click');
  assert.equal(calls.filter(call => call.url === '/api/answer').length, answersBeforeTap + 1);
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

const flush = () => new Promise(setImmediate);
const started = h => h.calls.filter(call => call.url === '/api/sessions').at(-1).result;
function nextQuestion(start) {
  return {...start, version:start.version + 1, sceneId:'house1_predict', decision:'accept',
    attempts:0, choiceMode:false, question:{...start.question, id:'house1_predict'},
    diagnostics:{authoredFallback:true},
    storyState:{language:start.language, houseIndex:1, stage:'predict', houses:[{houseId:'house1', material:'paper'}]}};
}

test('the first rejected answer immediately offers touch cards and a single tap submits once during narration', async () => {
  const h = await harness();
  await h.element('startButton').fire('click');
  const start = started(h);
  h.settings.answerResult = {...start, version:1, decision:'clarify', reason:'unclear_answer',
    attempts:1, choiceMode:true};
  h.element('answer').value = 'I do not know';
  h.element('answerForm').fire('submit');
  await flush();
  const cards = h.element('choices').children;
  assert.equal(h.element('choicePanel').hidden, false);
  assert.equal(cards.length, 3);
  assert.ok(cards.every(card => !card.disabled));
  assert.equal(cards[0].children[1].textContent, '📄');
  assert.match(h.element('choicePrompt').textContent, /Tap the one you like/);
  assert.doesNotMatch(h.element('attemptNote').textContent, /more tries/);
  assert.match(h.speech.at(-1).text, /Tap the one you like/);
  assert.equal(h.element('choicePanel').scrolledIntoView, true);
  h.settings.answerResult = nextQuestion(h.settings.answerResult);
  // No speech completion callback is fired. A double tap still submits one answer.
  const tap = cards[0].fire('click');
  cards[0].fire('click');
  await tap;
  const answers = h.calls.filter(call => call.url === '/api/answer');
  assert.equal(answers.length, 2);
  assert.equal(answers[1].body.choiceId, 'paper');
  assert.equal(answers[1].body.version, 1);
  assert.equal(h.element('choicePanel').hidden, true);
});

for (const [name, configure] of [
  ['microphone permission denied', settings => {settings.recordError = {name:'NotAllowedError'};}],
  ['microphone unavailable', settings => {settings.recordError = {name:'NotFoundError'};}],
  ['recognition service error', settings => {settings.transcribeError = {code:'speech_unavailable'};}],
  ['unreadable recording', settings => {settings.transcribeError = {code:'audio_unreadable'};}],
  ['silent or short recording', settings => {settings.transcript = '';}],
  ['whitespace transcript', settings => {settings.transcript = '   ';}]
]) {
  test(`${name}: cards open locally without an extra failure request and a tap continues`, async () => {
    const h = await harness(true, true);
    await h.element('startButton').fire('click');
    configure(h.settings);
    await h.element('micButton').fire('click');
    assert.equal(h.element('choicePanel').hidden, false);
    const cards = h.element('choices').children;
    assert.equal(cards.length, 3);
    assert.ok(cards.every(card => !card.disabled));
    assert.equal(h.calls.filter(call => call.url === '/api/answer').length, 0,
      'The fallback must be usable without posting an empty answer or waiting for another request');
    assert.match(h.element('requestStatus').textContent, /Tap a picture/);
    h.settings.answerResult = nextQuestion(started(h));
    await cards[0].fire('click');
    assert.equal(h.calls.filter(call => call.url === '/api/answer').length, 1);
    assert.equal(h.calls.at(-1).body.choiceId, 'paper');
    assert.equal(h.element('choicePanel').hidden, true);
  });
}

test('rejecting recognized words opens touch choices immediately instead of forcing a new recording', async () => {
  const h = await harness(true, true);
  await h.element('startButton').fire('click');
  h.settings.transcript = 'words I did not say';
  await h.element('micButton').fire('click');
  assert.equal(h.element('rejectTranscript').hidden, false);
  assert.equal(h.element('answer').value, 'words I did not say');
  h.element('rejectTranscript').fire('click');
  assert.equal(h.element('choicePanel').hidden, false);
  assert.equal(h.element('answer').value, '');
  assert.equal(h.element('rejectTranscript').hidden, true);
  assert.equal(h.voiceCalls.filter(call => call === 'record').length, 1);
  assert.equal(h.calls.filter(call => call.url === '/api/answer').length, 0);
});

test('a browser without recording support can use touch choices as soon as the question appears', async () => {
  const h = await harness(true, true);
  h.settings.voiceSupported = false;
  await h.element('startButton').fire('click');
  assert.equal(h.element('micButton').hidden, true);
  assert.equal(h.element('choicePanel').hidden, false);
  assert.ok(h.element('choices').children.every(card => !card.disabled));
  assert.equal(h.voiceCalls.length, 0);
});

test('locally opened cards survive language switching and are reset by a fresh session', async () => {
  const h = await harness(true, true);
  await h.element('startButton').fire('click');
  h.settings.transcript = '';
  await h.element('micButton').fire('click');
  const start = started(h);
  h.settings.languageResult = {...start, language:'ko', version:1, question:{...start.question,
    choices:start.question.choices.map((choice, index) => ({...choice, label:['종이', '짚', '과자'][index]}))}};
  await h.languageButtons[1].fire('click');
  assert.equal(h.element('choicePanel').hidden, false);
  assert.ok(h.element('choices').children.every(card => !card.disabled));
  assert.match(h.element('choicePrompt').textContent, /톡 눌러/);
  assert.equal(h.speech.at(-1).lang, 'ko-KR');
  await h.element('startButton').fire('click');
  assert.equal(h.element('choicePanel').hidden, true);
});

test('a queued tap from the old presentation cannot submit against a newer language version', async () => {
  const h = await harness(true, true);
  await h.element('startButton').fire('click');
  h.settings.transcript = '';
  await h.element('micButton').fire('click');
  const oldTap = h.element('choices').children[0].listeners.click;
  const start = started(h);
  h.settings.languageResult = {...start, language:'ko', version:1};
  await h.languageButtons[1].fire('click');
  await oldTap();
  assert.equal(h.calls.filter(call => call.url === '/api/answer').length, 0);
  h.settings.answerResult = nextQuestion(h.settings.languageResult);
  await h.element('choices').children[0].fire('click');
  assert.equal(h.calls.at(-1).body.version, 1);
});

test('a touch answer cancels transcription and a late transcript cannot overwrite the new question', async () => {
  const h = await harness(true, true);
  await h.element('startButton').fire('click');
  h.settings.transcript = '';
  await h.element('micButton').fire('click');
  let finish;
  h.settings.transcribePromise = new Promise(resolve => {finish = resolve;});
  const pendingVoice = h.element('micButton').fire('click');
  await flush();
  const transcribe = h.voiceCalls.at(-1);
  const card = h.element('choices').children[0];
  assert.equal(card.disabled, false, 'An optional new recording cannot block a touch answer');
  h.settings.answerResult = nextQuestion(started(h));
  await card.fire('click');
  assert.equal(transcribe.signal.aborted, true);
  finish('stale transcript');
  await pendingVoice;
  assert.equal(h.element('answer').value, '');
  assert.equal(h.element('sceneValue').textContent, 'house1_predict');
  assert.equal(h.element('answer').disabled, false);
  assert.equal(h.element('choicePanel').hidden, true);
});

test('a microphone permission result arriving after restart is stopped without touching the fresh session', async () => {
  const h = await harness(true, true);
  await h.element('startButton').fire('click');
  let allow;
  h.settings.recordPromise = new Promise(resolve => {allow = resolve;});
  const opening = h.element('micButton').fire('click');
  await flush();
  await h.element('startButton').fire('click');
  let stopped = false;
  allow({stop:() => {stopped = true;}, done:Promise.resolve({ms:1000, blob:{size:10}})});
  await opening;
  assert.equal(stopped, true);
  assert.equal(h.voiceCalls.filter(call => call?.transcribe).length, 0);
  assert.equal(h.element('choicePanel').hidden, true);
  assert.equal(h.element('answer').disabled, false);
});

test('parent narration reads the first-failure choices while touch stays active and the next passage is preserved', async () => {
  const h = await harness(true, true, true);
  await h.element('startButton').fire('click');
  const opening = h.narrationCalls.filter(call => call.type === 'speak').at(-1);
  assert.equal(opening.lines.length, 2, 'The initial story and question still use narration');
  opening.options.onLine(0);
  assert.ok(h.element('narrative').children[0].classList.contains('speaking'));
  const start = started(h);
  h.settings.answerResult = {...start, version:1, decision:'clarify', reason:'unclear_answer',
    attempts:1, choiceMode:true};
  h.element('answer').value = 'I do not know';
  h.element('answerForm').fire('submit');
  await flush();
  const reads = h.narrationCalls.filter(call => call.type === 'speak');
  assert.equal(reads.length, 2, 'The failure must not start competing passage and invitation readings');
  assert.match(reads[1].lines[0].text, /Tap the one you like/);
  assert.match(reads[1].lines[1].text, /1\. Paper.*2\. Straw.*3\. Cookies/);
  assert.equal(h.speech.length, 0, 'Do not also start a browser voice over parent narration');
  const card = h.element('choices').children[0];
  assert.equal(card.disabled, false);
  h.settings.answerResult = nextQuestion(h.settings.answerResult);
  await card.fire('click');
  assert.equal(h.element('choicePanel').hidden, true);
  const continued = h.narrationCalls.filter(call => call.type === 'speak').at(-1);
  assert.doesNotMatch(continued.options.key, /^choices:/);
  assert.equal(h.narrationCalls.filter(call => call.type === 'interject').length, 1,
    'A deterministic touch answer needs no delayed filler');
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
