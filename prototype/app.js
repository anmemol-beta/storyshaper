const $ = (id) => document.getElementById(id);
const book = $("book"), art = $("art"), line = $("line"), mic = $("mic"), bubble = $("bubble"), hints = $("hints"),
  answers = $("answers"), imgCur = $("imgCur"), imgNext = $("imgNext"), statusEl = $("status"), skipBtn = $("skip"),
  againBtn = $("again"), painting = $("painting"), demo = $("demo");

// Story states (see the design doc, 6-2). `phase` drives everything the child sees; `state` below holds the story choices.
// COVER -> READING -> ASKING -> LISTENING -> HEARD -> GENERATING -> UPDATED -> READING ... DONE; ERROR returns to LISTENING.
const COPY = { // the short words the child sees; one place to edit or translate
  READING: "Listening to the story",
  ASKING: "What do you think?",
  PICK: "Tap a picture",
  LISTENING: "I'm listening…",
  GENERATING: "Painting a new picture…",
  UPDATED: "Look what happened!",
  ERROR: "I didn't catch that. Say it again?",
  DONE: "The End"
};
const HOLD_MS = 600;       // pressing longer than this works like a walkie-talkie: letting go sends the answer
const MIN_HEARD_MS = 500;  // a shorter "recording" counts as not heard
const LISTEN_MAX_MS = 8000;
const BASE_ICON = ["🌱", "🏡", "🏡", "🏡", "🌟"];
const MATERIAL_ICON = { paper: "📄", straw: "🌾", wood: "🪵", brick: "🧱" };

let timers = [], readTimers = [], current = null, state = {}, phase = "COVER", skipReading = null, playing = null;
let listenStart = 0, listenTimer = null, pressStart = 0, pressStarted = false, errors = 0;

const val = (v) => (typeof v === "function" ? v(state) : v);
const src = (name) => `img/${name}.jpg`;
function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function laterRead(fn, ms) { readTimers.push(setTimeout(fn, ms)); }
function stopVoice() {
  try { speechSynthesis.cancel(); } catch (e) {}
  if (playing) { playing.onended = playing.onerror = null; playing.pause(); playing = null; }
}
function clearTimers() { timers.forEach(clearTimeout); readTimers.forEach(clearTimeout); timers = []; readTimers = []; stopVoice(); }
function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

// preload so page turns are instant
Object.values(SCENES).forEach((s) => { const n = typeof s.img === "string" ? s.img : s.build; if (n) new Image().src = src(n); });
["wolf_paper", "wolf_straw"].forEach((n) => (new Image().src = src(n)));

// ---- phase: one place that decides what the mic, the status words and the buttons look like ----
function setPhase(p, text) {
  phase = p;
  book.dataset.state = p;
  statusEl.textContent = text !== undefined ? text : (COPY[p] || "");
  mic.disabled = !(p === "LISTENING" || p === "ERROR" || (p === "ASKING" && current && current.ask));
  mic.setAttribute("aria-label", p === "LISTENING" ? "Tap to finish" : "Tap to talk");
  skipBtn.disabled = !(p === "READING" && skipReading);
  updateDemo();
}

