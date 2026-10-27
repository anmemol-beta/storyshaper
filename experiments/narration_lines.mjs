// List every line the prototype can read aloud, including each version of lines that depend on the
// child's earlier answers, and write them to prototype/audio/lines.json for the narration generator.
//   node experiments/narration_lines.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const ctx = vm.createContext({});
vm.runInContext(readFileSync(`${root}prototype/story.js`, "utf8") + "\n;this.SCENES = SCENES;", ctx);

// Every combination of answers a child can give (keys match the scenes' `choose` fields).
const STATES = ["paper", "straw"].map((h1) => ({ h1, h2: "wood", h3: "brick" }));

const texts = new Set();
for (const scene of Object.values(ctx.SCENES)) {
  for (const line of scene.lines) {
    if (typeof line === "function") STATES.forEach((s) => texts.add(line(s)));
    else texts.add(line);
  }
}

// File name = hash of the exact text, so app.js can find a clip from the line it is reading.
export const clipName = (text) => createHash("sha1").update(text).digest("hex").slice(0, 12);
const lines = [...texts].map((text) => ({ text, file: `${clipName(text)}.mp3` }));
mkdirSync(`${root}prototype/audio`, { recursive: true });
writeFileSync(`${root}prototype/audio/lines.json`, JSON.stringify(lines, null, 2));
// Same map as a script so the prototype works when opened straight from disk (file:// can't fetch JSON).
const map = Object.fromEntries(lines.map((l) => [l.text, l.file]));
writeFileSync(`${root}prototype/audio/lines.js`, `const NARRATION = ${JSON.stringify(map, null, 2)};\n`);
console.log(`${lines.length} lines -> prototype/audio/lines.json, lines.js`);
