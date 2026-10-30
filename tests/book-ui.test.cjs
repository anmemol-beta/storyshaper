const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.dataset = {};
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
    this.htmlWrites = [];
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name)
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join(''); }
  set innerHTML(value) { this.htmlWrites.push(value); this._text = String(value); this.children = []; }
  get innerHTML() { return this._text; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return name === 'src' ? this.src : this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(child) { return child === this || this.children.includes(child); }
  focus() { this.focused = true; }
}

function harness(language = 'en', narration = null) {
  let now = 1000, timerId = 0;
  const timers = new Map();
  function setTimeout(callback, delay = 0) {
    const id = ++timerId;
    timers.set(id, {at: now + Number(delay), callback});
    return id;
  }
  function tick(milliseconds) {
    const target = now + milliseconds;
    let count = 0;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++count < 10000, 'Timers must make progress');
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = target;
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('voice').checked = true;
  element('speed').value = '0.85';
  element('imgCur').src = 'img/intro.jpg';
  for (const id of ['imgCur', 'imgNext']) { element(id).complete = true; element(id).naturalWidth = 1024; }
  const root = new Element('html');
  const languageButtons = ['en', 'ko'].map(value => {
    const button = new Element('button');
    button.dataset.language = value;
    return button;
  });
  const document = {
    documentElement: root,
    getElementById: element,
    createElement: tag => new Element(tag),
    querySelector: selector => element(selector),
    querySelectorAll: selector => selector === '[data-language]' ? languageButtons : [],
    addEventListener() {}
  };
  const listeners = new Map(), audioElements = [], plays = [], speech = [];
  const speechSettings = {throwOnSpeak: false};
  class Audio {
    constructor() { this.duration = 7.1; this.pauses = 0; audioElements.push(this); }
    play() {
      const record = {audio: this, src: this.src, ended: this.onended, metadata: this.onloadedmetadata};
      plays.push(record);
      return {catch: callback => { record.reject = callback; }};
    }
    pause() { this.pauses++; }
  }
  const storage = new Map([['story-language', language]]);
  const context = vm.createContext({
    document, Audio, Image: class {}, URLSearchParams,
    ...(narration ? {Narration:narration} : {}),
    location: {search: ''},
    window: {addEventListener: (name, callback) => listeners.set(name, callback)},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    getComputedStyle: () => ({getPropertyValue: () => '#fff'}),
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {speak: utterance => {
      if (speechSettings.throwOnSpeak) throw new Error('Speech unavailable');
      speech.push(utterance);
    }, cancel() {}, getVoices: () => []},
    performance: {now: () => now},
    setTimeout, clearTimeout: id => timers.delete(id)
  });
  for (const script of ['story.js', 'book-i18n.js', 'audio/lines.js', 'image-transitions.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../prototype', script), 'utf8'), context, {filename: script});
  }
  const run = source => vm.runInContext(source, context);
  const snapshot = () => JSON.parse(run('JSON.stringify({currentKey, phase, errors, pendingAnswerKey, state, language})'));
  return {element, run, snapshot, tick, audioElements, plays, speech, speechSettings, timers, listeners};
}

test('the first-failure cards work while the parent invitation is preparing and ignore its late audio', async () => {
  const pending = [];
  const narration = {usesParentVoice:() => true, prepare:lines => new Promise(resolve => pending.push({lines, resolve}))};
  const h = harness('en', narration);
  h.run("go('p1', true); fail()");
  assert.equal(pending.length, 1);
  assert.match(pending[0].lines[0], /Tap the one you like/);
  assert.equal(h.element('hints').hidden, false);
  assert.equal(h.element('hints').children[0].disabled, false);
  h.element('hints').children[0].onclick();
  assert.equal(h.snapshot().currentKey, 'b1paper');
  pending[0].resolve(['http://127.0.0.1:8100/old-invitation.mp3']);
  await new Promise(setImmediate);
  assert.ok(!h.plays.some(play => play.src.endsWith('/old-invitation.mp3')));
});

