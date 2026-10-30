/* Parent voice setup, one step at a time, against the narration server (narration/server.py, /api/voices).
   Steps: who → find (upload or record) → pick (a 10 s part on the waveform) → listen (preview, then save) → done.
   The chosen voice id is kept in localStorage "story-voice"; narration.js reads stories with it. */
(() => {
  "use strict";

  /* ---------- language: English source text, Korean translation (same key as agent-i18n.js) ---------- */
  const KO = {
    "Parent Voice · StoryShaper": "부모 목소리 · StoryShaper",
    "Who": "누구", "Their voice": "목소리", "Best part": "좋은 구간", "Listen": "듣기",
    "Who will read the stories?": "누가 동화를 읽어 줄까요?",
    "Their voice will read every page aloud, even on nights they can't be there.": "곁에 없는 밤에도 그 목소리가 모든 페이지를 읽어 줘요.",
    "A parent who is away": "멀리 있는 부모", "Working far away, serving, or travelling. They agreed to this.": "멀리서 일하거나, 복무 중이거나, 여행 중이에요. 본인이 동의했어요.",
    "Me": "나", "I'll add a recording of my own voice.": "내 목소리를 직접 녹음할게요.",
    "Someone we miss": "그리운 가족", "A family member who has passed away. I'm their close family.": "세상을 떠난 가족이에요. 저는 가까운 가족이에요.",
    "What does your child call them?": "아이가 뭐라고 부르나요?", "Dad": "아빠",
    "I have the right to use this voice for my family's stories. I won't add the voice of a public figure or anyone who hasn't agreed.":
      "우리 가족 동화에 이 목소리를 쓸 권리가 있어요. 유명인이나 동의하지 않은 사람의 목소리는 넣지 않을게요.",
    "The voice stays inside StoryShaper and can't be downloaded. Every line it reads carries a hidden watermark, and you can delete it any time.":
      "목소리는 StoryShaper 안에서만 쓰이고 내려받을 수 없어요. 읽는 모든 문장에 들리지 않는 워터마크가 들어가고, 언제든 지울 수 있어요.",
    "Find {possessive} voice": "{name} 목소리 찾기",
    "Add a video or a voice message. We only use the sound, and we keep just ten seconds of it.": "영상이나 음성 메시지를 올려 주세요. 소리만 쓰고, 그중 10초만 남겨요.",
    "Choose a video or recording": "영상이나 녹음 파일 고르기", "or drop it here": "또는 여기로 끌어다 놓기", "or": "또는",
    "Read it in English. One recording is enough: the same voice also reads the Korean stories.":
      "영어로 읽어 주세요. 한 번만 녹음하면 같은 목소리로 한국어 동화도 읽어요.",
    "A birthday message or a video call": "생일 축하 메시지나 영상통화", "Them reading a book aloud": "책을 소리 내어 읽는 모습",
    "Calm talking, one person, a quiet room": "조용한 곳에서 한 사람이 차분히 말하는 소리",
    "Pick the clearest ten seconds": "가장 깨끗한 10초 고르기",
    "The yellow part will be the voice we learn from. Tap a part to hear it, or slide it along the recording.":
      "노란 부분의 목소리를 배워요. 눌러서 들어 보고, 옆으로 밀어서 옮길 수 있어요.",
    "Hear {name} read": "{name} 목소리로 들어 보기", "Play the story line": "동화 문장 재생",
    "Voices on this device": "이 기기의 목소리", "Read every character in this voice": "모든 등장인물을 이 목소리로 읽기",
    "Off: the wolf has his own voice, so children always know who is talking.": "끄면 늑대는 다른 목소리로 읽어서 아이가 누가 말하는지 알 수 있어요.",
    "Back": "뒤로", "Continue": "다음", "Save {possessive} voice": "{name} 목소리 저장하기", "Start a story": "동화 시작하기",
    "Add another voice": "다른 목소리 추가하기", "The voice is ready": "목소리가 준비됐어요",
    "The voice helper on this computer isn't running. Start it, then try again.": "이 컴퓨터의 목소리 서버가 꺼져 있어요. 켠 다음 다시 해 주세요.",
    "Something went wrong ({status}). Try again.": "문제가 생겼어요 ({status}). 다시 해 주세요.",
    "Listening to {label}…": "{label}을(를) 듣고 있어요…", "the recording": "녹음",
    "Finding the clearest parts…": "가장 깨끗한 구간을 찾고 있어요…",
    "This browser can't record. Choose a video or recording instead.": "이 브라우저는 녹음할 수 없어요. 영상이나 녹음 파일을 골라 주세요.",
    "The microphone is blocked. Allow it in the browser, or choose a file instead.": "마이크가 막혀 있어요. 브라우저에서 허용하거나 파일을 골라 주세요.",
    "Get ready to read this aloud… {n}": "소리 내어 읽을 준비… {n}",
    "Read this aloud, slowly, the way you would at bedtime.": "잠자리에서 읽어 주듯이 천천히 소리 내어 읽어 주세요.",
    "Record {seconds} seconds now": "지금 {seconds}초 녹음하기",
    "Recording. Read slowly, the way you would at bedtime.": "녹음 중이에요. 잠자리에서처럼 천천히 읽어 주세요.",
    "I'm done ({left})": "다 읽었어요 ({left})",
    "Part from {start} to {end}": "{start}부터 {end}까지 구간", ", clearest": ", 가장 깨끗함",
    "Clearest part": "가장 깨끗한 구간", "Chosen part": "고른 구간",
    "Checking this part…": "이 구간을 확인하고 있어요…", "{seconds} seconds long": "{seconds}초 길이",
    "Mostly talking": "말소리가 충분해요", "Lots of silence": "조용한 부분이 많아요",
    "Quiet background": "주변이 조용해요", "Noisy background": "주변 소음이 커요",
    "Permission heard": "동의 문장을 들었어요",
    "We didn't hear the last sentence. You can record again, or go on.": "마지막 문장이 들리지 않았어요. 다시 녹음하거나 그대로 진행할 수 있어요.",
    "We heard": "이렇게 들렸어요",
    "We couldn't make out the words, but the voice can still be used.": "말은 알아듣지 못했지만 목소리는 그대로 쓸 수 있어요.",
    "This part might not sound right. You can still try it, or slide to another part.": "이 구간은 잘 안 될 수도 있어요. 그대로 해 보거나 다른 구간으로 옮겨 보세요.",
    "Reading it in {possessive} voice. This takes about ten seconds…": "{name} 목소리로 읽는 중이에요. 10초쯤 걸려요…",
    "Tap to hear it again.": "눌러서 다시 들어 보세요.", "Does that sound like {name}?": "{name} 목소리처럼 들리나요?",
    "The line isn't ready yet. Tap play to try again.": "아직 준비 중이에요. 재생을 눌러 다시 해 보세요.", "Tap play to listen.": "재생을 눌러 들어 보세요.",
    "{name}’s voice is ready": "{name} 목소리가 준비됐어요",
    "Tonight's story will be read in {name}’s voice. Only the ten-second part was kept.": "오늘 밤 동화는 {name} 목소리로 읽어요. 10초 구간만 남겨 두었어요.",
    "The whole storybook is ready.": "동화책 전체가 준비됐어요.",
    "Getting the storybook ready: {ready} of {total} lines. You can start reading now.": "동화책 준비 중: {total}줄 중 {ready}줄. 지금 바로 읽기 시작해도 돼요.",
    "Storybook voice": "기본 목소리", "The built-in reader": "기본으로 들어 있는 목소리", "My own voice": "내 목소리",
    "Delete": "지우기",
    "Delete {name}'s voice? The ten-second part and every story line read with it will be removed.": "{name} 목소리를 지울까요? 10초 구간과 이 목소리로 읽은 모든 문장이 지워져요.",
    "them": "그분", "their": "그분",
  };
  let language = (() => {
    const asked = new URLSearchParams(location.search).get("lang");
    if (asked === "ko" || asked === "en") return asked;
    try { return localStorage.getItem("story-language") === "ko" ? "ko" : "en"; } catch { return "en"; }
  })();
  // tr("Hear {name} read", {name}) — English text is the key; {placeholders} are filled in either language.
  const tr = (source, values = {}) => (language === "ko" ? KO[source] || source : source)
    .replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));

  const server = new URLSearchParams(location.search).get("voiceServer") || "http://127.0.0.1:8100";
  const $ = id => document.getElementById(id);
  const STEPS = ["who", "find", "pick", "listen", "done"];
  const RECORD_SECONDS = 30;
  const recordLabel = () => "● " + tr("Record {seconds} seconds now", {seconds: RECORD_SECONDS});
  // Where "Start a story" and the logo lead: the page that sent the parent here (?return=live.html), else the live book.
  const RETURN = (r => (/^[a-z-]+\.html$/.test(r || "") ? r : "live.html"))(new URLSearchParams(location.search).get("return"));
  const PREVIEW = {
    en: "Once upon a time, a mother pig lived with her three little pigs.",
    ko: "옛날 옛적에 엄마 돼지와 아기돼지 삼형제가 살았어요.",
  };
  const state = { step: "who", draft: null, peaks: null, duration: 0, clip: null, checked: null, previewed: false };
  let player = null;
  let raf = 0;

  const store = {
    get() { try { return localStorage.getItem("story-voice"); } catch { return null; } },
    // The name is kept too, so the picture book can say "Read by Dad" without asking the server.
    set(id, name = "") {
      try {
        if (id) { localStorage.setItem("story-voice", id); localStorage.setItem("story-voice-name", name); }
        else { localStorage.removeItem("story-voice"); localStorage.removeItem("story-voice-name"); }
      } catch {}
    }
  };

  async function api(path, options = {}) {
    let response;
    try { response = await fetch(server + path, options); }
    catch { throw new Error(tr("The voice helper on this computer isn't running. Start it, then try again.")); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || tr("Something went wrong ({status}). Try again.", {status: response.status}));
    return body;
  }
  const post = body => ({method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});

  const named = () => $("name").value.trim();
  const who = () => named() || tr("them");
  const possessive = () => (named() ? `${named()}’s` : tr("their"));
  const names = () => ({name: who(), possessive: possessive()});
  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  /* ---------- steps ---------- */

  function canContinue() {
    switch (state.step) {
      case "who": return Boolean(document.querySelector("input[name=relation]:checked") && $("attest").checked && $("name").value.trim());
      case "find": return Boolean(state.draft);
      case "pick": return Boolean(state.checked);
      case "listen": return state.previewed;
      default: return false;
    }
  }

  function render() {
    const index = STEPS.indexOf(state.step);
    document.querySelectorAll("main > section[data-step]").forEach(s => { s.hidden = s.dataset.step !== state.step; });
    document.querySelectorAll("#pages li").forEach((li, i) => {
      li.className = i < index ? "past" : i === index ? "now" : "";
      li.toggleAttribute("aria-current", i === index);
    });
    $("pages").hidden = state.step === "done";
    $("actions").hidden = state.step === "done";
    $("back").style.visibility = index === 0 ? "hidden" : "visible";
    $("next").textContent = state.step === "listen" ? tr("Save {possessive} voice", names()) : tr("Continue");
    $("next").disabled = !canContinue();
    // Choosing a file moves on by itself, so an empty "find" step shows no Continue button.
    $("next").style.visibility = state.step === "find" && !state.draft ? "hidden" : "visible";
    $("voicesBox").hidden = !(state.step === "who" || state.step === "done") || $("voicesBox").dataset.empty === "1";
    $("findTitle").textContent = tr("Find {possessive} voice", names());
    $("listenTitle").textContent = tr("Hear {name} read", names());
  }

  function go(step) {
    stopAudio();
    state.step = step;
    render();
    window.scrollTo({top: 0});
    document.querySelector(`section[data-step="${step}"] h1`)?.focus?.();
    if (step === "pick") drawTape();
    if (step === "listen" && !state.previewed) preview();
  }

  $("next").onclick = () => {
    if (state.step === "listen") return save();
    go(STEPS[STEPS.indexOf(state.step) + 1]);
  };
  $("back").onclick = () => go(STEPS[Math.max(0, STEPS.indexOf(state.step) - 1)]);
  document.querySelectorAll("input[name=relation], #attest").forEach(el => el.addEventListener("change", render));
  $("name").addEventListener("input", render);

  /* ---------- find: upload or record ---------- */

  function showError(id, message) { $(id).textContent = message; $(id).hidden = !message; }

  // recorded: the bedtime passage was read here, so the server also listens for the permission sentence.
  async function upload(blob, label, recorded = false) {
    showError("findError", "");
    $("working").hidden = false;
    $("workingText").textContent = tr("Listening to {label}…", {label});
    Object.assign(state, {draft: null, peaks: null, clip: null, checked: null, previewed: false});
    render();
    try {
      state.draft = await api(`/api/voices${recorded ? "?recorded=1" : ""}`, {method: "POST", headers: {"Content-Type": blob.type || "audio/webm"}, body: blob});
      $("workingText").textContent = tr("Finding the clearest parts…");
      await loadPeaks();
      const best = [...state.draft.suggestions].sort((a, b) => b.speech - a.speech)[0];
      state.clip = best ? {start: best.start, end: best.end} : {start: 0, end: Math.min(10, state.duration)};
      go("pick");
      check();
    } catch (error) {
      showError("findError", error.message);
    } finally {
      $("working").hidden = true;
    }
  }

  async function loadPeaks() {
    const data = await (await fetch(`${server}/api/voices/${state.draft.id}/full.wav`)).arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(data);
    ctx.close();
    const samples = audio.getChannelData(0);
    const count = 160;
    const size = Math.floor(samples.length / count);
    const peaks = [];
    for (let i = 0; i < count; i += 1) {
      let sum = 0;
      for (let j = i * size; j < (i + 1) * size; j += 16) sum += samples[j] * samples[j];
      peaks.push(Math.sqrt(sum / (size / 16)));
    }
    const max = Math.max(...peaks) || 1;
    state.peaks = peaks.map(p => p / max);
    state.duration = audio.duration;
  }

  const drop = $("drop");
  ["dragenter", "dragover"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(e => drop.addEventListener(e, () => drop.classList.remove("over")));
  drop.addEventListener("drop", ev => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) upload(f, f.name); });
  $("file").addEventListener("change", () => { const f = $("file").files[0]; if (f) upload(f, f.name); $("file").value = ""; });

  async function record() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return showError("findError", tr("This browser can't record. Choose a video or recording instead."));
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
    catch { return showError("findError", tr("The microphone is blocked. Allow it in the browser, or choose a file instead.")); }
    // Show the bedtime passage first and count down, so the reader has a moment to look at it.
    const cue = $("cue");
    const section = document.querySelector('section[data-step="find"]');
    section.classList.add("recording");
    $("actions").hidden = true;            // no Back while the microphone is open
    $("script").hidden = false;
    window.scrollTo({top: 0});
    document.querySelector(".ideas").hidden = true;
    $("record").disabled = true;
    for (const n of [3, 2, 1]) {
      cue.textContent = tr("Get ready to read this aloud… {n}", {n});
      await new Promise(r => setTimeout(r, 1000));
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    let left = RECORD_SECONDS;
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => {
      clearInterval(tick);
      stream.getTracks().forEach(t => t.stop());
      cue.classList.remove("live");
      cue.textContent = tr("Read this aloud, slowly, the way you would at bedtime.");
      $("script").hidden = true;
      section.classList.remove("recording");
      render();
      document.querySelector(".ideas").hidden = false;
      $("record").textContent = recordLabel();
      $("record").onclick = record;
      upload(new Blob(chunks, {type: recorder.mimeType || "audio/webm"}), tr("the recording"), true);
    };
    recorder.start();
    cue.classList.add("live");
    cue.textContent = tr("Recording. Read slowly, the way you would at bedtime.");
    $("record").disabled = false;
    $("record").onclick = () => recorder.state === "recording" && recorder.stop();
    const label = () => { $("record").textContent = "■ " + tr("I'm done ({left})", {left}); };
    label();
    const tick = setInterval(() => { left -= 1; label(); if (left <= 0) recorder.stop(); }, 1000);
  }
  $("record").onclick = record;

  /* ---------- pick: the tape ---------- */

  function drawTape() {
    if (!state.peaks) return;
    const bars = $("bars");
    bars.replaceChildren(...state.peaks.map(p => {
      const bar = document.createElement("i");
      bar.style.height = `${Math.max(4, p * 100)}%`;
      return bar;
    }));
    $("total").textContent = clock(state.duration);
    $("tape").querySelectorAll(".band").forEach(b => b.remove());
    const best = Math.max(...state.draft.suggestions.map(s => s.speech));
    state.draft.suggestions.forEach(s => addBand(s, s.speech === best));
    if (!state.draft.suggestions.some(s => s.start === state.clip.start)) addBand(state.clip, false);
    paint();
  }

  function addBand(part, best) {
    const band = document.createElement("button");
    band.type = "button";
    band.className = "band";
    band.dataset.start = part.start;
    band.dataset.length = part.end - part.start;
    band.setAttribute("aria-label", tr("Part from {start} to {end}", {start: clock(part.start), end: clock(part.end)}) + (best ? tr(", clearest") : ""));
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = tr(best ? "Clearest part" : "Chosen part");
    band.append(tag);
    band.addEventListener("click", () => {
      if (band.dataset.dragged) { delete band.dataset.dragged; return; }
      select(+band.dataset.start, +band.dataset.length);
      playClip();
    });
    band.addEventListener("pointerdown", ev => startDrag(ev, band));
    band.addEventListener("keydown", ev => {
      if (!band.classList.contains("on") || !["ArrowLeft", "ArrowRight"].includes(ev.key)) return;
      ev.preventDefault();
      move(band, +band.dataset.start + (ev.key === "ArrowRight" ? 0.5 : -0.5));
      check();
    });
    $("tape").append(band);
  }

  function paint() {
    const {start, end} = state.clip;
    $("tape").querySelectorAll(".band").forEach(band => {
      const s = +band.dataset.start, len = +band.dataset.length;
      band.style.left = `calc(10px + (100% - 20px) * ${s / state.duration})`;
      band.style.width = `calc((100% - 20px) * ${len / state.duration})`;
      band.classList.toggle("on", s === start);
    });
    $("bars").querySelectorAll("i").forEach((bar, i) => {
      const t = (i + 0.5) / state.peaks.length * state.duration;
      bar.classList.toggle("in", t >= start && t <= end);
    });
  }

  function select(start, length) {
    state.clip = {start, end: start + length};
    paint();
    check();
  }

  function move(band, start) {
    const length = +band.dataset.length;
    start = Math.round(Math.min(Math.max(0, start), state.duration - length) * 10) / 10;
    band.dataset.start = start;
    state.clip = {start, end: start + length};
    paint();
  }

  function startDrag(ev, band) {
    if (!band.classList.contains("on")) return;
    const width = $("bars").getBoundingClientRect().width;
    const from = ev.clientX, origin = +band.dataset.start;
    let moved = false;
    band.setPointerCapture(ev.pointerId);
    const onMove = e => {
      const shift = (e.clientX - from) / width * state.duration;
      if (Math.abs(e.clientX - from) > 4) moved = true;
      if (moved) { stopAudio(); move(band, origin + shift); }
    };
    const onUp = () => {
      band.removeEventListener("pointermove", onMove);
      band.removeEventListener("pointerup", onUp);
      if (moved) { band.dataset.dragged = "1"; check(); playClip(); }
    };
    band.addEventListener("pointermove", onMove);
    band.addEventListener("pointerup", onUp);
  }

  function playClip() {
    stopAudio();
    const {start, end} = state.clip;
    const audio = new Audio(`${server}/api/voices/${state.draft.id}/full.wav`);
    player = audio;
    const head = $("head");
    audio.addEventListener("loadedmetadata", () => { audio.currentTime = start; audio.play(); }, {once: true});
    const follow = () => {
      if (player !== audio) return;
      if (audio.currentTime >= end) { audio.pause(); head.hidden = true; return; }
      head.hidden = false;
      head.style.left = `calc(10px + (100% - 20px) * ${audio.currentTime / state.duration})`;
      raf = requestAnimationFrame(follow);
    };
    audio.addEventListener("playing", follow, {once: true});
  }

  function stopAudio() {
    cancelAnimationFrame(raf);
    if (player) { player.pause(); player = null; }
    $("head").hidden = true;
  }

  let checking = 0;
  async function check() {
    const mine = ++checking;
    const {start, end} = state.clip;
    state.checked = null;
    state.previewed = false;
    showError("pickError", "");
    $("verdict").hidden = false;
    $("checks").replaceChildren(Object.assign(document.createElement("li"), {textContent: tr("Checking this part…")}));
    $("heard").textContent = "";
    render();
    try {
      const meta = await api(`/api/voices/${state.draft.id}/clip`, post({start, end}));
      if (mine !== checking) return;
      const q = meta.quality;
      const items = [
        [q.duration >= 5 && q.duration <= 20, tr("{seconds} seconds long", {seconds: Math.round(q.duration)})],
        [q.speech >= 0.6, tr(q.speech >= 0.6 ? "Mostly talking" : "Lots of silence")],
        [q.snrDb >= 15, tr(q.snrDb >= 15 ? "Quiet background" : "Noisy background")],
      ];
      if (state.draft.consentHeard !== undefined) {
        items.push([state.draft.consentHeard, tr(state.draft.consentHeard ? "Permission heard"
          : "We didn't hear the last sentence. You can record again, or go on.")]);
      }
      $("checks").replaceChildren(...items.map(([good, text]) =>
        Object.assign(document.createElement("li"), {className: good ? "good" : "bad", textContent: text})));
      const heard = $("heard");
      heard.replaceChildren();
      if (meta.transcript) {
        heard.append(`“${meta.transcript}”`);
        heard.prepend(Object.assign(document.createElement("small"), {textContent: tr("We heard")}));
      } else {
        heard.append(Object.assign(document.createElement("small"), {textContent: tr("We couldn't make out the words, but the voice can still be used.")}));
      }
      if (!q.ok) showError("pickError", tr("This part might not sound right. You can still try it, or slide to another part."));
      state.checked = {start, end};
    } catch (error) {
      if (mine === checking) showError("pickError", error.message);
    }
    render();
  }

  /* ---------- listen ---------- */

  async function preview() {
    const play = $("play");
    play.classList.add("busy");
    play.disabled = true;
    $("ask").hidden = true;
    $("listenStatus").textContent = tr("Reading it in {possessive} voice. This takes about ten seconds…", names());
    try {
      // Voice the rest of the first page too. The preview is the book's first line and is asked for last,
      // because the server reads the newest request first.
      if (typeof Narration !== "undefined") await Narration.prepare((await bookLines(language)).slice(1, FIRST_PAGE), {voice: state.draft.id, language});
      const clip = await api(`/api/voices/${state.draft.id}/preview`, post({language}));
      const url = `${server}${clip.url}?wait=30`;
      play.onclick = () => playPreview(url);
      await playPreview(url);
    } catch (error) {
      $("listenStatus").textContent = error.message;
      play.onclick = preview;
    } finally {
      play.classList.remove("busy");
      play.disabled = false;
    }
  }

  function playPreview(url) {
    stopAudio();
    return new Promise(resolve => {
      const audio = new Audio(url);
      player = audio;
      audio.onplaying = () => { $("listenStatus").textContent = ""; };
      audio.onended = () => {
        state.previewed = true;
        $("listenStatus").textContent = tr("Tap to hear it again.");
        $("ask").textContent = tr("Does that sound like {name}?", names());
        $("ask").hidden = false;
        render();
        resolve();
      };
      audio.onerror = () => { $("listenStatus").textContent = tr("The line isn't ready yet. Tap play to try again."); resolve(); };
      audio.play().catch(() => { $("listenStatus").textContent = tr("Tap play to listen."); resolve(); });
    });
  }

  async function save() {
    const relation = document.querySelector("input[name=relation]:checked").value;
    $("next").disabled = true;
    try {
      const meta = await api(`/api/voices/${state.draft.id}/save`, post({name: $("name").value, relation, attested: $("attest").checked}));
      store.set(meta.id, meta.name);
      prepareBook();
      watchBook(meta.id);
      $("doneTitle").textContent = tr("{name}’s voice is ready", {name: meta.name});
      $("doneText").textContent = tr("Tonight's story will be read in {name}’s voice. Only the ten-second part was kept.", {name: meta.name});
      go("done");
      loadVoices();
    } catch (error) {
      $("listenStatus").textContent = error.message;
      render();
    }
  }

  $("again").onclick = () => {
    Object.assign(state, {draft: null, peaks: null, clip: null, checked: null, previewed: false});
    $("name").value = "";
    $("attest").checked = false;
    document.querySelectorAll("input[name=relation]").forEach(r => { r.checked = false; });
    go("who");
  };

  // Every line of the picture book, in story order (prototype/audio/lines.json).
  const FIRST_PAGE = 8;
  const books = {};
  async function bookLines(lang = "en") {
    if (!books[lang]) {
      try { books[lang] = (await (await fetch(lang === "ko" ? "audio/lines.ko.json" : "audio/lines.json")).json()).map(l => l.text); }
      catch { books[lang] = []; }
    }
    return books[lang];
  }

  // Show how much of the book is voiced, until all of it is or the page changes.
  // Counts the book in the page's language, the one the family is about to hear.
  async function watchBook(id) {
    const lines = await bookLines(language);
    if (typeof Narration === "undefined" || !lines.length) return;
    const status = $("bookStatus");
    while (state.step === "done" && store.get() === id) {
      let ready = 0;
      for (let i = 0; i < lines.length; i += 20) {
        const n = await Narration.readyCount(lines.slice(i, i + 20), {language});
        if (n === null) { status.textContent = ""; return; }
        ready += n;
      }
      if (ready >= lines.length) { status.textContent = tr("The whole storybook is ready."); status.classList.add("all"); return; }
      status.textContent = tr("Getting the storybook ready: {ready} of {total} lines. You can start reading now.", {ready, total: lines.length});
      await new Promise(r => setTimeout(r, 2500));
    }
  }

  // Voice the "let's see…" lines and the whole picture book now, in the background, so they play without waiting.
  async function prepareBook() {
    if (typeof Narration === "undefined") return;
    try {
      // The same voice reads both books. The server voices the newest request first, so send the other
      // language's book first and the page language's book last (each from its last page to its opening);
      // the short fillers go last of all.
      // Sent as beacons, so they still arrive if the parent leaves this page right away.
      const chunks = lines => { const out = []; for (let i = 0; i < lines.length; i += 20) out.push(lines.slice(i, i + 20)); return out.reverse(); };
      const order = language === "ko" ? ["en", "ko"] : ["ko", "en"];
      const books = {en: await bookLines("en"), ko: await bookLines("ko")};
      for (const lang of order) for (const chunk of chunks(books[lang])) Narration.voiceAhead(chunk, {language: lang});
      for (const lang of order) Narration.voiceAhead(Narration.fillers(lang), {language: lang});
    } catch {}
  }

  $("allRoles").checked = (() => { try { return localStorage.getItem("story-voice-all") === "1"; } catch { return false; } })();
  $("allRoles").onchange = () => { try { localStorage.setItem("story-voice-all", $("allRoles").checked ? "1" : "0"); } catch {} };

  /* ---------- voices on this device ---------- */

  async function loadVoices() {
    let voices;
    try { ({voices} = await api("/api/voices")); }
    catch { $("voicesBox").dataset.empty = "1"; $("voices").replaceChildren(); render(); return; }
    const active = store.get();
    if (active && !voices.some(v => v.id === active)) store.set(null);
    const rows = [{id: null, name: tr("Storybook voice"), note: tr("The built-in reader")}, ...voices].map(voice => {
      const row = document.createElement("div");
      row.className = "voice";
      const pick = document.createElement("label");
      const radio = Object.assign(document.createElement("input"), {type: "radio", name: "active"});
      radio.checked = (store.get() || null) === voice.id;
      radio.onchange = () => store.set(voice.id, voice.name);
      const text = document.createElement("span");
      text.append(voice.name, Object.assign(document.createElement("small"), {
        textContent: voice.note || tr(voice.consent?.relation === "family_late" ? "Someone we miss" :
          voice.consent?.relation === "me" ? "My own voice" : "A parent who is away")}));
      pick.append(radio, text);
      row.append(pick);
      if (voice.id) {
        const remove = Object.assign(document.createElement("button"), {type: "button", className: "btn small", textContent: tr("Delete")});
        remove.onclick = async () => {
          if (!confirm(tr("Delete {name}'s voice? The ten-second part and every story line read with it will be removed.", {name: voice.name}))) return;
          try { await api(`/api/voices/${voice.id}`, {method: "DELETE"}); } catch (error) { alert(error.message); }
          loadVoices();
        };
        row.append(remove);
      }
      return row;
    });
    $("voices").replaceChildren(...rows);
    $("voicesBox").dataset.empty = voices.length ? "" : "1";
    render();
  }

  // Static text carries its English source in data-t; switching language rewrites it and the live parts.
  function applyCopy() {
    document.documentElement.lang = language;
    document.title = tr("Parent Voice · StoryShaper");
    document.querySelectorAll("[data-t]").forEach(el => {
      if (!el.dataset.source) el.dataset.source = el.textContent.trim().replace(/\s+/g, " ");
      el.textContent = tr(el.dataset.source);
    });
    document.querySelectorAll("[data-t-placeholder]").forEach(el => { el.placeholder = tr(el.dataset.tPlaceholder); });
    document.querySelectorAll("[data-t-aria]").forEach(el => { el.setAttribute("aria-label", tr(el.dataset.tAria)); });
    document.querySelectorAll("[data-lang]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === language)));
    $("previewLine").textContent = `“${PREVIEW[language]}”`;
    if (!$("record").textContent.startsWith("■")) $("record").textContent = recordLabel();
    document.querySelectorAll("[data-return]").forEach(a => { a.href = RETURN; });
    render();
    loadVoices();
  }
  document.querySelectorAll("[data-lang]").forEach(button => {
    button.onclick = () => {
      language = button.dataset.lang;
      try { localStorage.setItem("story-language", language); } catch {}
      applyCopy();
    };
  });

  applyCopy();
})();
