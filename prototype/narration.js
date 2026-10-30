/* Story voices from the local narration server (narration/server.py).
   Narration.speak(lines, {key, language, onLine}) queues every line at once, then plays them in order.
   A line that is not ready in time, or any server error, is read by the browser voice instead, so the story never stops.
   Narration.interject() says a short "let's see…" line in the parent's voice right away, to fill the wait after an answer.
   Narration.prepare(lines) only returns clip URLs, for pages that play audio themselves (the picture book).
   Narration.stop() cuts everything, e.g. when the child starts talking or the page changes.
   The parent's voice and "every character in this voice" come from voice.html (localStorage). */
const Narration = (() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const server = params.get("voiceServer") || "http://127.0.0.1:8100";
  const WAIT = 20;          // seconds the server may hold a request while the line is generated
  // Said the moment a child answers, while the next page is being written and drawn. Generated ahead (warm()).
  const FILLERS = [
    "Ooh, what a good idea! Let's see what happens…",
    "Hmm, let me think about that…",
    "Let's turn the page and find out!",
    "I wonder what will happen next…",
    "Ready? Here we go…",
  ];
  const FILLERS_KO = [
    "우와, 좋은 생각이다! 어떻게 되는지 볼까?",
    "음, 어떻게 될까?",
    "다음 장을 넘겨서 알아보자!",
    "다음엔 무슨 일이 일어날까?",
    "준비됐니? 자, 간다!",
  ];
  const fillers = language => (language === "ko" ? FILLERS_KO : FILLERS);
  // Languages the server reads in the parent's voice (English: Chatterbox; Korean: Chatterbox Multilingual).
  const LANGUAGES = ["en", "ko"];
  let token = 0;
  let audio = null;
  let lastKey = null;
  let finish = null;        // resolves the clip that is playing, so stop() can end it early
  let filler = null;        // {audio, done, end} while an interjection plays
  let lastFiller = -1;

  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const voiceId = () => stored("story-voice");
  const allRoles = () => stored("story-voice-all") === "1";

  function stopReading() {
    token += 1;
    if (audio) { audio.pause(); audio = null; }
    if (finish) finish(true);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function stop() {
    stopReading();
    if (filler) { filler.audio.pause(); filler.end(); }
  }

  function playClip(url) {
    return new Promise(resolve => {
      const clip = new Audio(url);
      audio = clip;
      finish = resolve;
      clip.onended = () => resolve(true);
      clip.onerror = () => resolve(false);
      clip.play().catch(() => resolve(false));
    });
  }

  function browserSay(text, language) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window)) return setTimeout(resolve, 1500);
      const say = new SpeechSynthesisUtterance(text);
      say.lang = language === "ko" ? "ko-KR" : "en-US";
      const done = () => { clearTimeout(guard); resolve(); };
      const guard = setTimeout(resolve, 30000);
      say.onend = done;
      say.onerror = done;
      speechSynthesis.speak(say);
    });
  }

  // voice: a voice id other than the saved one (a draft on voice.html). peek: only ask which lines are ready.
  async function queue(lines, {voice = null, peek = false, language = "en"} = {}) {
    const id = voice || voiceId();
    const response = await fetch(`${server}/api/voice/lines`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({lines, language, ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {}), ...(peek ? {peek} : {})})
    });
    if (!response.ok) {
      // The saved voice was deleted on the server: forget it and read with the sample voice.
      if (!voice && id && (response.status === 404 || response.status === 409)) {
        try { localStorage.removeItem("story-voice"); localStorage.removeItem("story-voice-name"); } catch {}
        return queue(lines, {peek, language});
      }
      throw new Error(`narration ${response.status}`);
    }
    return (await response.json()).clips;
  }

  const asLines = lines => lines.map(line => typeof line === "string" ? {speakerId: "narrator", text: line}
    : {speakerId: line.speakerId || "narrator", text: line.text});

  // Clip URLs for these lines, in order (null if the server is unavailable or the language has no cloned voice).
  async function prepare(lines, {language = "en", voice = null} = {}) {
    if (!LANGUAGES.includes(language)) return null;
    try {
      const clips = await queue(asLines(lines), {voice, language});
      return clips.map(c => `${server}${c.url}?wait=${WAIT}`);
    } catch { return null; }
  }

  // Ask the server to voice lines later, in a way that survives leaving the page (navigator.sendBeacon):
  // the parent often taps "Start a story" right after saving. Plain-text body, so no CORS preflight.
  function voiceAhead(lines, {language = "en", voice = null} = {}) {
    const id = voice || voiceId();
    const body = JSON.stringify({lines: asLines(lines), language, ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {})});
    try { return navigator.sendBeacon(`${server}/api/voice/lines`, new Blob([body], {type: "text/plain"})); }
    catch { return false; }
  }

  // How many of these lines are already voiced (null if the server is unavailable). Queues nothing.
  async function readyCount(lines, {voice = null, language = "en"} = {}) {
    try { return (await queue(asLines(lines), {voice, peek: true, language})).filter(c => c.ready).length; }
    catch { return null; }
  }

  // A short line in the parent's voice, said at once. Skipped if it is not generated yet: a robot voice
  // saying "let me think" would be worse than a moment of quiet.
  async function interject(language = "en") {
    if (!LANGUAGES.includes(language)) return;
    const list = fillers(language);
    lastFiller = (lastFiller + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    let clip;
    try { [clip] = await queue([{speakerId: "narrator", text: list[lastFiller]}], {language}); } catch { return; }
    if (!clip.ready) return;
    if (filler) filler.end();
    const sound = new Audio(`${server}${clip.url}`);
    let resolve;
    const current = {audio: sound, done: new Promise(r => { resolve = r; }), end: () => { resolve(); if (filler === current) filler = null; }};
    filler = current;
    sound.onended = sound.onerror = current.end;
    sound.play().catch(current.end);
  }

  // Generate the fillers now, so interject() can play them instantly later.
  // Every language unless one is given.
  function warm(language = null) {
    for (const lang of language ? [language] : LANGUAGES) {
      queue(fillers(lang).map(text => ({speakerId: "narrator", text})), {language: lang}).catch(() => {});
    }
  }

  // key: skip re-reading the same passage (e.g. a re-render after an error). Only English has cloned voices.
  async function speak(lines, {key = null, language = "en", onLine = () => {}} = {}) {
    if (key !== null && key === lastKey) return;
    lastKey = key;
    stopReading();
    const my = token;
    const usable = lines.filter(line => String(line.text || "").trim());
    const urls = await prepare(usable, {language});
    // Let an interjection finish its sentence before the story goes on.
    if (filler) await Promise.race([filler.done, new Promise(r => setTimeout(r, 8000))]);
    for (let i = 0; i < usable.length; i += 1) {
      if (my !== token) return;
      onLine(i);
      const played = urls ? await playClip(urls[i]) : false;
      if (my !== token) return;
      if (!played) await browserSay(usable[i].text, language);
    }
    if (my === token) onLine(-1);
  }

  return {speak, stop, prepare, voiceAhead, readyCount, interject, warm, fillers,
    usesParentVoice: () => Boolean(voiceId()), voiceName: () => (voiceId() && stored("story-voice-name")) || null};
})();
