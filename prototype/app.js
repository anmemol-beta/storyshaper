const $ = (id) => document.getElementById(id);
const book = $("book"), art = $("art"), line = $("line"), mic = $("mic"), bubble = $("bubble"), hints = $("hints"),
  answers = $("answers"), imgCur = $("imgCur"), imgNext = $("imgNext"), statusEl = $("status"), skipBtn = $("skip"),
  againBtn = $("again"), painting = $("painting"), demo = $("demo");

// Story states (see the design doc, 6-2). `phase` drives everything the child sees; `state` below holds the story choices.
// COVER -> READING -> ASKING -> LISTENING -> HEARD -> GENERATING -> UPDATED -> READING ... DONE.
// The first missed answer returns to ASKING with touch cards already active.
let language = stored("story-language") === "ko" ? "ko" : "en";
const copy = () => BOOK_COPY[language];
const storyData = () => storyForLanguage(language);
const HOLD_MS = 600;       // pressing longer than this works like a walkie-talkie: letting go sends the answer
const MIN_HEARD_MS = 500;  // a shorter "recording" counts as not heard
const LISTEN_MAX_MS = 8000;
const HEARD_MS = 2500;     // time to tap "Say it again" before a heard answer is used; tune with a real child
const MAX_TRIES = 1;       // the first missed answer immediately opens touch cards (roadmap §4)
const TTS_TIMEOUT_MS = 30000; // fall back if the browser never reports speech completion
const PAINT_MS = 5000;     // stand-in for the 12-20 s redraw
const BASE_ICON = ["🌱", "🏡", "🏡", "🏡", "🌟"];
const MATERIAL_ICON = { paper: "📄", straw: "🌾", wood: "🪵", brick: "🧱" };

let timers = [], readTimers = [], current = null, currentKey = null, state = {}, phase = "COVER", skipReading = null, playing = null;
let listenStart = 0, listenTimer = null, pressStart = 0, pressStarted = false, errors = 0, pendingAnswerKey = null, pendingAnswerIndex = null; // errors: missed tries on the current question

// One audio element for every clip. iOS Safari only lets an element play without a tap once it has played inside one,
// so a fresh `new Audio()` per line would stay silent there after the first line.
const voiceEl = new Audio();
voiceEl.preservesPitch = true; // slower, same voice pitch
// Bumped whenever reading stops or restarts, so callbacks from an older read (a late play() rejection,
// a clip that ends after a skip) cannot advance the new one.
let readGen = 0;

const val = (v) => (typeof v === "function" ? v(state) : v);
const src = (name) => `img/${name}.jpg`;
function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function laterRead(fn, ms) { readTimers.push(setTimeout(fn, ms)); }
function stopVoice() {
  readGen++;
  try { speechSynthesis.cancel(); } catch (e) {}
  if (playing) { playing.onloadedmetadata = playing.onended = playing.onerror = null; playing.pause(); playing = null; }
}
function clearTimers() {
  timers.forEach(clearTimeout); readTimers.forEach(clearTimeout); timers = []; readTimers = [];
  clearTimeout(listenTimer); listenTimer = null; pressStarted = false; skipReading = null;
  stopVoice();
}
function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

// preload so page turns are instant
Object.values(SCENES).forEach((s) => { const n = typeof s.img === "string" ? s.img : s.build; if (n) new Image().src = src(n); });
["wolf_paper", "wolf_straw"].forEach((n) => (new Image().src = src(n)));

// ---- phase: one place that decides what the mic, the status words and the buttons look like ----
function setPhase(p, text) {
  phase = p;
  book.dataset.state = p;
  statusEl.textContent = text !== undefined ? text : (copy()[p] || "");
  mic.disabled = !(p === "LISTENING" || p === "ERROR" || (p === "ASKING" && current && current.ask));
  mic.setAttribute("aria-label", p === "LISTENING" ? copy().finish : copy().talk);
  $("retry").textContent = p === "HEARD" ? copy().sayAgain : copy().retry;
  skipBtn.disabled = !(p === "READING" && skipReading);
  updateDemo();
}

function renderChapters(active) {
  $("chapters").innerHTML = storyData().chapters.map((name, i) => {
    const icon = (i >= 1 && i <= 3 && MATERIAL_ICON[state["h" + i]]) || BASE_ICON[i];
    return `<li class="${i < active ? "past" : i === active ? "on" : ""}"${i === active ? ' aria-current="step"' : ""}><span aria-hidden="true">${icon}</span><span class="sr">${name}</span></li>`;
  }).join("");
}

