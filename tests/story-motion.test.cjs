const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function load() {
  const sandbox = {Promise, JSON, Math};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'prototype/story-motion.js'), 'utf8') + '\n;this.StoryMotion = StoryMotion;', sandbox);
  return sandbox.StoryMotion;
}

test('the event starts on the first narrated line that names it, in English and Korean', () => {
  const StoryMotion = load();
  assert.equal(StoryMotion.cueLine('blown_away', ['You guessed it might fly.', 'The wolf puffed, and the straw shook.', 'It blew away.']), 1);
  assert.equal(StoryMotion.cueLine('blown_away', ['네 생각이 멋져.', '늑대가 후 불자 짚이 흔들렸어요.']), 1);
  assert.equal(StoryMotion.cueLine('melted', ['The sun was warm.', 'The ice cream got soft.']), 0);
  assert.equal(StoryMotion.cueLine('eaten', ['Yum.', '늑대가 과자 벽을 냠냠 먹었어요.']), 1);
});

test('without a naming line the event still plays during the last story line, and pages without events at the start', () => {
  const StoryMotion = load();
  assert.equal(StoryMotion.cueLine('stood', ['A good guess.', 'Nothing moved.']), 1);
  assert.equal(StoryMotion.cueLine('move_to_next_house', ['The pigs run to the next house.']), 0);
  assert.equal(StoryMotion.cueLine('safe_ending', ['Everyone is safe.', 'The End.']), 0);
  assert.equal(StoryMotion.cueLine('build', []), null);
});

test('the motion layer covers exactly the drawn picture of a contained or cropped image', () => {
  const StoryMotion = load();
  const plain = rect => JSON.parse(JSON.stringify(rect));
  // A 3:2 picture in a tall box is letterboxed top and bottom.
  assert.deepEqual(plain(StoryMotion.contentRect(300, 400, 1024, 683, 'contain', '50% 50%')),
    {x: 0, y: (400 - 300 * 683 / 1024) / 2, width: 300, height: 300 * 683 / 1024});
  // In a wide box it is pillarboxed left and right.
  assert.deepEqual(plain(StoryMotion.contentRect(900, 300, 1024, 683, 'contain', '50% 50%')),
    {x: (900 - 300 * 1024 / 683) / 2, y: 0, width: 300 * 1024 / 683, height: 300});
  // Cover with a 60% vertical position keeps the same anchor as the CSS.
  const cover = StoryMotion.contentRect(300, 300, 1024, 683, 'cover', '50% 60%');
  assert.equal(cover.height, 300);
  assert.equal(cover.y, 0);
  assert.ok(Math.abs(cover.x - (300 - 300 * 1024 / 683) * 0.5) < 1e-9);
  assert.deepEqual(plain(StoryMotion.contentRect(300, 200, 0, 0)), {x: 0, y: 0, width: 300, height: 200});
});

test('a cue plays the event once per reading; a new reading of the page plays it again', () => {
  const StoryMotion = load();
  const motion = new StoryMotion({}, {reducedMotion: () => false});
  const played = [];
  motion.play = active => { active.played = true; played.push(active.cueKey); };
  motion.active = {cue: 1, played: false, cueKey: null, video: false};
  motion.cue(0, 'read-1');
  assert.deepEqual(played, [], 'an earlier line does not start the event');
  motion.cue(1, 'read-1');
  motion.cue(1, 'read-1');
  assert.deepEqual(played, ['read-1']);
  motion.cue(0, 'read-2');
  motion.cue(1, 'read-2');
  assert.deepEqual(played, ['read-1', 'read-2']);
});

test('a page whose narration is already past the event line catches up instead of skipping it', () => {
  const StoryMotion = load();
  const motion = new StoryMotion({}, {reducedMotion: () => false});
  const played = [];
  motion.play = active => { active.played = true; played.push(active.cueKey); };
  motion.active = {cue: 1, played: false, cueKey: null, video: false};
  motion.cue(0, 'back', {catchUp: true});
  assert.deepEqual(played, [], 'not before its line');
  motion.cue(2, 'back', {catchUp: true});
  assert.deepEqual(played, ['back']);
  motion.cue(1, 'back');
  assert.deepEqual(played, ['back'], 'the same reading does not play it twice');
});

test('a reviewed video clip shows the event instead of the preset', () => {
  const StoryMotion = load();
  const motion = new StoryMotion({}, {reducedMotion: () => false});
  let played = 0;
  motion.play = () => { played += 1; };
  motion.active = {cue: 0, played: false, cueKey: null, video: true};
  motion.cue(0, 'read');
  assert.equal(played, 0);
});

test('reduced motion adds nothing to the page', () => {
  const StoryMotion = load();
  let asked = false;
  const motion = new StoryMotion({}, {reducedMotion: () => true, current: () => { asked = true; return {}; }});
  motion.scene({action: 'blown_away', lines: ['The wolf puffed.']});
  assert.equal(motion.active, null);
  assert.equal(asked, false);
});

test('every server action that changes a house has a preset, and both reader pages load the motion layer', () => {
  const StoryMotion = load();
  for (const action of ['build', 'blown_away', 'collapsed', 'eaten', 'melted', 'stood', 'move_to_next_house', 'safe_ending'])
    assert.equal(typeof StoryMotion.PRESETS[action], 'function', action);
  for (const page of ['index.html', 'live.html']) {
    const html = fs.readFileSync(path.join(root, 'prototype', page), 'utf8');
    assert.ok(html.indexOf('story-motion.js') > 0 && html.indexOf('story-motion.js') < html.indexOf('live-book.js'), page);
  }
});

test('every SAM region in the manifest points at a prepared picture and a WebP sprite that exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'prototype/img/motion/regions.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'media/scene_registry.json'), 'utf8'));
  const files = new Set(Object.values(registry.images).map(entry => entry.file));
  assert.ok(Object.keys(manifest.images).length > 0);
  for (const [file, record] of Object.entries(manifest.images)) {
    assert.ok(files.has(file), file);
    const [width, height] = record.size;
    for (const object of record.objects) {
      assert.ok(['wolf', 'pig', 'house'].includes(object.label));
      assert.match(object.sprite, /^motion\/.+\.webp$/);
      assert.ok(fs.existsSync(path.join(root, 'prototype/img', object.sprite)), object.sprite);
      const [x1, y1, x2, y2] = object.spriteBox;
      assert.ok(0 <= x1 && x1 < x2 && x2 <= width && 0 <= y1 && y1 < y2 && y2 <= height, `${file} ${object.label}`);
    }
  }
});
