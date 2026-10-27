const STEPS = [
  { t: "책 읽어주기", d: "글자가 읽는 속도에 맞춰 하나씩 칠해져요. 아이는 그림을 보며 듣기만 해요.", time: "낭독: TTS (Meta에 없음, 별도)" },
  { t: "질문하기", d: "이야기가 멈추고 초록 마이크가 숨 쉬듯 깜빡여요. 글을 못 읽는 아이도 '내 차례'임을 알 수 있어요.", time: "대기" },
  { t: "아이가 말하기", d: "마이크를 꾹 누르고 말해요 (무전기 방식). 손을 떼면 말한 내용이 노란 말풍선으로 떠요.", time: "음성 인식 약 3초" },
  { t: "그림 다시 그리기", d: "동화가 아이 답을 먼저 받아주며 시간을 벌어요. 그동안 옛 그림은 흐려지고 붓이 칠해지는 연출이 나와요.", time: "글 3~7초 + 그림 12~20초 (동시 시작)" },
  { t: "다음 장 넘기기", d: "이야기에 정해진 장면은 미리 만들어 둔 그림으로 바로 넘어가요. 아이 답에 따라 갈리는 장면은 답이 나오는 즉시 미리 생성해 둘 수 있어요.", time: "즉시 (사전 생성)" }
];

const CHAPTERS = ["시작", "첫째 집", "둘째 집", "셋째 집", "끝"];
const LABEL = { paper: "종이집", straw: "짚집", wood: "나무집", brick: "벽돌집" };