for (const language of ['en', 'ko']) {
  test(`${language}: the first miss opens touch cards before narration ends and the next question resets misses`, () => {
    const h = harness(language);
    h.run("go('p1', true)");
    h.run('fail()');
    assert.equal(h.snapshot().errors, 1);
    assert.equal(h.snapshot().phase, 'ASKING');
    assert.equal(h.element('hints').hidden, false);
    assert.equal(h.element('hints').children.length, 2);
    assert.deepEqual(h.element('hints').children.map(card => card.children[0].textContent), ['1', '2']);
    assert.match(h.element('hints').textContent, language === 'ko' ? /종이/ : /Paper/);
    assert.equal(h.speech.at(-1).lang, language === 'ko' ? 'ko-KR' : 'en-US');
    assert.equal(h.element('hints').children[0].disabled, false);
    // No speech onend is fired: the child can tap during the spoken invitation.
    h.element('hints').children[0].onclick();
    assert.equal(h.snapshot().currentKey, 'b1paper');
    assert.equal(h.snapshot().state.h1, 'paper');
    assert.equal(h.snapshot().errors, 0);
    h.run("go('p2', true); fail()");
    assert.equal(h.element('hints').children.length, 1, 'Only a prepared forward answer is offered');
    assert.match(h.element('hints').textContent, language === 'ko' ? /나무/ : /Wood/);
  });

  test(`${language}: every prepared question has a fallback card without adding story branches`, () => {
    const h = harness(language);
    for (const key of ['p1', 'p1silly', 'w1', 'p2', 'p2silly', 'p3', 'w3']) {
      h.run(`go('${key}', true); fail()`);
      assert.equal(h.element('hints').hidden, false, `${key} must expose cards`);
      assert.ok(h.element('hints').children.length >= 1 && h.element('hints').children.length <= 2);
    }
  });
}

test('changing language preserves misses, visible fallback cards and chosen materials', () => {
  const h = harness();
  h.run("state.h1 = 'straw'; go('p2', true); fail(); setLanguage('ko')");
  assert.equal(h.snapshot().currentKey, 'p2');
  assert.equal(h.snapshot().state.h1, 'straw');
  assert.equal(h.snapshot().errors, 1);
  assert.equal(h.snapshot().phase, 'ASKING');
  assert.match(h.element('hints').textContent, /나무/);
  h.run("setLanguage('en')");
  assert.equal(h.snapshot().errors, 1);
  assert.equal(h.element('hints').hidden, false);
  assert.match(h.element('hints').textContent, /Wood/);
  h.element('hints').children[0].onclick();
  assert.equal(h.snapshot().errors, 0);
  assert.equal(h.snapshot().state.h1, 'straw');
  assert.equal(h.snapshot().state.h2, 'wood');
});

test('a heard answer waits 2.5 seconds and retry cancels it even across a language change', () => {
  const h = harness();
  h.run("go('p1', true); heard(current.ask[0])");
  assert.equal(h.snapshot().phase, 'HEARD');
  assert.equal(h.element('retry').textContent, 'Say it again');
  h.tick(2499);
  assert.equal(h.snapshot().currentKey, 'p1');
  h.element('retry').onclick();
  assert.equal(h.snapshot().errors, 1);
  assert.equal(h.snapshot().pendingAnswerKey, null);
  h.tick(3000);
  assert.equal(h.snapshot().currentKey, 'p1', 'The cancelled transition must never run');
  h.run("setLanguage('ko')");
  h.tick(3000);
  assert.equal(h.snapshot().currentKey, 'p1', 'Changing language must not resurrect a cancelled answer');
  assert.equal(h.snapshot().state.h1, undefined);
  assert.equal(h.snapshot().errors, 1);
});

test('a heard answer proceeds after its confirmation interval when it is not cancelled', () => {
  const h = harness('ko');
  h.run("go('p1', true); heard(current.ask[1])");
  h.tick(2500);
  assert.equal(h.snapshot().currentKey, 'b1straw');
  assert.equal(h.snapshot().state.h1, 'straw');
});

test('English clips reuse one audio element and Korean never starts an English clip', () => {
  const h = harness();
  h.run("go('intro')");
  assert.equal(h.plays.length, 1);
  const first = h.plays[0];
  first.ended();
  h.tick(450 / 0.85);
  assert.equal(h.plays.length, 2);
  assert.equal(h.audioElements.length, 1);
  assert.equal(h.plays[0].audio, h.plays[1].audio);
  const previousRead = h.plays[1];
  h.run("setLanguage('ko')");
  const count = h.plays.length;
  assert.equal(h.speech.at(-1).lang, 'ko-KR');
  previousRead.ended();
  previousRead.reject(new Error('old play rejection'));
  h.tick(1000);
  assert.equal(h.plays.length, count);
  assert.equal(h.snapshot().language, 'ko');
});

test('slow redraw waits for narration completion before revealing and turning the page', () => {
  const h = harness();
  h.element('speed').value = '0.6';
  h.run("go('b1paper')");
  const clip = h.plays.at(-1);
  h.tick(5000);
  assert.equal(h.snapshot().phase, 'GENERATING');
  assert.equal(h.snapshot().currentKey, 'b1paper');
  h.tick(7100 / 0.6 - 5000);
  assert.equal(h.snapshot().phase, 'GENERATING', 'A fixed paint timer cannot end narration');
  clip.ended();
  h.tick(749);
  assert.equal(h.snapshot().phase, 'GENERATING');
  h.tick(1);
  assert.equal(h.snapshot().phase, 'UPDATED');
  h.tick(1700);
  assert.equal(h.snapshot().currentKey, 'd1');
});

