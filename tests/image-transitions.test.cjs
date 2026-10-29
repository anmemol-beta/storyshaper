const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(reducedMotion = false) {
  const timers = new Map();
  let id = 0;
  const context = vm.createContext({
    matchMedia: () => ({matches: reducedMotion}),
    setTimeout: callback => { timers.set(++id, callback); return id; },
    clearTimeout: key => timers.delete(key)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype/image-transitions.js'), 'utf8'), context);
  const Controller = vm.runInContext('StoryImageTransition', context);
  const image = src => {
    const classes = new Set();
    return {src, complete: false, naturalWidth: 0,
      getAttribute: function () { return this.src; },
      classList: {add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n)}};
  };
  const current = image('old.jpg'), next = image('old.jpg');
  const controller = new Controller(current, next);
  function load() {
    controller.next.naturalWidth = 1024;
    controller.next.complete = true;
    controller.next.onload();
  }
  function flush() { for (const callback of [...timers.values()]) callback(); }
  return {controller, current, next, load, flush, timers};
}

test('new bitmap is decoded before fading, and completion swaps layers without changing visible src', () => {
  const h = harness();
  let decoded, completed = 0;
  h.next.decode = () => ({then: callback => { decoded = callback; }});
  h.controller.show('new.jpg', {onComplete: () => completed++});
  assert.equal(h.current.src, 'old.jpg');
  h.load();
  assert.equal(h.next.classList.contains('is-entering'), false);
  decoded();
  assert.equal(h.next.classList.contains('is-entering'), true);
  const ended = h.next.ontransitionend;
  ended({target: h.next, propertyName: 'opacity'});
  assert.equal(h.controller.current, h.next);
  assert.equal(h.current.src, 'old.jpg', 'Never reload the visible layer during handoff');
  h.flush();
  assert.equal(completed, 1);
});

test('cancelled decode and stale load callbacks cannot display an older request', () => {
  const h = harness();
  let decoded;
  h.next.decode = () => ({then: callback => { decoded = callback; }});
  h.controller.show('stale.jpg');
  const oldLoad = h.next.onload;
  h.load();
  const staleDecode = decoded;
  h.controller.show('latest.jpg');
  oldLoad();
  staleDecode();
  assert.equal(h.controller.current.src, 'old.jpg');
  assert.equal(h.next.classList.contains('is-entering'), false);
  h.load();
  decoded();
  h.flush();
  assert.equal(h.controller.current.src, 'latest.jpg');
});

test('a failed image or a load timeout keeps the last good picture and calls fallback once', () => {
  for (const failure of ['error', 'timeout', 'decode']) {
    const h = harness();
    let errors = 0;
    h.controller.show('missing.jpg', {onError: () => errors++});
    const lateError = h.next.onerror;
    if (failure === 'error') lateError();
    else if (failure === 'timeout') h.flush();
    else {
      h.next.decode = () => ({then: (ready, failed) => failed()});
      h.load();
    }
    lateError();
    assert.equal(errors, 1);
    assert.equal(h.controller.current.src, 'old.jpg');
    assert.equal(h.next.classList.contains('is-entering'), false);
  }
});

test('rapid page changes settle the prepared layer but never run the old scene callback', () => {
  const h = harness();
  let oldDone = 0, newDone = 0;
  h.controller.show('first.jpg', {onComplete: () => oldDone++});
  h.load();
  const oldEnd = h.next.ontransitionend;
  h.controller.show('last.jpg', {onComplete: () => newDone++});
  assert.equal(h.controller.current.src, 'first.jpg');
  oldEnd({target: h.next, propertyName: 'opacity'});
  h.load();
  h.flush();
  assert.equal(h.controller.current.src, 'last.jpg');
  assert.equal(oldDone, 0);
  assert.equal(newDone, 1);
});

test('reduced motion and a repeated current picture complete without a fade delay', () => {
  const h = harness(true);
  let done = 0;
  h.controller.show('new.jpg', {onComplete: () => done++});
  h.load();
  assert.equal(h.controller.current.src, 'new.jpg');
  assert.equal(done, 1);
  h.controller.show('new.jpg', {onComplete: () => done++});
  assert.equal(done, 2);
  assert.equal(h.timers.size, 0);
});