// Scene fields: img (string or fn), chapter, lines (read in order), ask / hints / then / end,
// build (child-driven redraw: answer -> house), choose (remember child's pick).
const SCENES = {
  intro: { img: "intro", chapter: 0, lines: ["옛날 옛날에, 엄마 돼지와 아기돼지 삼형제가 살았어요.", "\"이제 다 컸으니 각자 집을 지어 보렴!\""], then: "p1" },

  p1: { img: "empty1", chapter: 1, lines: ["첫째 돼지는 넓은 들판에 집을 짓기로 했어요.", "첫째 돼지는 무엇으로 집을 지었을까?"], ask: [
      { say: "종이!", go: "b1paper" },
      { say: "짚!", go: "b1straw" },
      { say: "몰라…", go: "p1hint", note: "모를 때" },
      { say: "아이스크림!", go: "p1silly", note: "엉뚱한 답" }] },
  p1hint: { chapter: 1, lines: ["괜찮아! 들판에 있는 것 중에 골라 볼까?"], hints: [
      { b: "🌾", label: "짚", go: "b1straw" }, { b: "📄", label: "종이", go: "b1paper" }] },
  p1silly: { chapter: 1, lines: ["우와, 아이스크림 집! 그런데 햇볕에 사르르 녹아 버렸대.", "다른 걸로 지어 볼까?"], ask: [
      { say: "종이!", go: "b1paper" }, { say: "짚!", go: "b1straw" }] },
  b1paper: { chapter: 1, build: "paper_house", choose: ["h1", "paper"], lines: ["종이로 지었구나! 첫째 돼지는 종이를 접고 또 접었어요."], then: "d1" },
  b1straw: { chapter: 1, build: "straw_house", choose: ["h1", "straw"], lines: ["짚으로 지었구나! 첫째 돼지는 짚을 엮고 또 엮었어요."], then: "d1" },
  d1: { chapter: 1, lines: [(s) => `${LABEL[s.h1]}이 완성됐어요! 첫째 돼지는 기분이 좋았어요.`], then: "w1" },

  w1: { img: (s) => `wolf_${s.h1}`, chapter: 1, lines: ["그때 배고픈 늑대가 나타났어요. \"후~ 후~\"", "늑대가 바람을 불자, 집이 어떻게 됐을까?"], ask: [
      { say: "날아갔어!", go: "w1yes" },
      { say: "안 날아갔어!", go: "w1no", note: "다른 생각" }] },
  w1yes: { chapter: 1, lines: [(s) => `맞아! 가벼운 ${LABEL[s.h1]}은 훨훨 날아가 버렸어요.`, "첫째 돼지는 둘째에게 달려갔어요."], then: "p2" },
  w1no: { chapter: 1, lines: [(s) => `첫째 돼지도 그러길 바랐을 거야. 그런데 ${LABEL[s.h1]}은 너무 가벼워서 훨훨 날아가 버렸대.`, "첫째 돼지는 둘째에게 달려갔어요."], then: "p2" },

  p2: { img: "pig2_empty", chapter: 2, lines: ["둘째 돼지는 숲속에 집을 짓고 있었어요.", "둘째 돼지는 무엇으로 집을 지었을까?"], ask: [
      { say: "나무!", go: "b2wood" },
      { say: "과자!", go: "p2silly", note: "엉뚱한 답" }] },
  p2silly: { chapter: 2, lines: ["맛있겠다! 그런데 개미들이 와서 다 먹어 버렸대.", "숲에 많은 걸로 지어 볼까?"], ask: [
      { say: "나무!", go: "b2wood" }],
    hintsToo: [{ b: "🪵", label: "나무", go: "b2wood" }] },
  b2wood: { chapter: 2, build: "wood", choose: ["h2", "wood"], lines: ["나무로 지었구나! 둘째 돼지는 통나무를 하나하나 쌓았어요."], then: "d2" },
  d2: { chapter: 2, lines: ["종이집보다 훨씬 튼튼해 보였어요!"], then: "w2" },
  w2: { img: "wolf_wood", chapter: 2, lines: ["늑대가 또 찾아왔어요. \"후~ 후~ 쾅!\"", "나무집이 와르르 무너졌어요! 두 돼지는 셋째에게 뛰어갔어요."], then: "p3" },

  p3: { img: "pig3_empty", chapter: 3, lines: ["셋째 돼지는 생각했어요. \"이번엔 늑대가 절대 못 부수는 집을 지어야 해!\"", "무엇으로 지으면 좋을까?"], ask: [
      { say: "벽돌!", go: "b3brick" },
      { say: "돌!", go: "p3stone", note: "비슷한 답" },
      { say: "종이!", go: "p3again", note: "같은 실수" },
      { say: "몰라…", go: "p3hint", note: "모를 때" }] },
  p3stone: { chapter: 3, lines: ["좋은 생각이야! 돌처럼 단단한 벽돌로 지어 보자!"], then: "b3brick" },
  p3again: { chapter: 3, lines: [(s) => `음, ${LABEL[s.h1]}은 아까 훨훨 날아갔지?`, "무겁고 단단한 건 뭐가 있을까?"], hints: [
      { b: "🧱", label: "벽돌", go: "b3brick" }, { b: "🪶", label: "깃털", go: "p3feather" }] },
  p3hint: { chapter: 3, lines: ["같이 생각해 보자! 무거운 게 좋을까, 가벼운 게 좋을까?"], hints: [
      { b: "🧱", label: "무거운 벽돌", go: "b3brick" }, { b: "🪶", label: "가벼운 깃털", go: "p3feather" }] },
  p3feather: { chapter: 3, lines: ["깃털은 후~ 불면 날아가 버릴 거야. 무거운 걸로 해 볼까?"], hints: [
      { b: "🧱", label: "벽돌", go: "b3brick" }] },
  b3brick: { chapter: 3, build: "brick", choose: ["h3", "brick"], lines: ["벽돌로 지었구나! 셋째 돼지는 벽돌을 차곡차곡 쌓았어요."], then: "w3" },
  w3: { img: "wolf_brick", chapter: 3, lines: ["늑대가 볼이 빨개지도록 \"후~ 후~\" 불었어요.", "그런데 벽돌집은 꿈쩍도 하지 않았어요! 왜 안 날아갔을까?"], ask: [
      { say: "무거워서!", go: "w3ok" },
      { say: "튼튼해서!", go: "w3ok" }] },
  w3ok: { chapter: 3, lines: ["맞아! 무겁고 튼튼한 벽돌집은 바람에도 끄떡없었어요."], then: "end" },

  end: { img: "ending", chapter: 4, lines: ["늑대는 머리를 긁적이며 멀리 가 버렸어요.", "삼형제는 벽돌집 앞에서 신나게 춤을 췄답니다. 끝!"], end: true }
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
  try { const u = new SpeechSynthesisUtterance(text); u.lang = "ko-KR"; u.rate = 0.95; speechSynthesis.speak(u); } catch (e) {}
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
    spans.forEach((s, k) => laterRead(() => { if (k > 0) spans[k - 1].className = "done"; s.className = "now"; }, k * 340));
    laterRead(() => { spans.forEach((s) => (s.className = "done")); laterRead(() => readOne(i + 1), 650); }, words.length * 340 + 200);
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
  if (!list) { answers.innerHTML = '<span class="muted">지금은 듣는 차례예요.</span>'; return; }
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
    setAnswers(current.hints.map((h) => ({ say: h.label, go: h.go, tap: true, note: "그림 버튼 누르기" })));
  } else if (current.then) {
    later(() => go(current.then), 500);
  } else if (current.end) {
    const built = ["h1", "h2", "h3"].map((k) => LABEL[state[k]]).filter(Boolean);
    $("summary").innerHTML = `<strong>오늘 네가 지은 집</strong><span>${built.join(" · ")}</span>`;
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
