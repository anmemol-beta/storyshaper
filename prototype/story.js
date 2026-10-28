// Story data shared by the prototype (app.js) and the narration generator (experiments/narration_lines.mjs).
const CHAPTERS = ["Start", "1st house", "2nd house", "3rd house", "The End"];
const LABEL = { paper: "paper house", straw: "straw house", wood: "wood house", brick: "brick house" };

// Scene fields: img (string or fn), chapter, lines (read in order), ask / hints / then / end,
// build (child-driven redraw: answer -> house), choose (remember child's pick).
// An `ask` answer with an `icon` is offered as a numbered picture card after three missed tries on that question;
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
