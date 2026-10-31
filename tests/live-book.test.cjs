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
    const classes = new Set();
    this.classList = {toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
      add:name => classes.add(name), contains:name => classes.has(name)};
  }
  setAttribute(key, value) { this[key] = value; }
  getAttribute(key) { return this[key] ?? null; }
  focus() { this.focused = true; }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  removeAttribute(key) { delete this[key]; }
  replaceChildren(...children) { this.children = children; }
  append(child) { this.children.push(child); child.parentElement = this; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
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
function preparedChoiceResult(snapshot, overrides = {}) {
  return imageResult(snapshot, {source:'prepared_choice', generated:false, generationRequested:false,
    generationRetryAvailable:false, retriesRemaining:0, reason:'prepared_choice_image',
    image:{url:'/prototype/img/paper_house.jpg'}, ...overrides});
}

async function harness(request = null, {withMotion = false} = {}) {
  const elements = new Map(), calls = [], shows = [], reveals = [], timers = new Map(), voiceCalls = [], narrations = [], cameraCalls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('mode').options = [new Element(), new Element()];
  element('readerSettings').hidden = true;
  element('imgCur').parentElement = element('art');
  element('imgCur').src = 'img/intro.jpg';
  const voiceSetupCalls = [];
  const settings = {answer:null, advance:null, language:null, media:null, session:null, transcript:'paper', recordError:null, voiceName:null,
    transcriptionError:null, recording:null, transcription:null, camera:null, object:'paper', voiceId:null,
    voices:[], voiceListError:null, voiceList:null, playback:'idle', voiceSource:null, scenePreparation:null, speakError:null};
  const preparedScenes = new Map();
  const sceneKey = (lines, options) => JSON.stringify([settings.voiceId, options.language, lines]);
  const playbackCalls = [], prefetched = [], motionCalls = [];
  let playbackListener = () => {};
  const playback = state => { settings.playback = state; playbackListener(state); };
  let timerId = 0;
  const document = {documentElement:{}, hidden:false, getElementById:element, createElement:() => new Element(),
    addEventListener(type, fn) { this[type] = fn; }};
  const storage = new Map([['story-language', 'en']]);
  const context = vm.createContext({document, window:{addEventListener() {}}, crypto:require('node:crypto'),
    AbortController, Date, localStorage:{getItem:key => storage.get(key) ?? null, setItem:(key, value) => storage.set(key, value)},
    setTimeout:(callback, ms) => { const id = ++timerId; timers.set(id, {callback, ms}); return id; },
    clearTimeout:id => timers.delete(id),
    StoryMotion: withMotion ? class {
      stop() { motionCalls.push('stop'); }
      scene(options) { motionCalls.push(['scene', options.action]); }
      cue(index, key, sentence) { motionCalls.push(['cue', index, sentence]); return /ate the wall/.test(sentence); }
      pause() { motionCalls.push('pause'); }
      resume() { motionCalls.push('resume'); }
      start() { motionCalls.push('start'); }
    } : undefined,
    StoryImageTransition:class {
      constructor(current, next) { this.current = current; this.next = next; }
      cancel() {}
      show(url, options) { shows.push({url, ...options}); }
      prepare(url, options) {
        this.prepared = url;
        shows.push({url, onComplete:options.onReady, onError:options.onError});
      }
      reveal(onComplete) { reveals.push(this.prepared); onComplete?.(); }
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
    Narration:{stop() { playbackCalls.push('stop'); playback('idle'); }, voiceName:() => settings.voiceName,
      voiceId:() => settings.voiceId, voiceSource:() => settings.voiceSource,
      playbackState:() => settings.playback, subscribe:listener => { playbackListener = listener; listener(settings.playback); return () => {}; },
      pause() { playbackCalls.push('pause'); playback('paused'); }, resume() { playbackCalls.push('resume'); playback('playing'); },
      selectVoice(id, name) { preparedScenes.clear(); settings.voiceId = id; settings.voiceName = name; },
      listVoices:async () => { if (settings.voiceListError) throw settings.voiceListError; return settings.voiceList ? settings.voiceList.promise : settings.voices; },
      prefetch:(lines, options) => prefetched.push({lines, options}),
      prepareScene:(lines, options) => {
        prefetched.push({lines, options});
        const key = sceneKey(lines, options);
        if (settings.scenePreparation) return settings.scenePreparation.promise.then(asset => {
          preparedScenes.set(key, asset); return asset;
        });
        const asset = {ready:true, key:options.key};
        preparedScenes.set(key, asset);
        return asset;
      },
      getPreparedScene:(lines, options) => preparedScenes.get(sceneKey(lines, options)) || null,
      warm:() => voiceSetupCalls.push('warm'),
      interject:language => voiceSetupCalls.push(language), speak:(lines, options) => {
      narrations.push({lines, options}); playback('playing');
      return settings.speakError ? Promise.reject(settings.speakError) : new Promise(() => {});
    }},
    fetch:async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({url, body, signal:options.signal});
      if (request) return request(url, options);
      let data;
      if (url === '/api/config') data = {liveAvailable:true, mediaAvailable:true, imageGenerationAvailable:true,
        speechAvailable:true, visionAvailable:true};
      else if (url === '/api/sessions') data = settings.session || state(body.mode, {sessionId:`session-${calls.filter(c => c.url === url).length}`});
      else if (url === '/api/answer') data = settings.answer || accepted(body.mode);
      else if (url === '/api/advance') data = settings.advance || accepted('live', {
        diagnostics:{manualNavigation:{skippedPicture:true, skippedQuestion:true, defaultChoice:'Paper'}}});
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
  if (request) {
    for (let turn = 0; turn < 100 && element('cover').disabled; turn++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(element('cover').disabled, false, 'Reader configuration must finish before starting');
  }
  const start = async (mode = 'live') => {
    element('mode').value = mode;
    await element('mode').onchange();
    await element('cover').onclick();
    await flush();
  };
  const submit = async (value = 'paper') => {element('answer').value = value; await element('send').onclick(); await flush();};
  return {element, calls, settings, shows, reveals, timers, voiceCalls, narrations, cameraCalls, voiceSetupCalls, motionCalls,
    document, start, submit, playback, playbackCalls, prefetched, expireSceneCache:() => preparedScenes.clear()};
}

test('illustration playback controls pause, resume and replay the displayed passage', async () => {
  const h = await harness();
  assert.equal(h.element('playNarration').disabled, true);
  await h.start();
  assert.equal(h.element('pauseNarration').disabled, false);
  const readings = h.narrations.length;
  h.element('pauseNarration').onclick();
  assert.equal(h.settings.playback, 'paused');
  assert.equal(h.element('playNarration').disabled, false);
  h.element('playNarration').onclick();
  assert.equal(h.playbackCalls.at(-1), 'resume');
  assert.equal(h.narrations.length, readings, 'Resume does not restart the passage');
  h.playback('idle');
  h.element('playNarration').onclick();
  assert.equal(h.narrations.length, readings + 1);
  assert.equal(h.element('readAloud').checked, true);
});

test('loading narration can be paused and displayed source identifies browser fallback', async () => {
  const h = await harness(); await h.start();
  h.playback('loading');
  assert.equal(h.element('pauseNarration').disabled, false);
  h.element('pauseNarration').onclick();
  assert.equal(h.settings.playback, 'paused');
  h.settings.voiceSource = 'browser'; h.playback('playing');
  assert.match(h.element('narrationStatus').textContent, /browser voice/);
});

test('playback is gated during next-picture preparation and prefetch never starts reading', async () => {
  const h = await harness(); await h.start();
  h.settings.answer = accepted(); h.settings.media = imageResult(h.settings.answer);
  const readings = h.narrations.length;
  await h.submit();
  assert.equal(h.element('playNarration').disabled, true);
  assert.equal(h.element('pauseNarration').disabled, true);
  h.element('playNarration').onclick();
  assert.equal(h.narrations.length, readings);
  assert.equal(h.prefetched.at(-1).lines[0].text, 'A new paper house.');
  assert.equal(h.prefetched.at(-1).options.language, 'en');
  h.shows.at(-1).onComplete();
  assert.equal(h.narrations.length, readings + 1);
});

test('settings selects saved voices immediately without opening registration', async () => {
  const h = await harness(); await h.start();
  h.settings.voices = [{id:'mom', name:'Mom'}, {id:'dad', name:'Dad'}];
  await h.element('settingsButton').onclick();
  assert.equal(h.element('readerSettings').hidden, false);
  assert.deepEqual(h.element('voiceSelect').children.map(option => option.value), ['', 'mom', 'dad']);
  h.element('voiceSelect').value = 'dad'; h.element('voiceSelect').onchange();
  assert.equal(h.settings.voiceId, 'dad');
  assert.equal(h.element('addVoice').hidden, false, 'Adding another voice stays available for a saved voice');
  assert.match(h.element('readerName').textContent, /Dad/);
  assert.match(h.element('readBy').textContent, /Dad/);
  assert.equal(h.narrations.length, 2, 'Current passage restarts with the chosen voice');
  h.element('voiceSelect').value = ''; h.element('voiceSelect').onchange();
  assert.equal(h.settings.voiceId, null);
});

test('settings can close with its button, Escape or an outside press without swallowing inside interactions', async () => {
  const h = await harness();
  await h.element('settingsButton').onclick();
  assert.equal(h.element('settingsButton')['aria-expanded'], 'true');
  assert.equal(h.element('closeSettings').focused, true);
  h.document.pointerdown({target:h.element('readerSettings')});
  assert.equal(h.element('readerSettings').hidden, false);
  h.document.pointerdown({target:h.element('settingsButton')});
  assert.equal(h.element('readerSettings').hidden, false);
  h.document.pointerdown({target:h.element('book')});
  assert.equal(h.element('readerSettings').hidden, true);
  assert.equal(h.element('settingsButton')['aria-expanded'], 'false');
  await h.element('settingsButton').onclick();
  let prevented = false;
  h.document.keydown({key:'Escape', preventDefault() {prevented = true;}});
  assert.equal(prevented, true);
  assert.equal(h.element('readerSettings').hidden, true);
  assert.equal(h.element('settingsButton').focused, true);
  await h.element('settingsButton').onclick();
  h.element('closeSettings').onclick();
  assert.equal(h.element('readerSettings').hidden, true);
});

test('closing the settings popover prevents a late voice-list response from resetting the saved selection', async () => {
  const h = await harness();
  h.settings.voiceId = 'jiho'; h.settings.voiceName = 'Jiho';
  const response = deferred(); h.settings.voiceList = response;
  const opening = h.element('settingsButton').onclick();
  h.element('closeSettings').onclick();
  response.resolve([]); await opening;
  assert.equal(h.settings.voiceId, 'jiho');
  assert.equal(h.element('addVoice').hidden, false);
});

test('settings keeps the current voice on list failure and forgets a deleted saved voice on refresh', async () => {
  const h = await harness();
  h.settings.voiceId = 'dad'; h.settings.voiceName = 'Dad'; h.settings.voiceListError = new Error('offline');
  await h.element('settingsButton').onclick();
  assert.equal(h.settings.voiceId, 'dad');
  assert.equal(h.element('voiceSelect').value, 'dad');
  assert.match(h.element('voiceSelectStatus').textContent, /Couldn't load/);
  h.element('settingsButton').onclick();
  h.settings.voiceListError = null;
  await h.element('settingsButton').onclick();
  assert.equal(h.settings.voiceId, null);
  assert.equal(h.element('voiceSelect').value, '');
});

test('a late saved-voice response cannot overwrite reopened settings', async () => {
  const h = await harness(); const old = deferred();
  h.settings.voiceList = old;
  const opening = h.element('settingsButton').onclick();
  h.element('settingsButton').onclick();
  h.settings.voiceList = null; h.settings.voices = [{id:'mom', name:'Mom'}];
  await h.element('settingsButton').onclick();
  old.resolve([{id:'old', name:'Old voice'}]); await opening;
  assert.deepEqual(h.element('voiceSelect').children.map(option => option.value), ['', 'mom']);
});

test('merged parent voice registration, return links and warmup remain available in the child reader', async () => {
  const h = await harness();
  assert.equal(h.element('addVoice').hidden, false);
  assert.equal(h.element('addVoice').href, 'voice.html?return=index.html&lang=en');
  assert.deepEqual(h.voiceSetupCalls, ['warm']);
  h.settings.voiceName = 'Mom';
  h.element('language').value = 'ko';
  await h.element('language').onchange();
  assert.equal(h.element('addVoice').hidden, false);
  assert.match(h.element('readerName').textContent, /Mom/);
  assert.equal(h.element('addVoice').href, 'voice.html?return=index.html&lang=ko');
  await h.start();
  h.settings.answer = accepted();
  await h.submit();
  assert.deepEqual(h.voiceSetupCalls, ['warm', 'ko']);
  assert.equal(h.element('send').disabled, true, 'Voice fillers preserve the image display gate');
});

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

test('dialogue shows localized speakers and quotes while narration receives only the original lines', async () => {
  const h = await harness();
  const cast = ['pig1', 'pig2', 'pig3', 'wolf'];
  const lines = [{speakerId:'narrator', kind:'narration', tone:'warm', emotion:'calm', text:'The pigs looked up.'},
    ...cast.map(speakerId => ({speakerId, kind:'dialogue', tone:'lively', emotion:'excited', text:'Let us try!'}))];
  h.settings.session = state('live', {lines});
  await h.start();
  const paragraphs = h.element('narrative').children;
  assert.equal(paragraphs[0].textContent, lines[0].text, 'Narrator needs no character label');
  for (const [i, label] of ['Oldest pig', 'Middle pig', 'Youngest pig', 'Wolf'].entries()) {
    assert.equal(paragraphs[i + 1].children[0].textContent, `${label}: `);
    assert.equal(paragraphs[i + 1].children[1].textContent, '“Let us try!”');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.narrations.at(-1).lines.slice(0, lines.length))), lines);
  assert.deepEqual(JSON.parse(JSON.stringify(h.prefetched.at(-1).lines.slice(0, lines.length))), lines);
  assert.deepEqual(JSON.parse(JSON.stringify(h.narrations.at(-1).lines.at(-1))),
    {speakerId:'narrator', text:'What material?', kind:'narration', tone:'curious', emotion:'curious'});

  const korean = lines.map(line => ({...line, text:line.speakerId === 'narrator' ? '돼지들이 고개를 들었어요.' : '같이 해 보자!'}));
  h.settings.language = state('live', {version:1, language:'ko', lines:korean, diagnostics:{languageChanged:true}});
  h.element('language').value = 'ko'; await h.element('language').onchange();
  for (const [i, label] of ['첫째 돼지', '둘째 돼지', '막내 돼지', '늑대'].entries()) {
    assert.equal(h.element('narrative').children[i + 1].children[0].textContent, `${label}: `);
    assert.equal(h.element('narrative').children[i + 1].children[1].textContent, '“같이 해 보자!”');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.narrations.at(-1).lines.slice(0, korean.length))), korean,
    'Display labels, quotation marks and delivery directions never enter the spoken words');
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

test('an AI touch choice opens its prepared page only after the local image is displayed', async () => {
  const h = await harness(); await h.start();
  h.settings.recordError = new Error('Microphone unavailable');
  await h.element('mic').onclick(); await flush();
  const next = accepted('live', {selection:{choiceId:'paper'}});
  h.settings.answer = next; h.settings.media = preparedChoiceResult(next);
  await h.element('choices').children[0].onclick(); await flush();
  assert.equal(h.calls.filter(c => c.url === '/api/answer').at(-1).body.choiceId, 'paper');
  assert.equal(h.shows.at(-1).url, '/prototype/img/paper_house.jpg');
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('loading').hidden, false);
  assert.equal(h.element('send').disabled, true);
  assert.equal(h.element('choices').children[0].disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.element('send').disabled, false);
  assert.equal(h.element('loading').hidden, true);
  assert.equal(h.narrations.length, 3, 'New scene narration begins only after its image is displayed');
});

test('AI prepared image decoding can retry without generation and keeps the page gate until display', async () => {
  const h = await harness(); await h.start();
  const next = accepted('live', {selection:{choiceId:'paper'}});
  h.settings.answer = next; h.settings.media = preparedChoiceResult(next);
  await h.submit(); h.shows.at(-1).onError();
  assert.equal(h.element('send').disabled, true);
  assert.equal(h.element('retryMedia').hidden, false);
  await h.element('retryMedia').onclick(); await flush();
  const jobs = h.calls.filter(c => c.url === '/api/media/jobs');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].body, jobs[1].body);
  assert.equal(jobs[1].body.retryOf, undefined);
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('send').disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.element('send').disabled, false);
});

