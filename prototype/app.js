const STEPS = [
  { t: "책 읽어주기", d: "글자가 읽는 속도에 맞춰 하나씩 칠해져요. 아이는 그림을 보며 듣기만 해요.", time: "낭독: TTS (Meta에 없음, 별도)" },
  { t: "질문하기", d: "이야기가 멈추고 초록 마이크가 숨 쉬듯 깜빡여요. 글을 못 읽는 아이도 '내 차례'임을 알 수 있어요.", time: "대기" },
  { t: "아이가 말하기", d: "마이크를 꾹 누르고 말해요 (무전기 방식). 손을 떼면 말한 내용이 노란 말풍선으로 떠요.", time: "음성 인식 약 3초" },
  { t: "그림 다시 그리기", d: "동화가 아이 답을 먼저 받아주며 시간을 벌어요. 그동안 옛 그림은 흐려지고 붓이 칠해지는 연출이 나와요.", time: "글 3~7초 + 그림 12~20초 (동시 시작)" },
  { t: "새 장면", d: "새 그림이 붓질하듯 왼쪽부터 드러나고, 아이 답이 반영된 이야기가 이어져요.", time: "다음 질문으로" }
];

const SCENES = {
  intro: { step: 0, text: "첫째 돼지는 엄마 품을 떠나 작은 집을 지었어요.", then: "q1" },
  q1: { step: 1, text: "그런데 늑대가 후~ 불자 집이 훨훨 날아가 버렸어! 왜 날아갔을까?", ask: [
      { say: "가벼워서!", go: "q1ok" },
      { say: "몰라…", go: "q1hint", note: "모를 때" },
      { say: "늑대가 힘이 세서!", go: "q1other", note: "다른 생각" } ] },
  q1hint: { step: 1, text: "괜찮아! 같이 생각해 보자. 깃털처럼 가벼웠을까, 돌처럼 무거웠을까?", hints: [
      { b: "🪶", label: "가벼워", go: "q1ok" }, { b: "🪨", label: "무거워", go: "q1heavy" } ] },
  q1heavy: { step: 1, text: "음~ 돌처럼 무거웠다면 날아가지 않았을 거야. 그럼 깃털처럼 가벼웠나 봐!", then: "q2" },
  q1other: { step: 1, text: "맞아, 늑대 입김이 아주 셌지! 그리고 집도 아주아주 가벼웠대.", then: "q2" },
  q1ok: { step: 1, text: "맞아! 아주 가벼운 집이었구나.", then: "q2" },
  q2: { step: 1, text: "그럼 첫째 돼지는 무엇으로 집을 지었을까?", ask: [
      { say: "종이!", go: "draw" },
      { say: "아이스크림!", go: "q2silly", note: "엉뚱한 답" } ] },
  q2silly: { step: 1, text: "우와, 아이스크림 집! 그런데 햇볕에 사르르 녹아 버렸대. 다른 가벼운 걸로 지어 볼까?", ask: [
      { say: "종이!", go: "draw" } ] },
  draw: { step: 3, text: "종이로 지었구나! 첫째 돼지는 종이를 접고 또 접었어요…", redraw: true, then: "after" },
  after: { step: 4, text: "바스락바스락, 종이집이 완성됐어요! 그런데 저 멀리서 늑대가 또 오고 있어요.", end: true }
};

const $ = (id) => document.getElementById(id);
const art = $("art"), line = $("line"), mic = $("mic"), bubble = $("bubble"), hints = $("hints"), brush = $("brush"), answers = $("answers");
let timers = [], current = null, holding = false;

function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function clearTimers() { timers.forEach(clearTimeout); timers = []; try { speechSynthesis.cancel(); } catch (e) {} }

function renderSteps(active) {
  $("steps").innerHTML = STEPS.map((s, i) =>
    `<li class="${i === active ? "on" : ""}"><span class="n">${i + 1}</span><span><strong>${s.t}</strong><small>${s.d}<br><span class="time">${s.time}</span></small></span></li>`
  ).join("");
}