function renderChapters(active) {
  $("chapters").innerHTML = CHAPTERS.map((name, i) => {
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
  $("themeBtn").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
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

// Demo answers: hidden by default; on with the settings toggle, ?demo=1, or after the voice failed twice.
let demoOn = new URLSearchParams(location.search).has("demo") || stored("story-demo") === "1";
$("demoToggle").checked = demoOn;
$("demoToggle").onchange = () => { demoOn = $("demoToggle").checked; store("story-demo", demoOn ? "1" : "0"); updateDemo(); };
function updateDemo() { demo.hidden = !(demoOn || errors >= 2); }

// Browser voice, only used for lines that have no pre-generated clip.
function speak(text) {
  try { const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = 0.95 * rate(); speechSynthesis.speak(u); } catch (e) {}
}

// Light up words one by one, spread evenly over `ms`.
function highlight(spans, ms) {
  const step = ms / spans.length;
  spans.forEach((s, k) => laterRead(() => { if (k > 0) spans[k - 1].className = "done"; s.className = "now"; }, k * step));
}

// Read lines one after another. With sound on, play the parent-voice clip for the line
// (pre-generated, see audio/lines.js) and pace the highlight to its length.
function readLines(lines, done) {
  const queue = lines.map(val);
  const finish = () => { skipReading = null; skipBtn.disabled = true; done && done(); };
  skipReading = () => { readTimers.forEach(clearTimeout); readTimers = []; stopVoice(); line.textContent = queue[queue.length - 1]; finish(); };
  skipBtn.disabled = phase !== "READING";
  const readOne = (i) => {
    if (i >= queue.length) return finish();
    const text = queue[i], words = text.split(" ");
    line.innerHTML = `<span class="words">${words.map((w) => `<span class="todo">${w} </span>`).join("")}</span>`;
    const spans = [...line.firstChild.children];
    const lineDone = () => { spans.forEach((s) => (s.className = "done")); laterRead(() => readOne(i + 1), 450 / rate()); };
    const timed = () => { const ms = (words.length * 300) / rate(); highlight(spans, ms); laterRead(lineDone, ms + 200); };
    const clip = $("voice").checked && typeof NARRATION !== "undefined" && NARRATION[text];
    if (!clip) {
      if ($("voice").checked) speak(text);
      return timed();
    }
    const audio = (playing = new Audio(`audio/${clip}`));
    let fellBack = false;
    const fallBack = () => { if (fellBack) return; fellBack = true; playing = null; timed(); };
    audio.preservesPitch = true; // slower, same voice pitch
    audio.playbackRate = rate();
    audio.onloadedmetadata = () => highlight(spans, (audio.duration * 1000) / rate());
    audio.onended = () => { playing = null; lineDone(); };
    audio.onerror = fallBack;
    audio.play().catch(fallBack);
  };
  readOne(0);
}

// The question stays on screen, marked like with a highlighter pen.
function markQuestion() {
  const m = document.createElement("mark"), words = document.createElement("span");
  m.textContent = line.textContent.trim();
  words.className = "words"; words.append(m);
  line.replaceChildren(words);
}

// A page turn fades imgNext in, then swaps it into imgCur. If the child answers mid-turn, clearTimers()
// would drop that swap and leave the old picture behind, so every path settles a pending turn first.
let pendingImg = null;
function settleImage() {
  if (pendingImg) { imgCur.src = pendingImg; pendingImg = null; }
  art.classList.remove("turn");
}
function turnPage(name) {
  settleImage();
  if (!name || imgCur.getAttribute("src") === src(name)) return;
  imgNext.src = pendingImg = src(name);
  art.classList.remove("reveal", "turn"); void art.offsetWidth; art.classList.add("turn");
  later(settleImage, 500);
}

function setAnswers(list) {
  answers.innerHTML = "";
  if (!list) { answers.innerHTML = '<span class="none">Listening time. Nothing to answer yet.</span>'; return; }
  list.forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn"; b.type = "button";
    b.innerHTML = a.say + (a.note ? `<em>${a.note}</em>` : "");
    b.onclick = () => (a.tap ? go(a.go) : answer(a));
    answers.appendChild(b);
  });
}

function showHints(list) {
  hints.innerHTML = list.map((h, i) => `<button class="hint" type="button" data-i="${i}"><b>${h.b}</b>${h.label}</button>`).join("");
  hints.hidden = false;
  hints.querySelectorAll(".hint").forEach((el) => (el.onclick = () => go(list[+el.dataset.i].go)));
}

function go(key) {
  clearTimers(); settleImage();
  current = SCENES[key];
  bubble.hidden = true; hints.hidden = true; $("summary").hidden = true; againBtn.hidden = true; painting.hidden = true;
  mic.hidden = false;
  setAnswers(null);
  renderChapters(current.chapter);
  if (current.choose) state[current.choose[0]] = current.choose[1];
  if (current.build) return redraw();
  setPhase("READING");
  turnPage(val(current.img));
  readLines(current.lines, afterReading);
}

function afterReading() {
  if (current.ask) {
    markQuestion();
    setPhase("ASKING");
    setAnswers(current.ask);
    if (current.hintsToo) showHints(current.hintsToo);
  } else if (current.hints) {
    markQuestion();
    setPhase("ASKING", COPY.PICK);
    showHints(current.hints);
    setAnswers(current.hints.map((h) => ({ say: h.label, go: h.go, tap: true, note: "Tap a picture" })));
  } else if (current.then) {
    later(() => go(current.then), 500);
  } else if (current.end) {
    const built = ["h1", "h2", "h3"].map((k) => LABEL[state[k]]).filter(Boolean);
    $("summary").innerHTML = `<strong>Houses you built today</strong><span>${built.join(" · ")}</span>`;
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
function fail() {
  clearTimeout(listenTimer);
  errors++;
  setPhase("ERROR");
}
function heard(a) {
  hints.hidden = true;
  setAnswers(null);
  bubble.textContent = a.say; bubble.hidden = false;
  setPhase("HEARD", `You said “${a.say}”`);
  later(() => go(a.go), 1200);
}
// A demo answer button: act out a short listening moment first, then the same path as the mic.
function answer(a) {
  if (!current || !current.ask || !(phase === "ASKING" || phase === "ERROR")) return;
  clearTimers(); settleImage();
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
$("retry").onclick = () => { startListening(); mic.focus(); };

function redraw() {
  setPhase("GENERATING");
  imgNext.src = src(current.build);
  art.classList.remove("reveal", "turn");
  painting.hidden = false;
  readLines(current.lines);
  skipReading = null; skipBtn.disabled = true;
  later(() => {
    painting.hidden = true; bubble.hidden = true;
    setPhase("UPDATED");
    art.classList.add("reveal");
    later(() => {
      imgCur.src = src(current.build);
      art.classList.remove("reveal");
      go(current.then); // re-renders the journey, where the house icon turns into what was built
    }, 1700);
  }, 5000);
}

function restart() {
  clearTimers(); pendingImg = null; state = {}; errors = 0;
  art.classList.remove("reveal", "turn");
  imgCur.src = src("intro");
  go("intro");
}
$("restart").onclick = () => { $("confirm").hidden = false; $("restartNo").focus(); }; // "No" first: the safe answer
$("restartNo").onclick = () => ($("confirm").hidden = true);
$("restartYes").onclick = () => { showSettings(false); restart(); };
againBtn.onclick = restart;
skipBtn.onclick = () => skipReading && skipReading();

// Wait for a first tap: browsers only allow sound after the user interacts with the page.
renderChapters(0);
setAnswers(null);
setPhase("COVER", "");
$("cover").onclick = () => { $("cover").hidden = true; restart(); };