test('malformed prepared choice metadata keeps the AI reader locked', async () => {
  for (const changes of [{status:'failed'}, {status:'fallback'}, {generated:true}, {generationRequested:true},
    {image:{url:'/api/media/images/picture?sessionId=session-1'}}, {source:'local_assets'}]) {
    const h = await harness(); await h.start();
    const next = accepted('live', {selection:{choiceId:'paper'}});
    h.settings.answer = next; h.settings.media = preparedChoiceResult(next, changes);
    await h.submit();
    if (h.shows.length > 1) h.shows.at(-1).onComplete();
    assert.equal(h.element('send').disabled, true, JSON.stringify(changes));
    assert.equal(h.element('question').textContent, 'What material?');
    assert.equal(h.element('loading').hidden, false);
  }
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
    assert.equal(h.element('retryMedia').hidden, variant === 'binding', variant);
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

test('the retry button recovers a failed generation through the real media server', {timeout:10000}, async () => {
  const {spawn} = require('node:child_process');
  const {createInterface} = require('node:readline');
  const {once} = require('node:events');
  const fixture = spawn(process.env.STORYSHAPER_TEST_PYTHON || 'python3', ['-u', '-c', `
from media.image_provider import ImageError
from media.jobs import MediaJobs
from tests.test_live_images import JPEG, LiveRules
from vision.server import VisionPlayground, VisionServer

class FailOnce:
    calls = 0
    def generate(self, spec, plan, references, cancelled):
        self.calls += 1
        print('ATTEMPT', self.calls, flush=True)
        if self.calls == 1:
            raise ImageError('image_http_error')
        return JPEG

app = VisionPlayground('fixture-key', provider_factory=lambda mode: LiveRules(),
    media=MediaJobs(image_provider=FailOnce()))
with VisionServer(('127.0.0.1', 0), app) as server:
    print('PORT', server.server_port, flush=True)
    server.serve_forever()
`], {cwd:path.join(__dirname, '..'), stdio:['ignore', 'pipe', 'pipe']});
  let attempts = 0, stderr = '';
  fixture.stderr.on('data', data => {stderr += data;});
  const lines = createInterface({input:fixture.stdout});
  try {
    const port = await new Promise((resolve, reject) => {
      lines.on('line', line => {
        if (line.startsWith('PORT ')) resolve(Number(line.slice(5)));
        if (line.startsWith('ATTEMPT ')) attempts = Number(line.slice(8));
      });
      fixture.on('exit', () => reject(new Error(stderr || 'Fixture exited')));
      fixture.on('error', reject);
    });
    const replies = [];
    const h = await harness(async (url, options) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, options);
      replies.push({url, body:await response.clone().json()});
      return response;
    });
    let completed = 0;
    const settlePictures = async () => {
      for (let turn = 0; turn < 100; turn++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        for (const [id, timer] of [...h.timers]) {
          if (timer.ms !== 750) continue;
          h.timers.delete(id);
          await timer.callback();
        }
        while (completed < h.shows.length) h.shows[completed++].onComplete();
        if (h.element('loading').hidden || !h.element('retryMedia').hidden) return;
      }
      assert.fail('Media did not settle');
    };
    await h.start();
    await h.submit('paper');
    await settlePictures();
    assert.equal(h.element('retryMedia').hidden, false);
    assert.equal(h.element('send').disabled, true);
    assert.equal(attempts, 1, JSON.stringify(replies));
    await h.element('retryMedia').onclick();
    await settlePictures();
    assert.equal(h.element('loading').hidden, true, 'Retry must replace the failed job and display the next picture');
    assert.equal(h.element('send').disabled, false);
    assert.equal(attempts, 2, 'One deliberate retry starts exactly one replacement generation');
  } finally {
    lines.close();
    if (fixture.exitCode === null) { fixture.kill(); await once(fixture, 'exit'); }
  }
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

test('exhausted retries or missing generation cannot leave a useless retry button', async () => {
  for (const unavailable of [false, true]) {
    const h = await harness(); await h.start();
    const next = accepted(); h.settings.answer = next;
    h.settings.media = imageResult(next, {status:'failed', generated:false, generationRequested:!unavailable,
      generationRetryAvailable:false, retriesRemaining:0, image:null});
    await h.submit();
    assert.equal(h.element('retryMedia').hidden, true);
    assert.equal(h.element('retryMedia').disabled, true);
    assert.match(h.element('status').textContent, /▶/);
    const count = h.calls.length;
    await h.element('retryMedia').onclick();
    assert.equal(h.calls.length, count);
    assert.equal(h.element('send').disabled, true, 'A recovery message cannot skip the picture gate');
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

test('page arrows revisit matching text and art without submitting old answers or generating again', async () => {
  const h = await harness();
  assert.equal(h.element('previousPage').disabled, true);
  await h.element('nextPage').onclick(); await flush();
  assert.equal(h.element('previousPage').disabled, true);
  const oldChoice = h.element('choices').children[0];
  const next = accepted('mock'); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit();
  assert.equal(h.element('previousPage').disabled, false, 'Manual navigation can interrupt the picture gate');
  h.shows.at(-1).onComplete();
  h.element('answer').value = 'my unfinished prediction';
  const calls = h.calls.length;
  h.element('previousPage').onclick();
  assert.equal(h.shows.at(-1).url, 'img/intro.jpg');
  assert.equal(h.element('question').textContent, 'What material?', 'Manual navigation must not wait for decoding');
  assert.equal(h.element('nextPage').disabled, false);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('freeInput').hidden, true);
  assert.equal(h.element('choices').hidden, true);
  assert.equal(h.element('language').disabled, true);
  assert.equal(h.narrations.at(-1).lines[0].text, 'The story begins.');
  await h.submit('straw'); await oldChoice.onclick(); await h.element('mic').onclick();
  assert.equal(h.calls.length, calls);
  h.element('nextPage').onclick();
  assert.equal(h.shows.at(-1).url, '/prototype/img/paper_house.jpg');
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.element('answer').value, 'my unfinished prediction');
  assert.equal(h.element('send').disabled, false);
  assert.equal(h.calls.length, calls, 'Revisiting must make no server requests');
  h.settings.advance = accepted('mock', {version:2, sceneId:'house1_reflect',
    question:{...next.question, id:'house1_reflect', text:'Why did it happen?'},
    diagnostics:{manualNavigation:{skippedPicture:true, skippedQuestion:true, defaultChoice:'Blow away'}}});
  await h.element('nextPage').onclick();
  assert.equal(h.element('question').textContent, 'Why did it happen?');
  assert.equal(h.calls.filter(call => call.url === '/api/advance').length, 1);
});

test('history preserves choice locks, keeps only one entry per scene and resets on restart', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit(); h.shows.at(-1).onComplete();
  h.settings.recordError = new Error('denied'); await h.element('mic').onclick();
  h.settings.language = {...next, version:2, language:'ko', diagnostics:{languageChanged:true}};
  h.element('language').value = 'ko'; await h.element('language').onchange();
  h.element('previousPage').onclick(); h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What material?', 'Language changes do not add history pages');
  assert.equal(h.element('language').value, 'en');
  h.element('nextPage').onclick(); h.shows.at(-1).onComplete();
  assert.equal(h.element('language').value, 'ko');
  assert.equal(h.element('choices').hidden, false);
  assert.equal(h.element('freeInput').hidden, true);
  assert.equal(h.element('nextPage')['aria-label'], '다음 장면');
  h.element('previousPage').onclick();
  const late = h.shows.at(-1);
  await h.element('restart').onclick();
  late.onComplete();
  assert.equal(h.element('previousPage').disabled, true);
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.calls.filter(call => call.url === '/api/sessions').at(-1).body.language, 'ko');
});

test('page navigation handles image failure and ending boundaries without changing server progress', async () => {
  const h = await harness(); await h.start();
  const ending = accepted('live', {sceneId:'ending', question:null, decision:'complete'});
  h.settings.answer = ending; h.settings.media = imageResult(ending);
  await h.submit(); h.shows.at(-1).onComplete();
  assert.equal(h.element('nextPage').disabled, true);
  h.element('previousPage').onclick();
  h.shows.at(-1).onError();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('nextPage').disabled, false);
  assert.equal(h.element('previousPage').disabled, true);
  assert.equal(h.element('pictureNotice').hidden, false, 'Broken art is replaced by an explicit notice');
  assert.equal(h.element('nextPage').disabled, false);
  h.element('nextPage').onclick(); h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'The End');
  assert.equal(h.element('nextPage').disabled, true);
});