// ---- theme: system | light | dark, remembered per browser; switching never touches the story ----
const root = document.documentElement, darkQuery = matchMedia("(prefers-color-scheme: dark)");
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
let themePref = ["light", "dark"].includes(stored("story-theme")) ? stored("story-theme") : "system";
const isDark = () => themePref === "dark" || (themePref === "system" && darkQuery.matches);
function applyTheme() {
  if (themePref === "system") root.removeAttribute("data-theme"); else root.dataset.theme = themePref;
  const dark = isDark();
  $("themeBtn").innerHTML = dark ? SUN : MOON;
  $("themeBtn").setAttribute("aria-label", dark ? copy().lightMode : copy().darkMode);
  document.querySelectorAll('input[name="theme"]').forEach((r) => (r.checked = r.value === themePref));
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue("--bg-app").trim();
}
function setTheme(pref) { themePref = pref; store("story-theme", pref === "system" ? "" : pref); applyTheme(); }
$("themeBtn").onclick = () => setTheme(isDark() ? "light" : "dark");
document.querySelectorAll('input[name="theme"]').forEach((r) => (r.onchange = () => setTheme(r.value)));
darkQuery.addEventListener("change", applyTheme);
applyTheme();

// ---- settings popover, fullscreen ----
const pop = $("settings"), gear = $("settingsBtn");
function showSettings(open) { pop.hidden = !open; gear.setAttribute("aria-expanded", String(open)); if (!open) $("confirm").hidden = true; }
gear.onclick = () => showSettings(pop.hidden);
document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !gear.contains(e.target)) showSettings(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { showSettings(false); gear.focus(); } });
if (!document.fullscreenEnabled) $("fsBtn").hidden = true;
$("fsBtn").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen().catch(() => {}));

// Reading speed from the slider (1 = as generated). Remembered per browser.
const rate = () => +$("speed").value;
if (stored("story-speed")) $("speed").value = stored("story-speed");
const showSpeed = () => ($("speedVal").textContent = `${rate().toFixed(2)}×`);
$("speed").oninput = () => {
  showSpeed();
  if (playing) playing.playbackRate = rate();
  store("story-speed", $("speed").value);
};
showSpeed();

// Demo answers: a grown-up's panel, hidden by default; on with the settings toggle or ?demo=1.
// The first missed answer opens picture cards immediately (showChoices).
let demoOn = new URLSearchParams(location.search).has("demo") || stored("story-demo") === "1";
$("demoToggle").checked = demoOn;
$("demoToggle").onchange = () => { demoOn = $("demoToggle").checked; store("story-demo", demoOn ? "1" : "0"); updateDemo(); };
function updateDemo() { demo.hidden = !demoOn; }

// Browser voice, only used for lines that have no pre-generated clip.
function speak(text, onEnd, onError) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language === "ko" ? "ko-KR" : "en-US";
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(language));
    if (voice) u.voice = voice;
    u.rate = 0.95 * rate();
    if (onEnd) u.onend = onEnd;
    if (onError) u.onerror = onError;
    speechSynthesis.speak(u);
    return u;
  } catch (e) { return null; }
}

// Light up words one by one, spread evenly over `ms`.
function highlight(spans, ms) {
  const step = ms / spans.length;
  spans.forEach((s, k) => laterRead(() => { if (k > 0) spans[k - 1].className = "done"; s.className = "now"; }, k * step));
}

