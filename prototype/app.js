const $ = (id) => document.getElementById(id);
const art = $("art"), line = $("line"), mic = $("mic"), bubble = $("bubble"), hints = $("hints"),
  brush = $("brush"), answers = $("answers"), imgCur = $("imgCur"), imgNext = $("imgNext"), next = $("next");
const MIC_ICON = mic.innerHTML;
const WAVE = '<span class="wave"><i></i><i></i><i></i><i></i></span>';
let timers = [], readTimers = [], current = null, state = {}, holding = false, skipReading = null, playing = null;

const val = (v) => (typeof v === "function" ? v(state) : v);
const src = (name) => `img/${name}.jpg`;
function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function laterRead(fn, ms) { readTimers.push(setTimeout(fn, ms)); }
function stopVoice() {
  try { speechSynthesis.cancel(); } catch (e) {}
  if (playing) { playing.onended = playing.onerror = null; playing.pause(); playing = null; }
}
function clearTimers() { timers.forEach(clearTimeout); readTimers.forEach(clearTimeout); timers = []; readTimers = []; stopVoice(); }

// preload so page turns are instant
Object.values(SCENES).forEach((s) => { const n = typeof s.img === "string" ? s.img : s.build; if (n) new Image().src = src(n); });
["wolf_paper", "wolf_straw"].forEach((n) => (new Image().src = src(n)));

function renderSteps(active) {
  $("steps").innerHTML = STEPS.map((s, i) =>
    `<li class="${i === active ? "on" : ""}"><span class="n">${i + 1}</span><span><strong>${s.t}</strong><small>${s.d}<br><span class="time">${s.time}</span></small></span></li>`
  ).join("");
}
function renderChapters(active) {
  $("chapters").innerHTML = CHAPTERS.map((c, i) => `<li class="${i < active ? "past" : i === active ? "on" : ""}">${c}</li>`).join("");
}

// Browser voice, only used for lines that have no pre-generated clip.
function speak(text) {
  try { const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = 0.95; speechSynthesis.speak(u); } catch (e) {}
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
  const finish = () => { skipReading = null; done && done(); };
  skipReading = () => { readTimers.forEach(clearTimeout); readTimers = []; stopVoice(); line.innerHTML = queue[queue.length - 1]; finish(); };
  const readOne = (i) => {
    if (i >= queue.length) return finish();
    const text = queue[i], words = text.split(" ");
    line.innerHTML = words.map((w) => `<span class="todo">${w}</span>`).join(" ");
    const spans = [...line.children];
    const lineDone = () => { spans.forEach((s) => (s.className = "done")); laterRead(() => readOne(i + 1), 450); };
    const timed = () => { highlight(spans, words.length * 300); laterRead(lineDone, words.length * 300 + 200); };
    const clip = $("voice").checked && typeof NARRATION !== "undefined" && NARRATION[text];
    if (!clip) {
      if ($("voice").checked) speak(text);
      return timed();
    }
    const audio = (playing = new Audio(`audio/${clip}`));
    let fellBack = false;
    const fallBack = () => { if (fellBack) return; fellBack = true; playing = null; timed(); };
    audio.onloadedmetadata = () => highlight(spans, audio.duration * 1000);
    audio.onended = () => { playing = null; lineDone(); };
    audio.onerror = fallBack;
    audio.play().catch(fallBack);
  };
  readOne(0);
}

function turnPage(name) {
  if (!name || imgCur.getAttribute("src") === src(name)) return;
  imgNext.src = src(name);
  art.classList.remove("reveal", "turn"); void art.offsetWidth; art.classList.add("turn");
  later(() => { imgCur.src = src(name); art.classList.remove("turn"); }, 700);
}

function setAnswers(list) {
  answers.innerHTML = "";
  if (!list) { answers.innerHTML = '<span class="muted">Listening time. Nothing to answer yet.</span>'; return; }
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
  clearTimers();
  current = SCENES[key];
  bubble.hidden = true; hints.hidden = true; $("summary").hidden = true;
  mic.className = "mic"; mic.disabled = true; mic.innerHTML = MIC_ICON; mic.hidden = false; next.hidden = true;
  setAnswers(null);
  renderChapters(current.chapter);
  if (current.choose) state[current.choose[0]] = current.choose[1];
  if (current.build) return redraw();
  renderSteps(key === "intro" || current.img ? 4 : 0);
  turnPage(val(current.img));
  later(() => renderSteps(0), current.img ? 900 : 0);
  readLines(current.lines, afterReading);
}

function afterReading() {
  if (current.ask) {
    renderSteps(1);
    mic.className = "mic ready"; mic.disabled = false;
    setAnswers(current.ask);
    if (current.hintsToo) showHints(current.hintsToo);
  } else if (current.hints) {
    renderSteps(1);
    showHints(current.hints);
    setAnswers(current.hints.map((h) => ({ say: h.label, go: h.go, tap: true, note: "Tap a picture" })));
  } else if (current.then) {
    later(() => go(current.then), 500);
  } else if (current.end) {
    const built = ["h1", "h2", "h3"].map((k) => LABEL[state[k]]).filter(Boolean);
    $("summary").innerHTML = `<strong>Houses you built today</strong><span>${built.join(" · ")}</span>`;
    $("summary").hidden = false;
    mic.hidden = true; next.hidden = false; next.focus();
  }
}

function answer(a) {
  if (!current || !current.ask) return;
  clearTimers();
  hints.hidden = true;
  setAnswers(null);
  renderSteps(2);
  mic.className = "mic listening"; mic.disabled = true; mic.innerHTML = WAVE;
  later(() => {
    mic.className = "mic"; mic.innerHTML = MIC_ICON;
    bubble.textContent = a.say; bubble.hidden = false;
    later(() => go(a.go), 1200);
  }, 1300);
}

function redraw() {
  renderSteps(3);
  imgNext.src = src(current.build);
  art.classList.remove("reveal", "turn"); art.classList.add("redrawing");
  brush.hidden = false; brush.classList.remove("go"); void brush.offsetWidth; brush.classList.add("go");
  readLines(current.lines);
  skipReading = null;
  later(() => {
    brush.hidden = true; bubble.hidden = true;
    art.classList.add("reveal");
    later(() => {
      imgCur.src = src(current.build);
      art.classList.remove("redrawing", "reveal");
      go(current.then);
    }, 1700);
  }, 5000);
}

mic.onpointerdown = (e) => {
  if (!current || !current.ask || mic.disabled) return;
  holding = true; e.preventDefault();
  mic.className = "mic listening"; mic.innerHTML = WAVE;
  renderSteps(2);
};
const release = () => { if (!holding) return; holding = false; answer(current.ask[0]); };
mic.onpointerup = release; mic.onpointerleave = release;
mic.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && current && current.ask) { e.preventDefault(); answer(current.ask[0]); } };

function restart() {
  clearTimers(); state = {};
  art.classList.remove("redrawing", "reveal", "turn");
  imgCur.src = src("intro");
  go("intro");
}
$("restart").onclick = restart;
next.onclick = restart;
$("skip").onclick = () => skipReading && skipReading();
// Wait for a first tap: browsers only allow sound after the user interacts with the page.
renderChapters(0);
renderSteps(0);
setAnswers(null);
$("cover").onclick = () => { $("cover").hidden = true; restart(); };