test('next interrupts running or failed pictures and immediately opens the approved next page', async () => {
  for (const failed of [false, true]) {
    const h = await harness(); await h.start();
    const next = accepted(); h.settings.answer = next;
    h.settings.media = imageResult(next, {status:failed ? 'failed' : 'running', image:null, generated:false});
    await h.submit();
    assert.equal(h.element('nextPage').disabled, false, 'A picture must never trap manual navigation');
    await h.element('nextPage').onclick(); await flush();
    assert.equal(h.element('question').textContent, next.question.text);
    assert.equal(h.element('loading').hidden, true);
    assert.equal(h.element('send').disabled, false);
    assert.equal(h.calls.filter(call => call.url === '/api/media/cancel').length, 1);
    assert.match(h.element('status').textContent, /picture/i, 'Skipped art must be explained');
  }
});

test('next cancels image decoding and ignores its late success without mixing text and pictures', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit();
  const decoding = h.shows.at(-1);
  await h.element('nextPage').onclick();
  assert.equal(h.element('question').textContent, next.question.text);
  assert.equal(h.element('imgCur').hidden, true);
  assert.equal(h.element('pictureNotice').hidden, false);
  decoding.onComplete();
  assert.equal(h.element('imgCur').hidden, true, 'Cancelled bytes cannot replace the skipped picture');
  assert.equal(h.calls.filter(call => call.url === '/api/media/jobs').length, 1);
});

