const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const flush = () => new Promise(setImmediate);
function setup() {
  const calls = [], states = [], shows = [], timers = new Map();
  let nextTimer = 0;
  const fetch = (url, options) => new Promise((resolve, reject) => {
    calls.push({url, options, resolve: data => resolve({ok:true, json:async () => data}), reject});
  });
  const transition = {cancel() {}, show:(url, options = {}) => shows.push({url, ...options})};
  const context = vm.createContext({AbortController, Date, setTimeout:(callback, ms) => {
    const id = ++nextTimer; timers.set(id, {callback, ms}); return id;
  }, clearTimeout:id => timers.delete(id)});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/story-media.js'), 'utf8'), context);
  const Player = vm.runInContext('StoryMediaPlayer', context);
  const player = new Player(null, null, {onState:state => states.push(state), fetch, transition});
  player.configure({mediaAvailable:true, imageGenerationAvailable:true});
  return {player, calls, states, shows, timers};
}
function snapshot(version = 1, changes = {}) {
  return {sessionId:'session', sceneId:`scene-${version}`, version, decision:'accept',
    mediaPlan:{serverOwned:true}, providerMode:'live', ...changes};
}
function result(state, changes = {}) {
  return {sessionId:state.sessionId, sceneId:state.sceneId, version:state.version,
    jobId:'job', status:'ready', apply:true, generated:true, generationRequested:true,
    source:'muse_image', image:{url:'/api/media/images/image?sessionId=session', reviewed:true}, ...changes};
}

test('one accepted answer posts only the binding and waits for image decode before declaring success', async () => {
  const {player, calls, states, shows} = setup();
  const state = snapshot();
  const pending = player.update(state);
  assert.equal(states.at(-1).state, 'generating');
  assert.deepEqual(JSON.parse(calls[0].options.body), {sessionId:'session', sceneId:'scene-1', version:1});
  calls[0].resolve(result(state));
  await pending;
  assert.equal(shows.length, 1);
  assert.equal(states.at(-1).state, 'generating');
  shows[0].onComplete();
  assert.equal(states.at(-1).state, 'generated');
  await player.update(state);
  assert.equal(calls.length, 1, 'Rendering a snapshot again must not submit paid work again');
});

test('polling uses GET and never resubmits generation after failure', async () => {
  const {player, calls, timers, states} = setup();
  const state = snapshot();
  const pending = player.update(state);
  calls[0].resolve(result(state, {status:'running', generated:false, image:null}));
  await pending;
  const timer = [...timers.values()].find(timer => timer.ms === 750);
  const poll = timer.callback();
  assert.match(calls[1].url, /^\/api\/media\/jobs\/job\?sessionId=session$/);
  assert.equal(calls[1].options.method, undefined);
  calls[1].reject(new Error('network error'));
  await poll;
  assert.equal(states.at(-1).state, 'failed');
  await player.update(state);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a late result from the previous answer cannot replace the new picture', async () => {
  const {player, calls, shows, states} = setup();
  const old = snapshot(), current = snapshot(2);
  const first = player.update(old), second = player.update(current);
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve(result(current));
  await second;
  shows[0].onComplete();
  calls[0].resolve(result(old));
  await first;
  assert.equal(shows.length, 1);
  assert.equal(states.at(-1).state, 'generated');
});

test('restarting cancels work and late image decode cannot relabel the new session', async () => {
  const {player, calls, shows, states} = setup();
  const state = snapshot();
  const pending = player.update(state);
  calls[0].resolve(result(state));
  await pending;
  player.reset();
  assert.equal(JSON.parse(calls[1].options.body).jobId, 'job');
  assert.equal(calls[1].url, '/api/media/cancel');
  shows[0].onComplete();
  assert.equal(states.at(-1).state, 'reference');
  assert.equal(shows.at(-1).url, 'img/intro.jpg');
});

test('translation rebinds the same scene without cancelling its server generation', async () => {
  const {player, calls} = setup();
  const state = snapshot();
  const first = player.update(state);
  calls[0].resolve(result(state, {status:'running', generated:false, image:null}));
  await first;
  const translated = snapshot(2, {sceneId:state.sceneId, diagnostics:{languageChanged:true}});
  const next = player.update(translated);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/media/jobs');
  calls[1].resolve(result(translated));
  await next;
});

test('a failed generation may show its prepared fallback with an honest label', async () => {
  const {player, calls, states, shows} = setup();
  const state = snapshot();
  const pending = player.update(state);
  calls[0].resolve(result(state, {status:'failed', generated:false, source:'local_assets',
    image:{url:'/prototype/img/paper_house.jpg'}}));
  await pending;
  shows[0].onComplete();
  assert.equal(states.at(-1).state, 'fallback');
});

test('offline illustrations are labelled prepared and rejected answers do not generate', async () => {
  const {player, calls, states, shows} = setup();
  const state = snapshot(1, {providerMode:'mock'});
  const pending = player.update(state);
  calls[0].resolve(result(state, {status:'fallback', generated:false, generationRequested:false,
    source:'local_assets', image:{url:'/prototype/img/paper_house.jpg'}}));
  await pending;
  shows[0].onComplete();
  assert.equal(states.at(-1).state, 'prepared');
  await player.update(snapshot(2, {decision:'redirect', mediaPlan:null}));
  assert.equal(states.at(-1).state, 'kept');
  assert.equal(calls.filter(call => call.url === '/api/media/jobs').length, 1);
});

test('mismatched bindings, external URLs and unreviewed generated pixels are never displayed', async () => {
  const state = snapshot();
  for (const changes of [{version:99}, {apply:false}, {sessionId:'other'},
    {image:{url:'https://external.example/image.jpg', reviewed:true}},
    {image:{url:'/api/media/images/image', reviewed:false}}]) {
    const {player, calls, states, shows} = setup();
    const pending = player.update(state);
    calls[0].resolve(result(state, changes));
    await pending;
    assert.equal(states.at(-1).state, 'failed');
    assert.equal(shows.length, 0);
  }
});

test('image load failure keeps the prior picture and reports failure', async () => {
  const {player, calls, states, shows} = setup();
  const state = snapshot(), pending = player.update(state);
  calls[0].resolve(result(state));
  await pending;
  shows[0].onError();
  assert.equal(states.at(-1).state, 'failed');
});
