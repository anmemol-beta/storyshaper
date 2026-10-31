/* Story voices from the local narration server (narration/server.py).
   The reader prepares a scene (prepareScene) before revealing the page, then calls speak(..., {scene:true, prepared}).
   The page opens as soon as the scene's first sentence is voiced; the others are voiced and downloaded, in order,
   while the first ones play (10/31: waiting for a whole scene took 20-100 s).
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
  // A hosted server (deploy/modal_voice.py) is ~1 s away from Korea; a server that is down fails at once anyway.
  const REQUEST_MS = 4000, CLIP_LOAD_MS = 800;
  // Seconds a line that isn't voiced yet may wait before the browser voice reads it (the server's maximum). The parent
  // chose a pause over a machine voice (10/31); a line takes ~2.5 s to voice in English, ~5-9 s in Korean on a Mac.
  const LINE_WAIT = 30;
  const LINE_TRIES = 6;     // asks of LINE_WAIT seconds each before a scene sentence counts as failed
  const sceneCache = new Map();
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
  function playClip(url, my, loadMs = CLIP_LOAD_MS, beforePlay = null, onPlaying = null) {
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
      clip.addEventListener("playing", () => {
        if (settled || my !== token) return;
        beforePlay?.();
        setPlayback("playing", "parent");
        onPlaying?.();
      }, {once: true});
      clip.addEventListener("canplay", async () => {
        clearTimeout(timer);
        await untilResumed();
        if (settled || my !== token) return done(false);
        started = true;
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

  function browserSay(text, language, onStart = () => {}) {
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
      say.onstart = () => { if (!settled) { setPlayback("playing", "browser"); onStart(); } };
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

  async function queue(lines, {voice = null, peek = false, language = "en", background = false, signal, timeout} = {}) {
    const id = voice || voiceId();
    const {response, body} = await request("/api/voice/lines", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({lines, language, ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {}), ...(peek ? {peek} : {}),
        ...(background ? {priority: "background"} : {})})
    }, {signal, ...(timeout ? {timeout} : {})});
    if (!response.ok) {
      // The saved voice was deleted on the server: forget it and read with the sample voice.
      if (!voice && id && (response.status === 404 || response.status === 409)) {
        if (id === voiceId()) {
          try { localStorage.removeItem("story-voice"); localStorage.removeItem("story-voice-name"); } catch {}
        }
        return queue(lines, {peek, language, background, signal, timeout});
      }
      throw new Error(`narration ${response.status}`);
    }
    return body.clips;
  }

  const asLines = lines => lines.map(line => {
    if (typeof line === "string") return {speakerId: "narrator", text: line};
    const spoken = {speakerId: line.speakerId || "narrator", text: line.text};
    // Keep delivery directions separate from the words the voice actually reads.
    for (const field of ["kind", "tone", "emotion"]) {
      if (line[field] !== undefined) spoken[field] = line[field];
    }
    return spoken;
  });

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

  // Voice the authored pages that can open next (the opening page without a story state) before the child
  // answers, so a tapped choice opens without waiting. The page actually opened is still asked for first.
  function ahead(storyState = null, language = "en", {voice = null} = {}) {
    if (!LANGUAGES.includes(language)) return;
    const id = voice || voiceId();
    request("/api/voice/ahead", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({language, ...(storyState ? {storyState} : {}), ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {})})
    }).catch(() => {});
  }

  // The whole authored book in reading order, as warmup (a beacon, like voiceAhead). With peek, nothing is
  // queued and the reply says how much is voiced: {pages, lines, ready}, or null if the server is unavailable.
  async function voiceBook(language = "en", {voice = null, peek = false} = {}) {
    const id = voice || voiceId();
    const body = JSON.stringify({language, book: true, ...(peek ? {peek} : {}), ...(id ? {voiceId: id} : {}), ...(allRoles() ? {allRoles: true} : {})});
    if (!peek) {
      try { return navigator.sendBeacon(`${server}/api/voice/ahead`, new Blob([body], {type: "text/plain"})); }
      catch { return false; }
    }
    try {
      const {response, body: count} = await request("/api/voice/ahead", {method: "POST", headers: {"Content-Type": "application/json"}, body});
      return response.ok ? count : null;
    } catch { return null; }
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

  function sceneParts(lines) {
    return asLines(lines).filter(line => String(line.text || "").trim())
      .flatMap((line, i) => sentences(String(line.text).trim()).map(text => ({...line, text, line: i})));
  }

  const sceneSignature = (parts, language) => JSON.stringify([voiceId(), allRoles(), language, asLines(parts)]);
  function discardScene(signature, expected = null) {
    const asset = sceneCache.get(signature);
    if (!asset || (expected && asset !== expected)) return;
    asset.invalid = true;
    asset.controller.abort();
    for (const url of asset.urls) if (url) URL.revokeObjectURL(url);
    sceneCache.delete(signature);
  }
  function getPreparedScene(lines, {language = "en"} = {}) {
    return sceneCache.get(sceneSignature(sceneParts(lines), language)) || null;
  }
  const cancelled = signal => { if (signal?.aborted) throw new Error("narration_cancelled"); };

  function abortable(promise, signal) {
    cancelled(signal);
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error("narration_cancelled")); };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, {once: true});
      Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  // One scene sentence as a local blob URL. The server holds each ask up to LINE_WAIT s while it voices the line.
  async function fetchLine(url, signal) {
    for (let attempt = 0; attempt < LINE_TRIES; attempt++) {
      const response = await abortable(fetch(`${server}${url}?wait=${LINE_WAIT}`, {signal}), signal);
      if (response.status === 504) continue;              // still being voiced: ask again
      if (!response.ok) throw new Error(`scene_line_${response.status}`);
      const blob = await abortable(response.blob(), signal);
      if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error("invalid_scene_line");
      cancelled(signal);
      return URL.createObjectURL(blob);
    }
    throw new Error("scene_line_timeout");
  }

  // Resolves once the first sentence is downloaded. The rest keep downloading in order on the asset's own
  // controller, so they survive the caller moving on and stop only when the asset is discarded.
  async function prepareScene(lines, {language = "en", signal, retry = false, onProgress = () => {}} = {}) {
    if (!LANGUAGES.includes(language)) throw new Error("scene_language_unavailable");
    cancelled(signal);
    const parts = sceneParts(lines);
    if (!parts.length || parts.length > 64) throw new Error("invalid_scene_lines");
    const signature = sceneSignature(parts, language);
    if (retry) discardScene(signature);
    if (sceneCache.has(signature)) return sceneCache.get(signature);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, {once: true});
    const asset = {signature, parts, urls: [], controller, loads: []};
    try {
      const clips = await queue(asLines(parts), {language, signal: controller.signal, timeout: REQUEST_MS});
      if (!Array.isArray(clips) || clips.length !== parts.length) throw new Error("invalid_scene_audio");
      if (signature !== sceneSignature(parts, language)) throw new Error("scene_voice_changed");
      let previous = Promise.resolve();
      asset.loads = clips.map((clip, k) => previous = previous.then(() => fetchLine(clip.url, controller.signal)).then(url => {
        asset.urls[k] = url;
        onProgress({ready: k + 1, total: clips.length});
        return url;
      }));
      for (const load of asset.loads) load.catch(() => {});   // a failure surfaces when that sentence is played
      await asset.loads[0];
      cancelled(controller.signal);
      if (signature !== sceneSignature(parts, language)) throw new Error("scene_voice_changed");
      signal?.removeEventListener("abort", abort);
      sceneCache.set(signature, asset);
      // Keep a few pages for back/replay.
      for (const [key, kept] of sceneCache) {
        if (sceneCache.size <= 6) break;
        if (kept.playing || key === signature) continue;
        discardScene(key, kept);
      }
      return asset;
    } catch (error) {
      controller.abort();
      for (const url of asset.urls) if (url) URL.revokeObjectURL(url);
      signal?.removeEventListener("abort", abort);
      throw error;
    }
  }

  async function speakPrepared(lines, {key, language, onLine, onSpeak, onSentence, prepared}) {
    if (key !== null && key === lastKey) return;
    lastKey = key;
    stopReading();
    const my = token;
    let asset;
    readingController = new AbortController();
    setPlayback("loading", null);
    try {
      asset = prepared || await prepareScene(lines, {language, signal: readingController.signal});
      if (my !== token) return;
      if (asset.invalid) throw new Error("scene_audio_expired");
      if (asset.signature !== sceneSignature(sceneParts(lines), language)) throw new Error("scene_voice_changed");
      asset.playing = true;
      firstLineReady();
      let previousLine = -1;
      for (let k = 0; k < asset.parts.length; k++) {
        await untilResumed();
        if (my !== token) return;
        const url = await abortable(asset.loads[k], readingController.signal);   // waits only if not downloaded yet
        if (my !== token) return;
        const part = asset.parts[k];
        const played = await playClip(url, my, CLIP_LOAD_MS, null, () => {
          if (part.line !== previousLine) { previousLine = part.line; onLine(part.line); onSpeak(part.line); }
          onSentence(part.line, part.text);
        });
        if (my !== token) return;
        if (!played) throw new Error("scene_audio_playback_failed");
      }
      if (my === token) { onLine(-1); setPlayback("idle", null); }
    } catch (error) {
      if (my !== token) return;
      if (asset) discardScene(asset.signature, asset);
      lastKey = null;
      setPlayback("idle", null);
      throw error;
    } finally {
      if (asset) asset.playing = false;
    }
  }

  async function speak(lines, {key = null, language = "en", onLine = () => {}, onSpeak = () => {}, onSentence = () => {}, scene = false, prepared = null} = {}) {
    if (scene || prepared) return speakPrepared(lines, {key, language, onLine, onSpeak, onSentence, prepared});
    if (key !== null && key === lastKey) return;
    lastKey = key;
    stopReading();
    const my = token;
    readingController = new AbortController();
    setPlayback("loading", null);
    const usable = asLines(lines).filter(line => String(line.text || "").trim());
    const parts = usable.flatMap((line, i) => sentences(String(line.text).trim()).map(text => ({...line, text, line: i})));
    let clips = null;
    if (LANGUAGES.includes(language)) {
      try { clips = await queue(asLines(parts), {language, signal: readingController.signal}); } catch {}
    }
    if (my !== token) return;
    let heard = -1;
    const announce = part => {
      if (part.line !== heard) { heard = part.line; onSpeak(part.line); }
      onSentence(part.line, part.text);
    };
    for (let k = 0; k < parts.length; k += 1) {
      await untilResumed();
      if (my !== token) return;
      if (k === 0 || parts[k].line !== parts[k - 1].line) onLine(parts[k].line);
      const clip = clips?.[k];
      const wait = clip?.ready ? 0 : LINE_WAIT;
      const played = clip ? await playClip(`${server}${clip.url}?wait=${wait}`, my, wait * 1000 + CLIP_LOAD_MS,
        k === 0 ? firstLineReady : null, () => announce(parts[k])) : false;
      if (my !== token) return;
      if (!played) {
        if (k === 0) firstLineReady();
        await untilResumed();
        if (my !== token) return;
        await browserSay(parts[k].text, language, () => announce(parts[k]));
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
    for (const [signature, asset] of sceneCache) discardScene(signature, asset);
    try {
      if (id) { localStorage.setItem("story-voice", id); localStorage.setItem("story-voice-name", name); }
      else { localStorage.removeItem("story-voice"); localStorage.removeItem("story-voice-name"); }
    } catch {}
  }

  return {speak, stop, pause, resume, prepare, prepareScene, getPreparedScene, prefetch, voiceAhead, ahead, voiceBook, readyCount, interject, warm, fillers, sentences, listVoices, selectVoice, voiceId,
    playbackState: () => playback, voiceSource: () => source,
    subscribe(listener) { listeners.add(listener); listener(playback); return () => listeners.delete(listener); },
    usesParentVoice: () => Boolean(voiceId()), voiceName: () => (voiceId() && stored("story-voice-name")) || null};
})();