function speak(text) {
  if (!$("voice").checked) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = "ko-KR"; u.rate = 0.95; speechSynthesis.speak(u); } catch (e) {}
}

function readLine(text, done) {
  const words = text.split(" ");
  line.innerHTML = words.map((w) => `<span class="todo">${w}</span>`).join(" ");
  const spans = [...line.children];
  speak(text);
  spans.forEach((s, i) => later(() => {
    if (i > 0) spans[i - 1].className = "done";
    s.className = "now";
  }, i * 380));
  later(() => { spans.forEach((s) => (s.className = "done")); done && done(); }, words.length * 380 + 250);
}

function setAnswers(list) {
  answers.innerHTML = "";
  (list || []).forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn"; b.type = "button";
    b.innerHTML = a.say + (a.note ? `<em>${a.note}</em>` : "");
    b.onclick = () => answer(a);
    answers.appendChild(b);
  });
  if (!list) answers.innerHTML = '<span class="muted">지금은 듣는 차례예요.</span>';
}

function go(key) {
  clearTimers();
  current = SCENES[key];
  bubble.hidden = true; hints.hidden = true;
  mic.className = "mic"; mic.disabled = true; mic.innerHTML = MIC_ICON;
  mic.hidden = false; $("next").hidden = true;
  setAnswers(null);
  renderSteps(current.step);
  if (current.redraw) return redraw();
  readLine(current.text, () => {
    if (current.ask) {
      mic.className = "mic ready"; mic.disabled = false;
      setAnswers(current.ask);
    } else if (current.hints) {
      hints.innerHTML = current.hints.map((h, i) => `<button class="hint" type="button" data-i="${i}"><b>${h.b}</b>${h.label}</button>`).join("");
      hints.hidden = false;
      hints.querySelectorAll(".hint").forEach((el) => (el.onclick = () => go(current.hints[+el.dataset.i].go)));
      setAnswers(current.hints.map((h) => ({ say: h.label, go: h.go, note: "그림 버튼 누르기" })));
    } else if (current.then) {
      later(() => go(current.then), 700);
    } else if (current.end) {
      mic.hidden = true; $("next").hidden = false; $("next").focus();
    }
  });
}

function answer(a) {
  if (!current || !current.ask) return;
  clearTimers();
  setAnswers(null);
  renderSteps(2);
  mic.className = "mic listening"; mic.disabled = true;
  mic.innerHTML = '<span class="wave"><i></i><i></i><i></i><i></i></span>';
  later(() => {
    mic.className = "mic"; mic.innerHTML = MIC_ICON;
    bubble.textContent = a.say; bubble.hidden = false;
    later(() => go(a.go), 1300);
  }, 1500);
}

function redraw() {
  art.classList.remove("reveal"); art.classList.add("redrawing");
  brush.hidden = false; brush.classList.remove("go"); void brush.offsetWidth; brush.classList.add("go");
  readLine(current.text);
  later(() => {
    brush.hidden = true; bubble.hidden = true;
    art.classList.add("reveal");
    later(() => go(current.then), 1800);
  }, 5000);
}

function restart() {
  clearTimers();
  art.classList.remove("redrawing", "reveal");
  go("intro");
}

const MIC_ICON = mic.innerHTML;
function bindMic() {
  const m = mic;
  m.setAttribute("aria-label", "꾹 누르고 말하기");
  m.onpointerdown = (e) => {
    if (!current || !current.ask || m.disabled) return;
    holding = true; e.preventDefault();
    m.className = "mic listening"; m.innerHTML = '<span class="wave"><i></i><i></i><i></i><i></i></span>';
    renderSteps(2);
  };
  const release = () => { if (!holding) return; holding = false; answer(current.ask[0]); };
  m.onpointerup = release; m.onpointerleave = release;
  m.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && current && current.ask) { e.preventDefault(); answer(current.ask[0]); } };
}

$("restart").onclick = restart;
$("next").onclick = restart;
bindMic();
go("intro");
