// Check the prototype's story data: every answer leads to a scene that exists, every scene can be reached from
// the intro and leads on (or ends), every picture is on disk, and every line a child can hear has a narration clip.
//   node experiments/check_story.mjs
// Run `node experiments/narration_lines.mjs` first if lines changed. Exits with an error listing what is wrong.
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const ctx = vm.createContext({});
vm.runInContext(readFileSync(`${root}prototype/story.js`, "utf8") + "\n;this.SCENES = SCENES;", ctx);
vm.runInContext(readFileSync(`${root}prototype/audio/lines.js`, "utf8") + "\n;this.NARRATION = NARRATION;", ctx);
const { SCENES, NARRATION } = ctx;

// Same answer combinations as narration_lines.mjs (keys match the scenes' `choose` fields).
const STATES = ["paper", "straw"].map((h1) => ({ h1, h2: "wood", h3: "brick" }));
const val = (v, s) => (typeof v === "function" ? v(s) : v);
const next = (s) => [s.then, ...[s.ask, s.hints, s.hintsToo].flatMap((list) => (list || []).map((a) => a.go))].filter(Boolean);
const problems = [];

for (const [key, s] of Object.entries(SCENES)) {
  for (const to of next(s)) if (!SCENES[to]) problems.push(`${key}: leads to missing scene "${to}"`);
  if (!next(s).length && !s.end) problems.push(`${key}: dead end (no then / ask / hints, not the end)`);
  const pictures = new Set([s.build, ...STATES.map((st) => val(s.img, st))].filter(Boolean));
  for (const name of pictures) if (!existsSync(`${root}prototype/img/${name}.jpg`)) problems.push(`${key}: missing picture img/${name}.jpg`);
  for (const st of STATES) for (const line of s.lines) {
    const clip = NARRATION[val(line, st)];
    if (!clip) problems.push(`${key}: no narration for "${val(line, st)}"`);
    else if (!existsSync(`${root}prototype/audio/${clip}`)) problems.push(`${key}: missing clip audio/${clip}`);
  }
}

const reached = new Set(["intro"]), todo = ["intro"];
while (todo.length) for (const to of next(SCENES[todo.pop()])) if (SCENES[to] && !reached.has(to)) { reached.add(to); todo.push(to); }
for (const key of Object.keys(SCENES)) if (!reached.has(key)) problems.push(`${key}: cannot be reached from intro`);

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(unique.join("\n"));
  process.exit(1);
}
console.log(`${Object.keys(SCENES).length} scenes OK: all reachable, pictures and narration clips present`);
