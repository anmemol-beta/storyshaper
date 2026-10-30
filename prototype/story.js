// Story data shared by the prototype (app.js) and the narration generator (experiments/narration_lines.mjs).
const CHAPTERS = ["Start", "1st house", "2nd house", "3rd house", "The End"];
const LABEL = { paper: "paper house", straw: "straw house", wood: "wood house", brick: "brick house" };

// Scene fields: img (string or fn), chapter, lines (read in order), ask / hints / then / end,
// build (child-driven redraw: answer -> house), choose (remember child's pick).
// An `ask` answer with an `icon` is offered as a numbered touch card after the first missed answer;
// only answers that move the story forward get one.
const SCENES = {
  intro: { img: "intro", chapter: 0, lines: ["Once upon a time, a mother pig lived with her three little pigs.", "\"You're all grown up now. Go and build your own homes!\""], then: "p1" },

  p1: { img: "empty1", chapter: 1, lines: ["The oldest pig found a sunny meadow.", "What do you think he built his house with?"], ask: [
      { say: "Paper!", go: "b1paper", icon: "📄" },
      { say: "Straw!", go: "b1straw", icon: "🌾" },
      { say: "I don't know…", go: "p1hint", note: "Not sure" },
      { say: "Ice cream!", go: "p1silly", note: "Silly answer" }] },
  p1hint: { chapter: 1, lines: ["That's okay! Let's pick something from the meadow."], hints: [
      { b: "🌾", label: "Straw", go: "b1straw" }, { b: "📄", label: "Paper", go: "b1paper" }] },
  p1silly: { chapter: 1, lines: ["Wow, an ice cream house! But it melted in the warm sun.", "Let's try something else. What should he use?"], ask: [
      { say: "Paper!", go: "b1paper", icon: "📄" }, { say: "Straw!", go: "b1straw", icon: "🌾" }] },
  b1paper: { chapter: 1, build: "paper_house", choose: ["h1", "paper"], lines: ["Paper! The oldest pig folded, and folded, and folded."], then: "d1" },
  b1straw: { chapter: 1, build: "straw_house", choose: ["h1", "straw"], lines: ["Straw! The oldest pig tied bundle after bundle."], then: "d1" },
  d1: { chapter: 1, lines: [(s) => `His ${LABEL[s.h1]} was finished! He felt very proud.`], then: "w1" },

  w1: { img: (s) => `wolf_${s.h1}`, chapter: 1, lines: ["Then along came a hungry wolf. \"Whoo… whoo…\"", "He blew and he blew. What happened to the house?"], ask: [
      { say: "It flew away!", go: "w1yes", icon: "🌬️" },
      { say: "It stayed!", go: "w1no", note: "Different idea", icon: "🏠" }] },
  w1yes: { chapter: 1, lines: [(s) => `That's right! The light ${LABEL[s.h1]} blew away.`, "The oldest pig ran to his brother's house."], then: "p2" },
  w1no: { chapter: 1, lines: [(s) => `The oldest pig hoped so too. But the ${LABEL[s.h1]} was too light, and it blew away.`, "The oldest pig ran to his brother's house."], then: "p2" },

  p2: { img: "pig2_empty", chapter: 2, lines: ["The middle pig was building at the edge of the forest.", "What do you think he built his house with?"], ask: [
      { say: "Wood!", go: "b2wood", icon: "🪵" },
      { say: "Cookies!", go: "p2silly", note: "Silly answer" }] },
  p2silly: { chapter: 2, lines: ["Yum! But the ants came and ate it all up.", "Let's use something the forest has lots of."], ask: [
      { say: "Wood!", go: "b2wood", icon: "🪵" }],
    hintsToo: [{ b: "🪵", label: "Wood", go: "b2wood" }] },
  b2wood: { chapter: 2, build: "wood", choose: ["h2", "wood"], lines: ["Wood! The middle pig stacked log after log."], then: "d2" },
  d2: { chapter: 2, lines: [(s) => `It looked much stronger than the ${LABEL[s.h1]}!`], then: "w2" },
  w2: { img: "wolf_wood", chapter: 2, lines: ["But the wolf came back. \"Whoo… whoo… CRASH!\"", "The wood house tumbled down! The little pigs hurried away together."], then: "p3" },

  p3: { img: "pig3_empty", chapter: 3, lines: ["The youngest pig said, \"This time, let's build a house the wolf can never blow down!\"", "What should he build it with?"], ask: [
      { say: "Bricks!", go: "b3brick", icon: "🧱" },
      { say: "Stones!", go: "p3stone", note: "Close answer", icon: "🪨" },
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
      { say: "It's heavy!", go: "w3ok", icon: "🏋️" },
      { say: "It's strong!", go: "w3ok", icon: "💪" }] },
  w3ok: { chapter: 3, lines: ["That's right! The heavy, strong brick house stood up to the wind."], then: "end" },

  end: { img: "ending", chapter: 4, lines: ["The wolf scratched his head and wandered away.", "And the three little pigs danced in front of their brick house. The End!"], end: true }
};