test('previous can interrupt a pending first picture and revisit that skipped page without generating again', async () => {
  const h = await harness(); await h.start();
  const next = accepted(); h.settings.answer = next;
  const waiting = deferred(); h.settings.media = waiting.promise;
  await h.submit();
  h.element('previousPage').onclick();
  assert.equal(h.element('question').textContent, 'What material?');
  const reads = h.narrations.length;
  waiting.resolve(imageResult(next)); await flush();
  assert.equal(h.narrations.length, reads);
  h.element('nextPage').onclick();
  assert.equal(h.element('question').textContent, next.question.text);
  assert.equal(h.element('send').disabled, false);
  assert.equal(h.calls.filter(call => call.url === '/api/media/jobs').length, 1);
});

test('next interrupts recording or transcription and prevents late recognized words from touching the new page', async () => {
  for (const activity of ['recording', 'transcription']) {
    const h = await harness(); await h.start();
    const result = deferred();
    if (activity === 'recording') h.settings.recording = {stop() {h.voiceCalls.push('stop');}, done:result.promise};
    else h.settings.transcription = result;
    const recording = h.element('mic').onclick(); await flush();
    assert.equal(h.element('nextPage').disabled, false);
    await h.element('nextPage').onclick();
    result.resolve(activity === 'recording' ? {blob:{size:10}} : 'late words');
    await recording;
    assert.equal(h.element('question').textContent, 'What will happen?');
    assert.equal(h.element('answer').value, '');
    assert.equal(h.calls.filter(call => call.url === '/api/answer').length, 0);
    assert.equal(h.calls.filter(call => call.url === '/api/media/jobs').length, 0);
    assert.equal(h.element('send').disabled, false);
  }
});

