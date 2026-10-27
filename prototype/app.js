const STEPS = [
  { t: "Read aloud", d: "Each word lights up as it is read. The child just looks at the picture and listens.", time: "Narration: TTS (not in Meta API, separate)" },
  { t: "Ask", d: "The story pauses and the green mic gently pulses, so even a child who can't read yet knows it's their turn.", time: "Waiting" },
  { t: "Child speaks", d: "The child holds the mic and talks, like a walkie-talkie. When they let go, their words pop up in a yellow bubble.", time: "Speech to text ~3s" },
  { t: "Redraw the page", d: "The story repeats the child's idea first to buy time, while the old picture fades and a paintbrush animation plays.", time: "Text 3–7s + image 12–20s (started together)" },
  { t: "Turn the page", d: "Fixed story pages appear instantly from pre-made pictures. Pages that depend on the child's answer can be generated as soon as the answer comes in.", time: "Instant (pre-generated)" }
];

const CHAPTERS = ["Start", "1st house", "2nd house", "3rd house", "The End"];
const LABEL = { paper: "paper house", straw: "straw house", wood: "wood house", brick: "brick house" };

// Scene fields: img (string or fn), chapter, lines (read in order), ask / hints / then / end,
// build (child-driven redraw: answer -> house), choose (remember child's pick).
const SCENES = {
  intro: { img: "intro", chapter: 0, lines: ["Once upon a time, a mother pig lived with her three little pigs.", "\"You're all grown up now. Go and build your own homes!\""], then: "p1" },

  p1: { img: "empty1", chapter: 1, lines: ["The oldest pig found a sunny meadow.", "What do you think he built his house with?"], ask: [
      { say: "Paper!", go: "b1paper" },
      { say: "Straw!", go: "b1straw" },
      { say: "I don't know…", go: "p1hint", note: "Not sure" },
      { say: "Ice cream!", go: "p1silly", note: "Silly answer" }] },
  p1hint: { chapter: 1, lines: ["That's okay! Let's pick something from the meadow."], hints: [
      { b: "🌾", label: "Straw", go: "b1straw" }, { b: "📄", label: "Paper", go: "b1paper" }] },
  p1silly: { chapter: 1, lines: ["Wow, an ice cream house! But it melted in the warm sun.", "Let's try something else. What should he use?"], ask: [
      { say: "Paper!", go: "b1paper" }, { say: "Straw!", go: "b1straw" }] },
  b1paper: { chapter: 1, build: "paper_house", choose: ["h1", "paper"], lines: ["Paper! The oldest pig folded, and folded, and folded."], then: "d1" },
  b1straw: { chapter: 1, build: "straw_house", choose: ["h1", "straw"], lines: ["Straw! The oldest pig tied bundle after bundle."], then: "d1" },
  d1: { chapter: 1, lines: [(s) => `His ${LABEL[s.h1]} was finished! He felt very proud.`], then: "w1" },

  w1: { img: (s) => `wolf_${s.h1}`, chapter: 1, lines: ["Then along came a hungry wolf. \"Whoo… whoo…\"", "He blew and he blew. What happened to the house?"], ask: [
      { say: "It flew away!", go: "w1yes" },
      { say: "It stayed!", go: "w1no", note: "Different idea" }] },
  w1yes: { chapter: 1, lines: [(s) => `That's right! The light ${LABEL[s.h1]} blew away.`, "The oldest pig ran to his brother's house."], then: "p2" },
  w1no: { chapter: 1, lines: [(s) => `The oldest pig hoped so too. But the ${LABEL[s.h1]} was too light, and it blew away.`, "The oldest pig ran to his brother's house."], then: "p2" },

  p2: { img: "pig2_empty", chapter: 2, lines: ["The middle pig was building at the edge of the forest.", "What do you think he built his house with?"], ask: [
      { say: "Wood!", go: "b2wood" },
      { say: "Cookies!", go: "p2silly", note: "Silly answer" }] },
  p2silly: { chapter: 2, lines: ["Yum! But the ants came and ate it all up.", "Let's use something the forest has lots of."], ask: [
      { say: "Wood!", go: "b2wood" }],
    hintsToo: [{ b: "🪵", label: "Wood", go: "b2wood" }] },
  b2wood: { chapter: 2, build: "wood", choose: ["h2", "wood"], lines: ["Wood! The middle pig stacked log after log."], then: "d2" },
  d2: { chapter: 2, lines: [(s) => `It looked much stronger than the ${LABEL[s.h1]}!`], then: "w2" },
  w2: { img: "wolf_wood", chapter: 2, lines: ["But the wolf came back. \"Whoo… whoo… CRASH!\"", "The wood house tumbled down! The little pigs hurried away together."], then: "p3" },

  p3: { img: "pig3_empty", chapter: 3, lines: ["The youngest pig said, \"This time, let's build a house the wolf can never blow down!\"", "What should he build it with?"], ask: [
      { say: "Bricks!", go: "b3brick" },
      { say: "Stones!", go: "p3stone", note: "Close answer" },
      { say: "Paper!", go: "p3again", note: "Same mistake" },
      { say: "I don't know…", go: "p3hint", note: "Not sure" }] },
  p3stone: { chapter: 3, lines: ["Great idea! Let's use bricks. They're hard, just like stones!"], then: "b3brick" },
  p3again: { chapter: 3, lines: [(s) => `Hmm, remember the ${LABEL[s.h1]}? It blew away.`, "What is heavy and strong?"], hints: [
      { b: "🧱", label: "Bricks", go: "b3brick" }, { b: "🪶", label: "Feathers", go: "p3feather" }] },
  p3hint: { chapter: 3, lines: ["Let's think together! Should it be heavy, or light?"], hints: [
      { b: "🧱", label: "Heavy bricks", go: "b3brick" }, { b: "🪶", label: "Light feathers", go: "p3feather" }] },
  p3feather: { chapter: 3, lines: ["Feathers would fly away with one puff! Let's try something heavy."], hints: [
      { b: "🧱", label: "Bricks", go: "b3brick" }] },
  b3brick: { chapter: 3, build: "brick", choose: ["h3", "brick"], lines: ["Bricks! The youngest pig stacked them one by one."], then: "w3" },
  w3: { img: "wolf_brick", chapter: 3, lines: ["The wolf blew until his cheeks turned red. \"WHOOOO!\"", "But the brick house didn't move one bit! Why do you think it stayed?"], ask: [
      { say: "It's heavy!", go: "w3ok" },
      { say: "It's strong!", go: "w3ok" }] },
  w3ok: { chapter: 3, lines: ["That's right! The heavy, strong brick house stood up to the wind."], then: "end" },

  end: { img: "ending", chapter: 4, lines: ["The wolf scratched his head and wandered away.", "And the three little pigs danced in front of their brick house. The End!"], end: true }
};

