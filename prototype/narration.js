/* Story voices from the local narration server (narration/server.py).
   Narration.speak(lines, {key, language, onLine}) queues every line at once, then plays them in order.
   A line that is not voiced yet is waited for, so the story stays in the parent's voice; only a server error or a line
   still not voiced after LINE_WAIT seconds is read by the browser voice, so the story never stops.
   Narration.interject() says a short "let's see…" line in the parent's voice right away, to fill the wait after an answer.
   Narration.prepare(lines) only returns clip URLs, for pages that play audio themselves (the picture book).
   Narration.stop() cuts everything, e.g. when the child starts talking or the page changes.
   The parent's voice and "every character in this voice" come from voice.html (localStorage). */
const Narration = (() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const server = params.get("voiceServer") || "http://127.0.0.1:8100";
  const WAIT = 20;          // seconds the server may hold a request while the line is generated
  const REQUEST_MS = 600, CLIP_LOAD_MS = 800;
  // Seconds a line that isn't voiced yet may wait before the browser voice reads it (the server's maximum). The parent
  // chose a pause over a machine voice (10/31); a line takes ~2.5 s to voice in English, ~5-9 s in Korean on a Mac.
  const LINE_WAIT = 30;
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
  let speechFinish = null;  // resolves browser speech immediately when a scene is cancelled
  let speechPause = null, speechResume = null, readingController = null;
  let playback = "idle", source = null, paused = false;
  const listeners = new Set(), resumeWaiters = new Set();
  function setPlayback(state, nextSource = source) {
    playback = state;
    source = nextSource;
    for (const listener of listeners) listener(state);
  }
  function releasePause() { for (const resolve of resumeWaiters) resolve(); resumeWaiters.clear(); }
  function untilResumed() { return paused ? new Promise(resolve => resumeWaiters.add(resolve)) : Promise.resolve(); }
  function pause() {
    if (playback === "idle" || paused) return;
    paused = true;
    audio?.pause();
    speechPause?.();
    if (source === "browser" && "speechSynthesis" in window) speechSynthesis.pause();
    setPlayback("paused");
  }
  function resume() {
    if (!paused) return;
    paused = false;
    if (source === "browser" && "speechSynthesis" in window) { speechSynthesis.resume(); speechResume?.(); }
    if (audio && source === "parent") {
      const clip = audio, complete = finish;
      clip.play().catch(() => { if (audio === clip) complete?.(false); });
    }
    setPlayback(source ? "playing" : "loading");
    releasePause();
  }
  let filler = null;        // {audio, done, end} while an interjection plays
  let lastFiller = -1;
  // After an answer the next passage takes ~10 s to write and a few more to voice. Until its first line
  // starts, another short line is said every FILLER_GAP ms, at most FILLER_MAX times, so the wait isn't silent.
  const FILLER_GAP = 8000, FILLER_MAX = 3;
  let waiting = false;
  let fillerTimer = null;
  function stopWaiting() { waiting = false; clearTimeout(fillerTimer); }

  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const voiceId = () => stored("story-voice");
  const allRoles = () => stored("story-voice-all") === "1";

  function stopReading() {
    token += 1;
    readingController?.abort();
    readingController = null;
    if (audio) { audio.pause(); audio = null; }
    if (finish) finish(true);
    if (speechFinish) speechFinish();
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      if (speechSynthesis.paused) speechSynthesis.resume();
    }
    paused = false;
    releasePause();
    setPlayback("idle", null);
  }

  function stop() {
    lastKey = null;
    stopWaiting();
    stopReading();
    if (filler) { filler.audio.pause(); filler.end(); }
  }

  // beforePlay: awaited once the clip has loaded (the server may still be making it), right before it plays.
  function playClip(url, my, loadMs = CLIP_LOAD_MS, beforePlay = null) {
    return new Promise(resolve => {
      const clip = new Audio(url);
      let settled = false, started = false;
      const done = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clip.pause();
        if (audio === clip) audio = null;
        if (finish === done) finish = null;
        resolve(ok);
      };
      const timer = setTimeout(() => { if (!started) done(false); }, loadMs);
      audio = clip;
      finish = done;
      clip.onended = () => done(true);
      clip.onerror = () => done(false);
      clip.addEventListener("canplay", async () => {
        clearTimeout(timer);
        await untilResumed();
        if (settled || my !== token) return done(false);
        started = true;
        beforePlay?.();
        setPlayback("playing", "parent");
        clip.play().catch(() => done(false));
      }, {once: true});
      clip.load();
    });
  }

  // Fillers continue until the first story line is actually ready; then let the one talking finish.
  function firstLineReady() {
    stopWaiting();
    if (filler) { filler.audio.pause(); filler.end(); }
  }

  function browserSay(text, language) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window)) return setTimeout(resolve, 1500);
      const say = new SpeechSynthesisUtterance(text);
      say.lang = language === "ko" ? "ko-KR" : "en-US";
      let settled = false;
      let guard;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (speechFinish === done) { speechFinish = speechPause = speechResume = null; }
        resolve();
      };
      const arm = () => { guard = setTimeout(() => { speechSynthesis.cancel(); done(); }, 30000); };
      arm();
      speechFinish = done;
      speechPause = () => clearTimeout(guard);
      speechResume = arm;
      say.onend = done;
      say.onerror = done;
      speechSynthesis.speak(say);
    });
  }

  // voice: a voice id other than the saved one (a draft on voice.html). peek: only ask which lines are ready.
  async function request(path, options = {}, {signal, timeout = REQUEST_MS} = {}) {
    const controller = new AbortController();
    let timer;
    const cancel = () => controller.abort();
    if (signal?.aborted) throw new Error("narration_cancelled");
    signal?.addEventListener("abort", cancel, {once: true});
    try {
      return await Promise.race([
        fetch(server + path, {...options, signal: controller.signal}).then(async response => ({response, body: await response.json()})),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("narration_timeout")); }, timeout); })
      ]);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }

  async function queue(lines, {voice = null, peek = false, language = "en", background = false, signal} = {}) {
    const id = voice || voiceId();
    const {response, body} = await request("/api/voice/lines", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({lines, language, ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {}), ...(peek ? {peek} : {}),
        ...(background ? {priority: "background"} : {})})
    }, {signal});
    if (!response.ok) {
      // The saved voice was deleted on the server: forget it and read with the sample voice.
      if (!voice && id && (response.status === 404 || response.status === 409)) {
        if (id === voiceId()) {
          try { localStorage.removeItem("story-voice"); localStorage.removeItem("story-voice-name"); } catch {}
        }
        return queue(lines, {peek, language, background, signal});
      }
      throw new Error(`narration ${response.status}`);
    }
    return body.clips;
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
    const body = JSON.stringify({lines: asLines(lines), language, priority: "background", ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {})});
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
  function interject(language = "en") {
    if (!LANGUAGES.includes(language)) return;
    stopWaiting();
    waiting = true;
    sayFiller(language, FILLER_MAX - 1);
  }

  async function sayFiller(language, more) {
    if (!waiting) return;
    if (more > 0) fillerTimer = setTimeout(() => sayFiller(language, more - 1), FILLER_GAP);
    if (filler) return;                         // the previous one is still talking
    const list = fillers(language);
    lastFiller = (lastFiller + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    let clip;
    try { [clip] = await queue([{speakerId: "narrator", text: list[lastFiller]}], {language, background: true}); } catch { return; }
    if (!clip.ready || !waiting) return;
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
      queue(fillers(lang).map(text => ({speakerId: "narrator", text})), {language: lang, background: true}).catch(() => {});
    }
  }

  // key: skip re-reading the same passage (e.g. a re-render after an error). Only English has cloned voices.
  // A long line is voiced sentence by sentence, so its first sentence can play while the rest is made
  // (a Korean line takes ~5 s per sentence on a Mac). Short lines and single sentences stay whole.
  const LONG_LINE = 40;
  function sentences(text) {
    if (text.length <= LONG_LINE) return [text];
    const parts = text.match(/[^.!?…]+(?:[.!?…]+["”’']?|$)\s*/g)?.map(p => p.trim()).filter(Boolean) || [text];
    const merged = [];
    for (const part of parts) {                 // keep tiny pieces ("Oh!") with their neighbour
      if (merged.length && (part.length < 12 || merged[merged.length - 1].length < 12)) merged[merged.length - 1] += " " + part;
      else merged.push(part);
    }
    return merged;
  }

  async function speak(lines, {key = null, language = "en", onLine = () => {}} = {}) {
    if (key !== null && key === lastKey) return;
    lastKey = key;
    stopReading();
    const my = token;
    readingController = new AbortController();
    setPlayback("loading", null);
    const usable = lines.filter(line => String(line.text || "").trim());
    const parts = usable.flatMap((line, i) => sentences(String(line.text).trim()).map(text => ({speakerId: line.speakerId, text, line: i})));
    let clips = null;
    if (LANGUAGES.includes(language)) {
      try { clips = await queue(asLines(parts), {language, signal: readingController.signal}); } catch {}
    }
    if (my !== token) return;
    for (let k = 0; k < parts.length; k += 1) {
      await untilResumed();
      if (my !== token) return;
      if (k === 0 || parts[k].line !== parts[k - 1].line) onLine(parts[k].line);
      const clip = clips?.[k];
      const wait = clip?.ready ? 0 : LINE_WAIT;
      const played = clip ? await playClip(`${server}${clip.url}?wait=${wait}`, my, wait * 1000 + CLIP_LOAD_MS, k === 0 ? firstLineReady : null) : false;
      if (my !== token) return;
      if (!played) {
        if (k === 0) firstLineReady();
        await untilResumed();
        if (my !== token) return;
        setPlayback("playing", "browser");
        await browserSay(parts[k].text, language);
      }
    }
    if (my === token) { onLine(-1); setPlayback("idle", null); }
  }

  async function prefetch(lines, {language = "en"} = {}) {
    if (!LANGUAGES.includes(language)) return;
    const parts = asLines(lines).flatMap(line => sentences(line.text).map(text => ({...line, text})));
    try { await queue(parts, {language}); } catch {}
  }

  async function listVoices() {
    const {response, body} = await request("/api/voices", {}, {timeout: 2500});
    if (!response.ok || !Array.isArray(body.voices)) throw new Error("voices_unavailable");
    return body.voices;
  }

  function selectVoice(id, name = "") {
    stop();
    try {
      if (id) { localStorage.setItem("story-voice", id); localStorage.setItem("story-voice-name", name); }
      else { localStorage.removeItem("story-voice"); localStorage.removeItem("story-voice-name"); }
    } catch {}
  }

  return {speak, stop, pause, resume, prepare, prefetch, voiceAhead, readyCount, interject, warm, fillers, sentences, listVoices, selectVoice, voiceId,
    playbackState: () => playback, voiceSource: () => source,
    subscribe(listener) { listeners.add(listener); listener(playback); return () => listeners.delete(listener); },
    usesParentVoice: () => Boolean(voiceId()), voiceName: () => (voiceId() && stored("story-voice-name")) || null};
})();
