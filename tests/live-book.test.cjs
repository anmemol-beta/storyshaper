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
function preparedChoiceResult(snapshot, overrides = {}) {
  return imageResult(snapshot, {source:'prepared_choice', generated:false, generationRequested:false,
    generationRetryAvailable:false, retriesRemaining:0, reason:'prepared_choice_image',
    image:{url:'/prototype/img/paper_house.jpg'}, ...overrides});
}

async function harness(request = null) {
  const elements = new Map(), calls = [], shows = [], timers = new Map(), voiceCalls = [], narrations = [], cameraCalls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('mode').options = [new Element(), new Element()];
  const voiceSetupCalls = [];
  const settings = {answer:null, language:null, media:null, session:null, transcript:'paper', recordError:null, voiceName:null,
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
    Narration:{stop() {}, voiceName:() => settings.voiceName, warm:() => voiceSetupCalls.push('warm'),
      interject:language => voiceSetupCalls.push(language), speak:(lines, options) => {
      narrations.push({lines, options}); return new Promise(() => {});
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
  return {element, calls, settings, shows, timers, voiceCalls, narrations, cameraCalls, voiceSetupCalls, document, start, submit};
}

test('merged parent voice registration, return links and warmup remain available in the child reader', async () => {
  const h = await harness();
  assert.equal(h.element('addVoice').hidden, false);
  assert.equal(h.element('addVoice').href, 'voice.html?return=index.html&lang=en');
  assert.deepEqual(h.voiceSetupCalls, ['warm']);
  h.settings.voiceName = 'Mom';
  h.element('language').value = 'ko';
  await h.element('language').onchange();
  assert.equal(h.element('addVoice').hidden, true);
  assert.match(h.element('readerName').textContent, /Mom/);
  assert.equal(h.element('changeVoice').href, 'voice.html?return=index.html&lang=ko');
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
    assert.match(h.element('status').textContent, /restart/i);
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