test('next supersedes a pending story answer, reuses rapid navigation requests and ignores late responses', async () => {
  const h = await harness(); await h.start();
  const slow = deferred(), fast = deferred();
  h.settings.answer = slow.promise;
  const answering = h.submit('cookies'); await flush();
  const oldRequest = h.calls.find(call => call.url === '/api/answer');
  h.settings.advance = fast.promise;
  const first = h.element('nextPage').onclick();
  const second = h.element('nextPage').onclick();
  assert.equal(oldRequest.signal.aborted, true);
  const turns = h.calls.filter(call => call.url === '/api/advance');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].body.requestId, turns[1].body.requestId);
  fast.resolve(accepted('live', {diagnostics:{manualNavigation:{skippedPicture:true, defaultChoice:'Paper'}}}));
  await Promise.all([first, second]);
  slow.resolve(accepted('live', {lines:[{text:'A late cookie house.'}]}));
  await answering;
  assert.equal(h.element('narrative').children[0].textContent, 'A new paper house.');
  assert.equal(h.calls.filter(call => call.url === '/api/media/jobs').length, 0);
  assert.equal(h.element('send').disabled, false);
});

test('the first page waits for every narration line and its question before displaying or speaking', async () => {
  const h = await harness(), voice = deferred();
  h.settings.scenePreparation = voice;
  await h.start();
  assert.equal(h.element('question').textContent, '');
  assert.equal(h.narrations.length, 0);
  assert.equal(h.element('send').disabled, true);
  assert.equal(h.element('book').dataset.state, 'VOICING');
  assert.equal(h.prefetched.at(-1).lines.at(-1).text, 'What material?');
  const asset = {ready:true, allLines:true};
  voice.resolve(asset); await flush();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.narrations.length, 1);
  assert.equal(h.narrations[0].options.scene, true);
  assert.equal(h.narrations[0].options.prepared, asset);
});

