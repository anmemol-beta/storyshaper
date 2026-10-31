const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../prototype/voice-train.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

function harness({oldClip = false} = {}) {
  const elements = new Map();
  const node = () => ({value: '', hidden: false, disabled: false, textContent: '', dataset: {}, style: {},
    classList: {add() {}, remove() {}, toggle() {}}, setAttribute() {}, replaceChildren() {}, append() {}});
  const $ = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  $('speakerFilter').value = 'all'; $('practiceMode').value = 'story';
  const langs = ['en', 'ko'].map(lang => ({...node(), dataset: {lang}}));
  const sample = {id: 'story-line', n: 2001, text: 'I am going to build a house!', speakerId: 'pig1', kind: 'dialogue',
    tone: 'lively', emotion: 'excited', personality: ['eager'], speechStyle: 'Bright short sentences.',
    recordingPrompt: 'Read as the oldest pig, feeling excited.'};
  const revision = 'current-script';
  let clip = {n: 2001, text: sample.text, source: 'script', seconds: 2, match: .99,
    desiredPerformance: {scriptLineId: sample.id, revision: oldClip ? 'old-script' : revision}, performanceReview: 'unreviewed'};
  const requests = [], audio = [], recorders = [];
  const context = {
    URLSearchParams, location: {search: '?lang=en'}, Blob, encodeURIComponent,
    URL: {createObjectURL: () => 'blob:new-recording'},
    localStorage: {getItem: key => key === 'story-voice' ? 'abcdef123456' : null, setItem() {}},
    document: {getElementById: $, documentElement: {}, body: {}, title: '', createElement: node,
      querySelectorAll: selector => selector === '[data-lang]' ? langs : [], addEventListener() {}},
    navigator: {mediaDevices: {getUserMedia: async () => ({getTracks: () => [{stop() {}}]})}},
    setTimeout: callback => { callback(); },
    Audio: class {
      constructor(url) { this.url = url; audio.push(this); }
      async play() {} pause() { this.paused = true; }
    },
    MediaRecorder: class {
      constructor() { recorders.push(this); }
      start() {}
      stop() { this.ondataavailable({data: new Blob(['audio'], {type: 'audio/wav'})}); return this.onstop(); }
    },
    fetch: async (url, options = {}) => {
      requests.push({url, options});
      let body;
      if (url === 'audio/training-sentences.json') body = [{n: 1, text: 'A usual English sentence.'}];
      else if (url.includes('/api/voice/training-script')) body = {revision, samples: [sample]};
      else if (url.endsWith('/train')) body = {clips: [clip], sample: null};
      else if (options.headers?.['Content-Type'] === 'application/json') { clip = {...clip, performanceReview: 'confirmed'}; body = clip; }
      else { clip = {...clip, desiredPerformance: {scriptLineId: sample.id, revision}, performanceReview: 'unreviewed'}; body = clip; }
      return {ok: true, json: async () => body};
    },
  };
  vm.runInNewContext(source, context);
  return {$, langs, requests, audio, recorders, sample};
}

test('story practice shows personality and emotion, and only confirms after completed listening', async () => {
  const h = harness(); await flush();
  assert.equal(h.$('num').textContent, 'Sentence 1 of 1');
  assert.match(h.$('performanceDirection').textContent, /oldest pig.*excited/);
  assert.match(h.$('personality').textContent, /eager.*Bright short sentences/);
  assert.equal(h.$('reviewPerformance').disabled, true);
  await h.$('listen').onclick();
  assert.equal(h.$('reviewPerformance').disabled, true);
  h.audio[0].onended();
  assert.equal(h.$('reviewPerformance').disabled, false);
  await h.$('reviewPerformance').onclick();
  assert.equal(h.$('reviewPerformance').hidden, true);
  const review = h.requests.find(r => r.options.headers?.['Content-Type'] === 'application/json');
  assert.deepEqual(JSON.parse(review.options.body), {performanceReviewed: true});
});

test('a stale story recording is not skipped, counted or shown as reviewed', async () => {
  const h = harness({oldClip: true}); await flush();
  assert.equal(h.$('listen').hidden, true);
  assert.equal(h.$('reviewPerformance').hidden, true);
  assert.match(h.$('count').textContent, /^0 of 1/);
  assert.equal(h.$('hint').textContent, 'Tap the button and read the sentence.');
});

test('late audio completion cannot approve a replacement recording, and upload uses server script identity', async () => {
  const h = harness(); await flush();
  await h.$('listen').onclick();
  const oldEnded = h.audio[0].onended;
  await h.$('rec').onclick();
  assert.equal(h.audio[0].paused, true);
  assert.equal(h.$('practiceMode').disabled, true);
  await h.$('rec').onclick();
  await flush();
  oldEnded();
  assert.equal(h.$('reviewPerformance').disabled, true);
  const upload = h.requests.find(r => r.options.body instanceof Blob);
  assert.match(upload.url, /train\/2001\?scriptLineId=story-line&revision=current-script$/);
  assert.equal(h.$('practiceMode').disabled, false);
});

test('the historical general English practice remains selectable', async () => {
  const h = harness(); await flush();
  h.$('practiceMode').value = 'general'; h.$('practiceMode').onchange();
  assert.equal(h.$('sentence').textContent, 'A usual English sentence.');
  assert.equal(h.$('performanceDirection').hidden, true);
  assert.equal(h.$('speakerFilterLabel').hidden, true);
});