// Read lines one after another. With sound on, play the parent-voice clip for the line
// (pre-generated, see audio/lines.js) and pace the highlight to its length.
function readLines(lines, done) {
  const queue = lines.map(val), gen = ++readGen;
  const live = () => gen === readGen;
  const finish = () => { skipReading = null; skipBtn.disabled = true; done && done(); };
  skipReading = () => { readTimers.forEach(clearTimeout); readTimers = []; stopVoice(); line.textContent = queue[queue.length - 1]; finish(); };
  skipBtn.disabled = phase !== "READING";
  const readOne = (i) => {
    if (!live()) return;
    if (i >= queue.length) return finish();
    const text = queue[i], words = text.split(" ");
    // Built as text nodes: lines will come from the model and the child's words, never parse them as HTML.
    const spans = words.map((w) => { const s = document.createElement("span"); s.className = "todo"; s.textContent = w + " "; return s; });
    const box = document.createElement("span");
    box.className = "words"; box.append(...spans);
    line.replaceChildren(box);
    const lineDone = () => { if (!live()) return; spans.forEach((s) => (s.className = "done")); laterRead(() => readOne(i + 1), 450 / rate()); };
    const timed = () => { const ms = (words.length * 300) / rate(); highlight(spans, ms); laterRead(lineDone, ms + 200); };
    // A voice registered on voice.html comes from the narration server; otherwise the prepared clips (English only).
    // Korean uses Korean browser TTS.
    const prepared = language === "en" && $("voice").checked && typeof NARRATION !== "undefined" && NARRATION[text];
    const clip = (serverUrls && serverUrls[i]) || (prepared && `audio/${prepared}`);
    if (!clip) {
      if (!$("voice").checked) return timed();
      let settled = false;
      const completeSpeech = () => {
        if (settled || !live()) return;
        settled = true; clearTimeout(speechTimer); lineDone();
      };
      const speechFailed = () => {
        if (settled || !live()) return;
        settled = true; clearTimeout(speechTimer);
        try { speechSynthesis.cancel(); } catch (e) {}
        timed();
      };
      const speechTimer = setTimeout(speechFailed, TTS_TIMEOUT_MS);
      readTimers.push(speechTimer);
      if (!speak(text, completeSpeech, speechFailed)) speechFailed();
      else if (!settled) highlight(spans, (words.length * 300) / rate());
      return;
    }
    let fellBack = false;
    const fallBack = () => { if (fellBack || !live()) return; fellBack = true; playing = null; timed(); };
    const audio = (playing = voiceEl);
    audio.onloadedmetadata = () => live() && highlight(spans, (audio.duration * 1000) / rate());
    audio.onended = () => { if (!live()) return; playing = null; lineDone(); };
    audio.onerror = fallBack;
    audio.src = clip;
    audio.defaultPlaybackRate = audio.playbackRate = rate(); // loading a new src resets playbackRate to the default
    audio.play().catch(fallBack);
  };
  // Ask for the registered voice's clips for the whole passage at once (narration.js); the server makes them in order.
  let serverUrls = null;
  if (language === "en" && $("voice").checked && typeof Narration !== "undefined" && Narration.usesParentVoice()) {
    Narration.prepare(queue).then((urls) => { serverUrls = urls; if (live()) readOne(0); });
  } else readOne(0);
}

// The question stays on screen, marked like with a highlighter pen.
function markQuestion() {
  const m = document.createElement("mark"), words = document.createElement("span");
  m.textContent = line.textContent.trim();
  words.className = "words"; words.append(m);
  line.replaceChildren(words);
}

// Page turns and redraws share one decode-aware crossfade controller.
const picture = new StoryImageTransition(imgCur, imgNext);
function settleImage() { picture.settle(); }
function turnPage(name) {
  if (!name) return;
  picture.show(src(name), {onError: () => { statusEl.textContent = copy().imageUnavailable; }});
}

function setAnswers(list) {
  answers.replaceChildren();
  if (!list) {
    const none = document.createElement("span");
    none.className = "none"; none.textContent = copy().noAnswers;
    answers.append(none);
    return;
  }
  list.forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn"; b.type = "button";
    b.textContent = a.say;
    if (a.note) { const em = document.createElement("em"); em.textContent = a.note; b.append(em); }
    b.onclick = () => (a.tap ? go(a.go) : answer(a));
    answers.appendChild(b);
  });
}

// Picture buttons over the page. `numbered` adds 1, 2, 3 for the cards a child gets after missed tries.
function showHints(list, numbered) {
  hints.replaceChildren(...list.map((h, i) => {
    const btn = document.createElement("button"), icon = document.createElement("b");
    btn.className = "hint"; btn.type = "button";
    icon.textContent = h.b;
    btn.append(icon, h.label);
    if (numbered) { const n = document.createElement("span"); n.className = "num"; n.textContent = i + 1; btn.prepend(n); }
    btn.onclick = () => go(h.go);
    return btn;
  }));
  hints.hidden = false;
}

// The picture-card invitation in the parent's voice from the narration server, or the browser voice without it.
function readChoices(text) {
  if (language !== "en" || typeof Narration === "undefined") return speak(text);
  const gen = ++readGen;
  Narration.prepare([text]).then((urls) => {
    if (gen !== readGen) return;
    if (!urls) return speak(text);
    const audio = (playing = voiceEl);
    const fallBack = () => { if (gen !== readGen || playing !== audio) return; playing = null; speak(text); };
    audio.onloadedmetadata = null;
    audio.onended = () => { if (playing === audio) playing = null; };
    audio.onerror = fallBack;
    audio.src = urls[0];
    audio.defaultPlaybackRate = audio.playbackRate = rate();
    audio.play().catch(fallBack);
  });
}