test('next picture decoding and whole-page voice prepare in parallel but reveal together', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(), next = accepted();
  h.settings.scenePreparation = voice;
  h.settings.answer = next; h.settings.media = imageResult(next);
  const reads = h.narrations.length;
  await h.submit();
  assert.equal(h.shows.at(-1).url, '/api/media/images/picture?sessionId=session-1');
  h.shows.at(-1).onComplete();
  assert.equal(h.reveals.length, 0, 'Decoded image must stay hidden while a later voice line is pending');
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.narrations.length, reads);
  assert.equal(h.element('send').disabled, true);
  voice.resolve({ready:true}); await flush();
  assert.equal(h.reveals.length, 1);
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.narrations.length, reads + 1);
  assert.equal(h.narrations.at(-1).options.scene, true);
});

test('a ready complete voice still waits for the next picture before committing the page', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(), next = accepted();
  h.settings.scenePreparation = voice;
  h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit();
  voice.resolve({ready:true}); await flush();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('send').disabled, true);
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What will happen?');
});

test('restart aborts a pending whole-page voice and rejects its late completion', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(), next = accepted();
  h.settings.scenePreparation = voice;
  h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit();
  const signal = h.prefetched.at(-1).options.signal;
  const picture = h.shows.at(-1);
  h.settings.scenePreparation = null;
  await h.element('restart').onclick(); await flush();
  assert.equal(signal.aborted, true);
  const reads = h.narrations.length;
  voice.resolve({ready:true}); picture.onComplete(); await flush();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.narrations.length, reads);
});

