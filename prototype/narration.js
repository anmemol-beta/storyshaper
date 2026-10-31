/* Story voices from the local narration server (narration/server.py).
   The reader prepares an entire scene as one local WAV before revealing the page,
   then calls speak(..., {scene:true, prepared}). No line downloads occur during it.
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
  const SCENE_PREP_MS = 180000, SCENE_POLL_MS = 400;
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
    URL.revokeObjectURL(asset.url);
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

  function pollDelay(signal) {
    return new Promise((resolve, reject) => {
      cancelled(signal);
      const abort = () => { clearTimeout(timer); reject(new Error("narration_cancelled")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, SCENE_POLL_MS);
      signal.addEventListener("abort", abort, {once: true});
    });
  }

  function preloadScene(clip, signal) {
    return new Promise((resolve, reject) => {
      cancelled(signal);
      let settled = false;
      const done = error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => { clip.pause(); done(new Error("narration_cancelled")); };
      clip.addEventListener("canplay", () => done(), {once: true});
      clip.addEventListener("error", () => done(new Error("scene_audio_decode_failed")), {once: true});
      signal.addEventListener("abort", abort, {once: true});
      clip.preload = "auto";
      clip.load();
      if (clip.readyState >= 3) done();
    });
  }

  // All generation and network/decode waiting is on this side of the scene boundary.
  // Callers may cancel a stale scene; existing server jobs remain deduplicated for reuse.
  async function prepareScene(lines, {language = "en", signal, retry = false, onProgress = () => {}} = {}) {
    if (!LANGUAGES.includes(language)) throw new Error("scene_language_unavailable");
    cancelled(signal);
    const parts = sceneParts(lines);
    if (!parts.length || parts.length > 64) throw new Error("invalid_scene_lines");
    const signature = sceneSignature(parts, language);
    const requestedVoice = voiceId() || "default";
    const forceReload = retry;
    if (retry) discardScene(signature);
    if (sceneCache.has(signature)) return sceneCache.get(signature);
    const controller = new AbortController();
    let timedOut = false, localUrl = null;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SCENE_PREP_MS);
    try {
      let scene;
      do {
        cancelled(controller.signal);
        if (signature !== sceneSignature(parts, language)) throw new Error("scene_voice_changed");
        const id = voiceId();
        const {response, body} = await request("/api/voice/scene", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({lines: asLines(parts), language, ...(id ? {voiceId: id} : {}),
            ...(allRoles() ? {allRoles: true} : {}), ...(retry ? {retry: true} : {})})
        }, {signal: controller.signal, timeout: 5000});
        retry = false;
        if (!response.ok) throw new Error(`scene_narration_${response.status}`);
        if (body.status === "failed") throw new Error("scene_generation_failed");
        if (!["pending", "ready"].includes(body.status)) throw new Error("invalid_scene_audio");
        onProgress({ready: body.ready, total: body.total});
        scene = body;
        if (scene.status !== "ready") await pollDelay(controller.signal);
      } while (scene.status !== "ready");
      const route = /^\/audio\/(default|[a-f0-9]{12})\/scene-([a-f0-9]{16,64})\.wav$/.exec(scene.url || "");
      if (!route || route[1] !== requestedVoice || route[2] !== scene.sceneKey
          || scene.ready !== parts.length || scene.total !== parts.length
          || !Array.isArray(scene.segments) || scene.segments.length !== parts.length
          || !Number.isFinite(scene.duration) || scene.duration <= 0) throw new Error("invalid_scene_audio");
      let end = 0;
      for (let i = 0; i < scene.segments.length; i++) {
        const segment = scene.segments[i];
        if (segment.lineIndex !== i || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
            || segment.text !== parts[i].text || segment.speakerId !== parts[i].speakerId
            || Math.abs(segment.start - end) > 0.001 || segment.end <= segment.start
            || segment.end > scene.duration + 0.001) throw new Error("invalid_scene_timing");
        end = segment.end;
      }
      if (Math.abs(end - scene.duration) > 0.001) throw new Error("invalid_scene_timing");
      const response = await abortable(fetch(server + scene.url, {
        signal: controller.signal, ...(forceReload ? {cache: "reload"} : {})
      }), controller.signal);
      if (!response.ok) throw new Error("scene_audio_download_failed");
      const blob = await abortable(response.blob(), controller.signal);
      if (!blob.size || blob.size > 32 * 1024 * 1024) throw new Error("invalid_scene_audio_size");
      cancelled(controller.signal);
      localUrl = URL.createObjectURL(blob);
      const clip = new Audio(localUrl);
      await preloadScene(clip, controller.signal);
      cancelled(controller.signal);
      if (signature !== sceneSignature(parts, language)) throw new Error("scene_voice_changed");
      const prepared = {signature, audio: clip, url: localUrl, duration: scene.duration,
        segments: scene.segments.map(segment => ({...segment, lineIndex: parts[segment.lineIndex].line}))};
      sceneCache.set(signature, prepared);
      // Keep a few complete pages for back/replay without retaining the whole book's PCM.
      for (const [key, asset] of sceneCache) {
        if (sceneCache.size <= 6) break;
        if (asset.audio === audio || key === signature) continue;
        discardScene(key, asset);
      }
      return prepared;
    } catch (error) {
      if (localUrl) URL.revokeObjectURL(localUrl);
      if (timedOut) throw new Error("scene_prepare_timeout");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
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
      await untilResumed();
      if (my !== token) return;
      firstLineReady();
      const clip = asset.audio;
      clip.currentTime = 0;
      let previousLine = -1, previousSegment = -1, audible = false;
      const highlight = () => {
        if (my !== token || !audible) return;
        const now = Number(clip.currentTime) || 0;
        const segmentIndex = asset.segments.findIndex(part => now >= part.start && now < part.end);
        const segment = asset.segments[segmentIndex];
        if (segment && segment.lineIndex !== previousLine) {
          previousLine = segment.lineIndex;
          onLine(previousLine);
          onSpeak(previousLine);
        }
        if (segment && segmentIndex !== previousSegment) {
          previousSegment = segmentIndex;
          onSentence(segment.lineIndex, segment.text);
        }
      };
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = ok => {
          if (settled) return;
          settled = true;
          clip.pause();
          clip.ontimeupdate = clip.onplaying = clip.onended = clip.onerror = null;
          if (audio === clip) audio = null;
          if (finish === done) finish = null;
          ok ? resolve() : reject(new Error("scene_audio_playback_failed"));
        };
        audio = clip;
        finish = done;
        clip.ontimeupdate = highlight;
        clip.onplaying = () => { if (!settled && my === token) { audible = true; setPlayback("playing", "parent"); highlight(); } };
        clip.onended = () => done(true);
        clip.onerror = () => done(false);
        clip.play().catch(() => done(false));
      });
      if (my === token) { onLine(-1); setPlayback("idle", null); }
    } catch (error) {
      if (my !== token) return;
      if (asset) discardScene(asset.signature, asset);
      lastKey = null;
      setPlayback("idle", null);
      throw error;
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

  return {speak, stop, pause, resume, prepare, prepareScene, getPreparedScene, prefetch, voiceAhead, readyCount, interject, warm, fillers, sentences, listVoices, selectVoice, voiceId,
    playbackState: () => playback, voiceSource: () => source,
    subscribe(listener) { listeners.add(listener); listener(playback); return () => listeners.delete(listener); },
    usesParentVoice: () => Boolean(voiceId()), voiceName: () => (voiceId() && stored("story-voice-name")) || null};
})();