// After the first missed answer: numbered picture cards, read aloud, so a child who cannot read
// or be understood can still answer. The mic stays on for a child who wants to talk again.
function showChoices() {
  const cards = current.ask.filter((a) => a.icon).slice(0, 3).map((a) => ({ b: a.icon, label: a.say.replace(/!$/, ""), go: a.go }));
  if (!cards.length) return false;
  clearTimeout(listenTimer);
  bubble.hidden = true;
  showHints(cards, true);
  setAnswers(current.ask);
  setPhase("ASKING", copy().PICK);
  if ($("voice").checked) readChoices(`${copy().CHOICES} ${cards.map((c, i) => `${i + 1}. ${c.label}.`).join(" ")}`);
  return true;
}

function go(key, showLastLine = false) {
  clearTimers(); settleImage();
  pendingAnswerKey = null; pendingAnswerIndex = null;
  // Re-rendering the same question in another language keeps its failed tries and cards.
  if (key !== currentKey) errors = 0;
  currentKey = key;
  current = storyData().scenes[key];
  bubble.hidden = true; hints.hidden = true; $("summary").hidden = true; againBtn.hidden = true; painting.hidden = true;
  mic.hidden = false;
  setAnswers(null);
  renderChapters(current.chapter);
  if (current.choose) state[current.choose[0]] = current.choose[1];
  if (current.build) return redraw();
  setPhase("READING");
  turnPage(val(current.img));
  if (showLastLine) {
    line.textContent = val(current.lines[current.lines.length - 1]);
    return afterReading();
  }
  readLines(current.lines, afterReading);
}

function afterReading() {
  if (current.ask) {
    markQuestion();
    setPhase("ASKING");
    setAnswers(current.ask);
    if (errors >= MAX_TRIES && showChoices()) return;
    if (current.hintsToo) showHints(current.hintsToo);
  } else if (current.hints) {
    markQuestion();
    setPhase("ASKING", copy().PICK);
    showHints(current.hints);
    setAnswers(current.hints.map((h) => ({ say: h.label, go: h.go, tap: true, note: copy().PICK })));
  } else if (current.then) {
    later(() => go(current.then), 500);
  } else if (current.end) {
    const built = ["h1", "h2", "h3"].map((k) => storyData().labels[state[k]]).filter(Boolean);
    const title = document.createElement("strong"), list = document.createElement("span");
    title.textContent = copy().built; list.textContent = built.join(" · ");
    $("summary").replaceChildren(title, list);
    $("summary").hidden = false;
    setPhase("DONE");
    mic.hidden = true; againBtn.hidden = false; againBtn.focus();
  }
}

// ---- the child's turn: tap (or hold) the mic -> listening -> heard -> redraw ----
function startListening() {
  const canStart = phase === "ERROR" || (phase === "ASKING" && current && current.ask);
  if (!canStart) return false;
  listenStart = performance.now();
  setPhase("LISTENING");
  listenTimer = later(stopListening, LISTEN_MAX_MS);
  return true;
}
function stopListening() {
  if (phase !== "LISTENING") return;
  clearTimeout(listenTimer);
  if (performance.now() - listenStart < MIN_HEARD_MS) return fail();
  heard(current.ask[0]); // no speech-to-text in the prototype: the mic always "hears" the first answer
}
// A missed try: not heard, or the child said "that's not what I said". Both count toward the picture cards.
function fail() {
  clearTimeout(listenTimer);
  errors++;
  if (errors >= MAX_TRIES && showChoices()) return;
  setPhase("ERROR");
}
// Show what was heard and wait a moment, so a misheard answer can be taken back before it starts a redraw.
function heard(a) {
  pendingAnswerKey = a.go; pendingAnswerIndex = current.ask.indexOf(a);
  hints.hidden = true;
  setAnswers(null);
  bubble.textContent = a.say; bubble.hidden = false;
  setPhase("HEARD", copy().heard(a.say));
  later(() => go(a.go), HEARD_MS);
}
// A demo answer button: act out a short listening moment first, then the same path as the mic.
function answer(a) {
  if (!current || !current.ask || !(phase === "ASKING" || phase === "ERROR")) return;
  clearTimers(); settleImage();
  pendingAnswerKey = a.go; pendingAnswerIndex = current.ask.indexOf(a);
  hints.hidden = true;
  setAnswers(null);
  setPhase("LISTENING");
  mic.disabled = true; // the demo button is speaking now, not the mic
  later(() => heard(a), 1300);
}