const $ = (id) => document.getElementById(id);
const art = $("art"), line = $("line"), mic = $("mic"), bubble = $("bubble"), hints = $("hints"),
  brush = $("brush"), answers = $("answers"), imgCur = $("imgCur"), imgNext = $("imgNext"), next = $("next");
const MIC_ICON = mic.innerHTML;
const WAVE = '<span class="wave"><i></i><i></i><i></i><i></i></span>';
let timers = [], readTimers = [], current = null, state = {}, holding = false, skipReading = null;

const val = (v) => (typeof v === "function" ? v(state) : v);
const src = (name) => `img/${name}.jpg`;
function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function laterRead(fn, ms) { readTimers.push(setTimeout(fn, ms)); }
function clearTimers() { timers.forEach(clearTimeout); readTimers.forEach(clearTimeout); timers = []; readTimers = []; try { speechSynthesis.cancel(); } catch (e) {} }

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

function speak(text) {
  if (!$("voice").checked) return;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = 0.95; speechSynthesis.speak(u); } catch (e) {}
}

// Read lines one after another, highlighting word by word.
function readLines(lines, done) {
  const queue = lines.map(val);
  const finish = () => { skipReading = null; done && done(); };
  skipReading = () => { readTimers.forEach(clearTimeout); readTimers = []; try { speechSynthesis.cancel(); } catch (e) {} line.innerHTML = queue[queue.length - 1]; finish(); };
  const readOne = (i) => {
    if (i >= queue.length) return finish();
    const words = queue[i].split(" ");
    line.innerHTML = words.map((w) => `<span class="todo">${w}</span>`).join(" ");
    const spans = [...line.children];
    speak(queue[i]);
    spans.forEach((s, k) => laterRead(() => { if (k > 0) spans[k - 1].className = "done"; s.className = "now"; }, k * 300));
    laterRead(() => { spans.forEach((s) => (s.className = "done")); laterRead(() => readOne(i + 1), 650); }, words.length * 300 + 200);
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
restart();