test('manual next skips a picture wait but still waits for the complete page voice', async () => {
  const h = await harness(); await h.start();
  const oldVoice = deferred(), next = accepted();
  h.settings.scenePreparation = oldVoice;
  h.settings.answer = next; h.settings.media = imageResult(next, {status:'running', image:null, generated:false});
  await h.submit();
  const voice = deferred(); h.settings.scenePreparation = voice;
  await h.element('nextPage').onclick(); await flush();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('send').disabled, true);
  voice.resolve({ready:true}); await flush();
  assert.equal(h.element('question').textContent, next.question.text);
  const reads = h.narrations.length;
  oldVoice.resolve({ready:true}); await flush();
  assert.equal(h.narrations.length, reads);
  assert.equal(h.calls.filter(call => call.url === '/api/advance').length, 0);
});

test('voice changes, translations and history prepare their own full passage', async () => {
  const h = await harness(); await h.start();
  h.settings.voices = [{id:'dad', name:'Dad'}];
  await h.element('settingsButton').onclick();
  let voice = deferred(); h.settings.scenePreparation = voice;
  const reads = h.narrations.length;
  h.element('voiceSelect').value = 'dad'; h.element('voiceSelect').onchange();
  assert.equal(h.element('send').disabled, true);
  assert.equal(h.narrations.length, reads);
  voice.resolve({ready:true, voice:'dad'}); await flush();
  assert.equal(h.narrations.at(-1).options.prepared.voice, 'dad');

  voice = deferred(); h.settings.scenePreparation = voice;
  h.settings.language = state('live', {version:1, language:'ko',
    question:{...state().question, text:'무엇으로 지을까요?'}, diagnostics:{languageChanged:true}});
  h.element('language').value = 'ko'; await h.element('language').onchange();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.prefetched.at(-1).options.language, 'ko');
  voice.resolve({ready:true, language:'ko'}); await flush();
  assert.equal(h.element('question').textContent, '무엇으로 지을까요?');

  h.settings.scenePreparation = null;
  const next = accepted('mock', {version:2, language:'ko'});
  h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit(); h.shows.at(-1).onComplete();
  h.expireSceneCache();
  voice = deferred(); h.settings.scenePreparation = voice;
  h.element('previousPage').onclick();
  assert.equal(h.element('question').textContent, 'What will happen?');
  voice.resolve({ready:true}); await flush();
  assert.equal(h.element('question').textContent, '무엇으로 지을까요?');
});

test('voice failure offers explicit retry and muting can release the pending page', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(), next = accepted();
  h.settings.scenePreparation = voice;
  h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit(); h.shows.at(-1).onComplete();
  voice.reject(new Error('voice failed')); await flush();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('retryMedia').hidden, false);
  assert.match(h.element('retryMedia').textContent, /voice/i);
  const retry = deferred(); h.settings.scenePreparation = retry;
  h.element('retryMedia').onclick();
  assert.equal(h.prefetched.at(-1).options.retry, true);
  const reads = h.narrations.length;
  h.element('readAloud').checked = false; h.element('readAloud').onchange();
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.element('send').disabled, false);
  retry.resolve({ready:true}); await flush();
  assert.equal(h.narrations.length, reads, 'A late prepared voice never starts after muting');
});

test('replay asks the authoritative cache and prepares again after a page is evicted', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(); h.settings.scenePreparation = voice;
  h.expireSceneCache(); h.playback('idle');
  const reads = h.narrations.length;
  h.element('playNarration').onclick();
  assert.equal(h.narrations.length, reads);
  assert.equal(h.element('send').disabled, true);
  voice.resolve({ready:true, fresh:true}); await flush();
  assert.equal(h.narrations.length, reads + 1);
  assert.equal(h.narrations.at(-1).options.prepared.fresh, true);
});

test('a failed prepared playback exposes retry instead of leaving a silently idle page', async () => {
  const h = await harness(); await h.start();
  h.settings.speakError = new Error('local audio failed'); h.playback('idle');
  h.element('playNarration').onclick(); await flush();
  assert.equal(h.element('retryMedia').hidden, false);
  assert.match(h.element('retryMedia').textContent, /voice/i);
  assert.equal(h.element('send').disabled, true);
  h.settings.speakError = null;
  const voice = deferred(); h.settings.scenePreparation = voice;
  h.element('retryMedia').onclick();
  assert.equal(h.prefetched.at(-1).options.retry, true);
  voice.resolve({ready:true, retried:true}); await flush();
  assert.equal(h.narrations.at(-1).options.prepared.retried, true);
  assert.equal(h.element('send').disabled, false);
});