mic.onpointerdown = (e) => {
  e.preventDefault();
  if (phase === "LISTENING") return stopListening(); // second tap finishes
  pressStarted = startListening(); pressStart = performance.now();
};
const release = () => { // holding like a walkie-talkie: letting go finishes
  if (!pressStarted) return;
  pressStarted = false;
  if (performance.now() - pressStart >= HOLD_MS && phase === "LISTENING") stopListening();
};
mic.onpointerup = mic.onpointerleave = mic.onpointercancel = release;
mic.onkeydown = (e) => {
  if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); phase === "LISTENING" ? stopListening() : startListening(); }
};
$("retry").onclick = () => {
  if (phase === "HEARD") { // "Say it again": the heard answer was wrong, so drop it before it is used
    clearTimers();
    pendingAnswerKey = null; pendingAnswerIndex = null;
    bubble.hidden = true;
    setAnswers(current.ask);
    fail();
    if (phase === "ERROR") startListening();
    return;
  }
  startListening(); mic.focus();
};

// The new picture shows once it is painted and the line about it has been read, so a slow reading speed
// is not cut off by the page turn.
function redraw() {
  setPhase("GENERATING");
  painting.hidden = false;
  const image = src(current.build), nextScene = current.then;
  let painted = false, narrated = false, ready = false, failed = false, revealed = false;
  function reveal() {
    if (!painted || !narrated || !(ready || failed) || revealed) return;
    revealed = true;
    painting.hidden = true; bubble.hidden = true;
    setPhase("UPDATED", failed ? copy().imageUnavailable : copy().UPDATED);
    if (failed) later(() => go(nextScene), 1200);
    else picture.reveal(() => go(nextScene));
  }
  picture.prepare(image, {
    onReady: () => { ready = true; reveal(); },
    onError: () => { failed = true; reveal(); }
  });
  readLines(current.lines, () => { narrated = true; reveal(); });
  skipReading = null; skipBtn.disabled = true;
  later(() => { painted = true; reveal(); }, PAINT_MS);
}

function restart() {
  clearTimers(); picture.cancel(); state = {}; errors = 0;
  go("intro");
}

$("restart").onclick = () => { $("confirm").hidden = false; $("restartNo").focus(); }; // "No" first: the safe answer
$("restartNo").onclick = () => ($("confirm").hidden = true);
$("restartYes").onclick = () => { showSettings(false); restart(); };
againBtn.onclick = restart;
skipBtn.onclick = () => skipReading && skipReading();

function applyLanguage() {
  root.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = copy()[el.dataset.i18n]; });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", copy()[el.dataset.i18nAria]); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = copy()[el.dataset.i18nTitle]; });
  document.querySelectorAll("[data-language]").forEach((el) => { el.setAttribute("aria-pressed", String(el.dataset.language === language)); });
  applyTheme();
  showReader();
}

// Whose voice reads the book: the parent registered on voice.html, or the storybook voice.
// Registered voices are English only, so Korean always shows the device voice.
function showReader() {
  const name = language === "en" && typeof Narration !== "undefined" ? Narration.voiceName() : null;
  $("readerName").textContent = name || copy().storybookVoice;
  $("readBy").hidden = !name;
  $("readBy").textContent = name ? copy().readBy(name) : "";
}
function setLanguage(next) {
  if (!["en", "ko"].includes(next) || next === language) return;
  const previousPhase = phase;
  const acceptedTarget = pendingAnswerKey, answerIndex = pendingAnswerIndex;
  clearTimers(); settleImage();
  language = next;
  store("story-language", language);
  applyLanguage();
  if (acceptedTarget) {
    // A heard/demo answer is still awaiting confirmation. Translate that same answer
    // and give the child the full confirmation window again instead of committing it.
    current = storyData().scenes[currentKey];
    line.textContent = val(current.lines[current.lines.length - 1]);
    markQuestion();
    heard(current.ask[answerIndex]);
  } else if (currentKey) {
    // Stable questions and the ending switch immediately. An in-progress scene is read again
    // in the new language; choices stay in the same language-neutral state object.
    go(currentKey, ["ASKING", "ERROR", "DONE"].includes(previousPhase));
    if (previousPhase === "ERROR") setPhase("ERROR");
  } else {
    renderChapters(0); setAnswers(null); setPhase("COVER", "");
  }
}
document.querySelectorAll("[data-language]").forEach((button) => { button.onclick = () => setLanguage(button.dataset.language); });
applyLanguage();

// Wait for a first tap: browsers only allow sound after the user interacts with the page.
renderChapters(0);
setAnswers(null);
setPhase("COVER", "");
$("cover").onclick = () => { $("cover").hidden = true; restart(); };
window.addEventListener("pagehide", () => { clearTimers(); picture.cancel(); });