test('redraw waits for a slow picture after paint and narration finish', () => {
  const h = harness();
  h.element('imgNext').complete = false;
  h.element('imgNext').naturalWidth = 0;
  h.run("go('b1paper')");
  h.plays.at(-1).ended();
  h.tick(5000);
  assert.equal(h.snapshot().phase, 'GENERATING');
  h.element('imgNext').naturalWidth = 1024;
  h.element('imgNext').onload();
  assert.equal(h.snapshot().phase, 'UPDATED');
  h.tick(490);
  assert.equal(h.snapshot().currentKey, 'd1');
  assert.equal(h.run('picture.current.getAttribute("src")'), 'img/paper_house.jpg');
});

test('failed redraw keeps the old picture and can continue the story', () => {
  const h = harness();
  h.element('imgNext').complete = false;
  h.run("go('b1paper')");
  h.element('imgNext').onerror();
  h.plays.at(-1).ended();
  h.tick(5000);
  assert.equal(h.snapshot().phase, 'UPDATED');
  assert.match(h.element('status').textContent, /previous picture/);
  h.tick(1200);
  assert.equal(h.snapshot().currentKey, 'd1');
  assert.equal(h.run('picture.current.getAttribute("src")'), 'img/intro.jpg');
});

test('skip ignores callbacks and play rejections from the skipped reading', () => {
  const h = harness();
  h.run("go('intro')");
  const old = h.plays.at(-1);
  h.element('skip').onclick();
  h.tick(500);
  assert.equal(h.snapshot().currentKey, 'p1');
  const before = h.timers.size;
  old.ended();
  old.reject(new Error('late rejection'));
  assert.equal(h.timers.size, before, 'Stale audio cannot schedule another read');
  assert.equal(h.snapshot().currentKey, 'p1');
});

test('pagehide stops narration and prevents delayed callbacks from advancing the story', () => {
  const h = harness();
  h.run("go('intro')");
  const old = h.plays.at(-1);
  h.listeners.get('pagehide')();
  old.ended();
  old.reject(new Error('late rejection'));
  h.tick(20000);
  assert.equal(h.snapshot().currentKey, 'intro');
  assert.equal(h.plays.length, 1);
  assert.equal(h.timers.size, 0);
  assert.ok(old.audio.pauses > 0);
});

test('story text and answer labels render as text instead of HTML', () => {
  const h = harness();
  h.run("readLines(['<img src=x onerror=alert(1)>']); setAnswers([{say:'<b>Paper</b>', note:'<script>x</script>', go:'b1paper'}]); showHints([{b:'<img>', label:'<i>Paper</i>', go:'b1paper'}], true)");
  for (const id of ['line', 'answers', 'hints']) assert.equal(h.element(id).htmlWrites.length, 0);
  assert.match(h.element('line').textContent, /<img src=x/);
  assert.match(h.element('answers').textContent, /<b>Paper<\/b><script>x<\/script>/);
  assert.match(h.element('hints').textContent, /<img><i>Paper<\/i>/);
});


test('a language change reopens the translated heard answer for a full confirmation interval', () => {
  const h = harness();
  h.run("state.h1 = 'straw'; go('p2', true); fail(); heard(current.ask[0])");
  h.tick(1000);
  h.run("setLanguage('ko')");
  assert.equal(h.snapshot().currentKey, 'p2');
  assert.equal(h.snapshot().phase, 'HEARD');
  assert.equal(h.snapshot().state.h1, 'straw');
  assert.equal(h.snapshot().state.h2, undefined);
  assert.equal(h.snapshot().errors, 1);
  assert.match(h.element('bubble').textContent, /나무/);
  h.tick(2499);
  assert.equal(h.snapshot().currentKey, 'p2');
  h.element('retry').onclick();
  assert.equal(h.snapshot().pendingAnswerKey, null);
  assert.equal(h.snapshot().errors, 2);
  h.tick(3000);
  assert.equal(h.snapshot().currentKey, 'p2', 'The original and restarted confirmation timers are cancelled');
  assert.equal(h.snapshot().state.h2, undefined);
});

test('a translated heard answer commits only after its new full confirmation interval', () => {
  const h = harness();
  h.run("go('p1', true); heard(current.ask[1])");
  h.tick(1000);
  h.run("setLanguage('ko')");
  h.tick(2499);
  assert.equal(h.snapshot().currentKey, 'p1');
  assert.match(h.element('bubble').textContent, /짚/);
  h.tick(1);
  assert.equal(h.snapshot().currentKey, 'b1straw');
  assert.equal(h.snapshot().state.h1, 'straw');
});