test('whole-page progress and timeout belong only to the active preparation attempt', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(), next = accepted();
  h.settings.scenePreparation = voice;
  h.settings.answer = next; h.settings.media = imageResult(next);
  await h.submit();
  const options = h.prefetched.at(-1).options;
  options.onProgress({ready:2, total:5});
  assert.match(h.element('loadingText').textContent, /2\/5/);
  const timer = [...h.timers.values()].find(entry => entry.ms === 180000);
  assert.ok(timer);
  timer.callback();
  assert.equal(h.element('retryMedia').hidden, false);
  assert.equal(options.signal.aborted, true);
  const failureText = h.element('loadingText').textContent;
  options.onProgress({ready:5, total:5});
  assert.equal(h.element('loadingText').textContent, failureText);
  h.settings.scenePreparation = null;
  await h.element('restart').onclick(); await flush();
  const newText = h.element('loadingText').textContent;
  options.onProgress({ready:3, total:5});
  voice.resolve({ready:true}); await flush();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('loadingText').textContent, newText);
});

test('a recovery choice is touchable before speech is prepared but the resulting new page still waits', async () => {
  const h = await harness(); await h.start();
  const voice = deferred(); h.settings.scenePreparation = voice;
  const preparations = h.prefetched.length;
  h.settings.answer = state('live', {version:1, decision:'clarify', choiceMode:true,
    lines:[{speakerId:'narrator', text:'Tap one of the choices.'}]});
  await h.submit('unclear');
  assert.equal(h.prefetched.length, preparations, 'The same-question recovery never waits for a whole-page voice');
  assert.equal(h.element('choices').hidden, false);
  assert.ok(h.element('choices').children.every(button => !button.disabled));
  assert.equal(h.narrations.at(-1).options.scene, undefined, 'Only the short choice invitation uses the legacy path');
  const next = accepted('live', {version:2});
  h.settings.answer = next; h.settings.media = preparedChoiceResult(next);
  await h.element('choices').children[0].onclick(); await flush();
  h.shows.at(-1).onComplete();
  assert.equal(h.element('question').textContent, 'What material?');
  assert.equal(h.element('send').disabled, true);
  voice.resolve({ready:true}); await flush();
  assert.equal(h.element('question').textContent, 'What will happen?');
  assert.equal(h.narrations.at(-1).options.scene, true);
});

test('an external voice change turns both a stale success and failure into recoverable preparation', async () => {
  for (const fail of [false, true]) {
    const h = await harness(); await h.start();
    const voice = deferred(), next = accepted();
    h.settings.scenePreparation = voice;
    h.settings.answer = next; h.settings.media = imageResult(next);
    await h.submit(); h.shows.at(-1).onComplete();
    const reads = h.narrations.length;
    h.settings.voiceId = 'another-window-voice'; // the storage-backed getter changes without selectVoice()
    if (fail) voice.reject(new Error('scene_voice_changed'));
    else voice.resolve({ready:true, staleVoice:true});
    await flush();
    assert.equal(h.narrations.length, reads);
    assert.equal(h.element('question').textContent, 'What material?');
    assert.equal(h.element('retryMedia').hidden, false);
    assert.match(h.element('retryMedia').textContent, /voice/i);
    h.element('readAloud').checked = false; h.element('readAloud').onchange();
    assert.equal(h.element('question').textContent, 'What will happen?');
    assert.equal(h.element('send').disabled, false);
  }
});

test('an outcome picture remains covered until its spoken action sentence starts', async () => {
  const h = await harness(null, {withMotion:true});
  await h.start('mock');
  const build = accepted('mock', {mediaPlan:{action:'build'}});
  h.settings.answer = build;
  h.settings.media = imageResult(build, {generated:false, generationRequested:false});
  await h.submit('paper');
  h.shows.at(-1).onComplete();

  const outcome = state('mock', {version:2, sceneId:'house1_reflect', decision:'accept',
    mediaPlan:{action:'eaten'}, lines:[{speakerId:'narrator', text:'The wolf smelled the cookie. Then he ate the wall.'}]});
  h.settings.answer = outcome;
  h.settings.media = imageResult(outcome, {generated:false, generationRequested:false});
  await h.submit('the wolf will eat it');
  h.shows.at(-1).onComplete();
  assert.ok(h.element('art').children.some(child => child.className === 'story-cue-cover'));
  assert.equal(h.element('answer').disabled, true);
  const spoken = h.narrations.at(-1).options.onSentence;
  spoken(0, 'The wolf smelled the cookie.');
  assert.equal(h.element('answer').disabled, true);
  spoken(0, 'Then he ate the wall.');
  const fade = [...h.timers.values()].find(timer => timer.ms === 280);
  assert.ok(fade);
  fade.callback();
  assert.equal(h.element('answer').disabled, false);
  assert.equal(h.element('art').children.some(child => child.className === 'story-cue-cover'), false);
});