// Keep SCENES, CHAPTERS and LABEL as the English source for the existing narration generator.
// The book chooses a language at render time; scene IDs and choices stay the same in both languages.
const CHAPTERS_KO = ["시작", "첫 번째 집", "두 번째 집", "세 번째 집", "이야기 끝"];
const LABEL_KO = { paper: "종이집", straw: "짚집", wood: "나무집", brick: "벽돌집" };
const SCENES_KO = {
  intro: { ...SCENES.intro, lines: ["옛날 옛적에 엄마 돼지와 아기돼지 삼형제가 살았어요.", "엄마 돼지가 말했어요. ‘이제 다 컸구나. 너희만의 집을 지어보렴!’"] },
  p1: { ...SCENES.p1, lines: ["첫째 돼지는 햇살이 따뜻한 풀밭을 찾았어요.", "무엇으로 집을 지었을까?"], ask: [
    { say: "종이요!", go: "b1paper", icon: "📄" }, { say: "짚이요!", go: "b1straw", icon: "🌾" },
    { say: "잘 모르겠어요…", go: "p1hint", note: "도움이 필요해요" }, { say: "아이스크림이요!", go: "p1silly", note: "엉뚱한 생각" }
  ] },
  p1hint: { ...SCENES.p1hint, lines: ["괜찮아! 풀밭에서 찾을 수 있는 걸 골라보자."], hints: [
    { b: "🌾", label: "짚", go: "b1straw" }, { b: "📄", label: "종이", go: "b1paper" }
  ] },
  p1silly: { ...SCENES.p1silly, lines: ["우아, 아이스크림 집이구나! 그런데 따뜻한 햇볕에 녹아버렸어요.", "다른 재료로 해볼까? 무엇을 쓰면 좋을까?"], ask: [
    { say: "종이요!", go: "b1paper", icon: "📄" }, { say: "짚이요!", go: "b1straw", icon: "🌾" }
  ] },
  b1paper: { ...SCENES.b1paper, lines: ["종이구나! 첫째 돼지는 종이를 접고 또 접었어요."] },
  b1straw: { ...SCENES.b1straw, lines: ["짚이구나! 첫째 돼지는 짚을 한 묶음씩 묶었어요."] },
  d1: { ...SCENES.d1, lines: [(s) => `${LABEL_KO[s.h1]}을 다 지었어요! 첫째 돼지는 무척 뿌듯했어요.`] },
  w1: { ...SCENES.w1, lines: ["그때 배고픈 늑대가 나타났어요. ‘후우… 후우…’", "늑대가 입김을 힘껏 불었어요. 집은 어떻게 되었을까?"], ask: [
    { say: "날아갔어요!", go: "w1yes", icon: "🌬️" }, { say: "그대로 있었어요!", go: "w1no", icon: "🏠", note: "다른 생각" }
  ] },
  w1yes: { ...SCENES.w1yes, lines: [(s) => `맞아! 가벼운 ${LABEL_KO[s.h1]}은 바람에 날아갔어요.`, "첫째 돼지는 동생의 집으로 달려갔어요."] },
  w1no: { ...SCENES.w1no, lines: [(s) => `첫째 돼지도 그러길 바랐어요. 하지만 ${LABEL_KO[s.h1]}은 너무 가벼워서 바람에 날아갔어요.`, "첫째 돼지는 동생의 집으로 달려갔어요."] },
  p2: { ...SCENES.p2, lines: ["둘째 돼지는 숲 가장자리에 집을 짓고 있었어요.", "무엇으로 집을 지었을까?"], ask: [
    { say: "나무요!", go: "b2wood", icon: "🪵" }, { say: "과자요!", go: "p2silly", note: "엉뚱한 생각" }
  ] },
  p2silly: { ...SCENES.p2silly, lines: ["맛있겠다! 그런데 개미들이 와서 모두 먹어버렸어요.", "숲에 많이 있는 재료를 써볼까?"], ask: [{ say: "나무요!", go: "b2wood", icon: "🪵" }],
    hintsToo: [{ b: "🪵", label: "나무", go: "b2wood" }] },
  b2wood: { ...SCENES.b2wood, lines: ["나무구나! 둘째 돼지는 통나무를 하나씩 쌓았어요."] },
  d2: { ...SCENES.d2, lines: [(s) => `${LABEL_KO[s.h1]}보다 훨씬 튼튼해 보였어요!`] },
  w2: { ...SCENES.w2, lines: ["하지만 늑대가 다시 나타났어요. ‘후우… 후우… 와르르!’", "나무집이 무너졌어요! 아기돼지들은 함께 서둘러 도망쳤어요."] },
  p3: { ...SCENES.p3, lines: ["셋째 돼지가 말했어요. ‘이번엔 늑대가 절대 날려버릴 수 없는 집을 짓자!’", "무엇으로 집을 지으면 좋을까?"], ask: [
    { say: "벽돌이요!", go: "b3brick", icon: "🧱" }, { say: "돌이요!", go: "p3stone", icon: "🪨", note: "비슷한 재료" },
    { say: "종이요!", go: "p3again", note: "앞에서 쓴 재료" }, { say: "잘 모르겠어요…", go: "p3hint", note: "도움이 필요해요" }
  ] },
  p3stone: { ...SCENES.p3stone, lines: ["좋은 생각이야! 돌처럼 단단한 벽돌을 써보자!"] },
  p3again: { ...SCENES.p3again, lines: [(s) => `음, 아까 ${LABEL_KO[s.h1]}을 기억하니? 바람에 날아갔지.`, "무겁고 튼튼한 재료는 무엇일까?"], hints: [
    { b: "🧱", label: "벽돌", go: "b3brick" }, { b: "🪶", label: "깃털", go: "p3feather" }
  ] },
  p3hint: { ...SCENES.p3hint, lines: ["함께 생각해보자! 무거운 재료와 가벼운 재료 중 무엇이 좋을까?"], hints: [
    { b: "🧱", label: "무거운 벽돌", go: "b3brick" }, { b: "🪶", label: "가벼운 깃털", go: "p3feather" }
  ] },
  p3feather: { ...SCENES.p3feather, lines: ["깃털은 입김 한 번에도 날아갈 거야! 무거운 재료로 해보자."], hints: [
    { b: "🧱", label: "벽돌", go: "b3brick" }
  ] },
  b3brick: { ...SCENES.b3brick, lines: ["벽돌이구나! 셋째 돼지는 벽돌을 하나씩 차곡차곡 쌓았어요."] },
  w3: { ...SCENES.w3, lines: ["늑대는 볼이 빨개질 때까지 입김을 불었어요. ‘후우우우!’", "하지만 벽돌집은 꿈쩍도 하지 않았어요! 왜 무너지지 않았을까?"], ask: [
    { say: "무거워서요!", go: "w3ok", icon: "🏋️" }, { say: "튼튼해서요!", go: "w3ok", icon: "💪" }
  ] },
  w3ok: { ...SCENES.w3ok, lines: ["맞아! 무겁고 튼튼한 벽돌집은 바람에도 끄떡없었어요."] },
  end: { ...SCENES.end, lines: ["늑대는 머리를 긁적이며 멀리 떠나갔어요.", "아기돼지 삼형제는 벽돌집 앞에서 신나게 춤을 추었어요. 이야기 끝!"] }
};
function storyForLanguage(language) {
  return language === "ko"
    ? { scenes: SCENES_KO, chapters: CHAPTERS_KO, labels: LABEL_KO }
    : { scenes: SCENES, chapters: CHAPTERS, labels: LABEL };
}