test('switching language during a simulated demo answer also requires confirmation', () => {
  const h = harness();
  h.run("go('p1', true); answer(current.ask[1])");
  h.tick(500);
  assert.equal(h.snapshot().phase, 'LISTENING');
  h.run("setLanguage('ko')");
  assert.equal(h.snapshot().currentKey, 'p1');
  assert.equal(h.snapshot().phase, 'HEARD');
  assert.match(h.element('bubble').textContent, /짚/);
  h.tick(2499);
  assert.equal(h.snapshot().currentKey, 'p1');
  h.tick(1);
  assert.equal(h.snapshot().currentKey, 'b1straw');
});

test('Korean browser narration waits for real onend before starting the next line', () => {
  const h = harness('ko');
  h.run("go('intro')");
  const first = h.speech[0];
  assert.equal(typeof first.onend, 'function');
  h.tick(10000);
  assert.equal(h.speech.length, 1, 'A word-count estimate cannot finish a working browser voice');
  assert.equal(h.snapshot().currentKey, 'intro');
  first.onend();
  h.tick(450 / 0.85);
  assert.equal(h.speech.length, 2);
  assert.equal(h.speech[1].lang, 'ko-KR');
  assert.equal(h.plays.length, 0);
});

test('Korean redraw waits for real browser narration completion', () => {
  const h = harness('ko');
  h.run("go('b1paper')");
  h.tick(15000);
  assert.equal(h.snapshot().phase, 'GENERATING');
  assert.equal(h.snapshot().currentKey, 'b1paper');
  h.speech[0].onend();
  h.tick(450 / 0.85);
  assert.equal(h.snapshot().phase, 'UPDATED');
  h.tick(1700);
  assert.equal(h.snapshot().currentKey, 'd1');
});

test('browser narration errors fall back once and ignore a later onend', () => {
  const h = harness('ko');
  h.run("go('intro')");
  const first = h.speech[0];
  const lateEnd = first.onend;
  first.onerror({error: 'synthesis-failed'});
  h.tick(10000);
  assert.equal(h.speech.length, 2, 'The failed line must progress using the estimated fallback');
  const scheduled = h.timers.size;
  lateEnd();
  assert.equal(h.timers.size, scheduled, 'An onend after failure cannot finish the line twice');
});

for (const failure of ['unavailable', 'throw']) {
  test(`browser narration ${failure} falls back to estimated reading without hanging`, () => {
    const h = harness('ko');
    if (failure === 'throw') h.speechSettings.throwOnSpeak = true;
    else h.run('delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance');
    h.run("go('intro')");
    assert.equal(h.snapshot().phase, 'READING');
    h.tick(20000);
    assert.equal(h.snapshot().currentKey, 'p1');
    assert.equal(h.snapshot().phase, 'ASKING');
  });
}

test('browser narration without callbacks times out after 30 seconds and ignores late completion', () => {
  const h = harness('ko');
  h.run("go('intro')");
  const first = h.speech[0];
  const lateEnd = first.onend;
  h.tick(29999);
  assert.equal(h.speech.length, 1);
  assert.equal(h.snapshot().currentKey, 'intro');
  h.tick(10001);
  assert.equal(h.speech.length, 2, 'The 30-second watchdog must recover from a missing callback');
  const scheduled = h.timers.size;
  lateEnd();
  assert.equal(h.timers.size, scheduled);
});

test('stopping browser narration invalidates onend and onerror callbacks', () => {
  const h = harness('ko');
  h.run("go('intro')");
  const utterance = h.speech[0];
  const lateEnd = utterance.onend;
  const lateError = utterance.onerror;
  h.listeners.get('pagehide')();
  lateEnd();
  lateError({error: 'interrupted'});
  h.tick(40000);
  assert.equal(h.snapshot().currentKey, 'intro');
  assert.equal(h.speech.length, 1);
  assert.equal(h.timers.size, 0);
});

test('translated confirmation preserves the selected label when two answers share one target', () => {
  const h = harness();
  h.run("go('w3', true); heard(current.ask[1]); setLanguage('ko')");
  assert.equal(h.snapshot().phase, 'HEARD');
  assert.match(h.element('bubble').textContent, /튼튼/);
  assert.doesNotMatch(h.element('bubble').textContent, /무거/);
});

test('changing language invalidates callbacks from the previous browser narration', () => {
  const h = harness('ko');
  h.run("go('intro')");
  const previous = h.speech[0];
  const lateEnd = previous.onend, lateError = previous.onerror;
  h.run("setLanguage('en')");
  assert.equal(h.plays.length, 1);
  const scheduled = h.timers.size;
  lateEnd();
  lateError({error: 'interrupted'});
  assert.equal(h.timers.size, scheduled);
  h.tick(1000);
  assert.equal(h.snapshot().language, 'en');
  assert.equal(h.plays.length, 1);
});
