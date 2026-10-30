/* Parent voice setup, one step at a time, against the narration server (narration/server.py, /api/voices).
   Steps: who → find (upload or record) → pick (a 10 s part on the waveform) → listen (preview, then save) → done.
   The chosen voice id is kept in localStorage "story-voice"; narration.js reads stories with it. */
(() => {
  "use strict";

  const server = new URLSearchParams(location.search).get("voiceServer") || "http://127.0.0.1:8100";
  const $ = id => document.getElementById(id);
  const STEPS = ["who", "find", "pick", "listen", "done"];
  const RECORD_SECONDS = 30;
  const state = { step: "who", draft: null, peaks: null, duration: 0, clip: null, checked: null, previewed: false };
  let player = null;
  let raf = 0;

  const store = {
    get() { try { return localStorage.getItem("story-voice"); } catch { return null; } },
    set(id) { try { id ? localStorage.setItem("story-voice", id) : localStorage.removeItem("story-voice"); } catch {} }
  };

  async function api(path, options = {}) {
    let response;
    try { response = await fetch(server + path, options); }
    catch { throw new Error("The voice helper on this computer isn't running. Start it, then try again."); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Something went wrong (${response.status}). Try again.`);
    return body;
  }
  const post = body => ({method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});

  const who = () => $("name").value.trim() || "them";
  const possessive = () => (who() === "them" ? "their" : `${who()}’s`);
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
    $("next").textContent = state.step === "listen" ? `Save ${possessive()} voice` : "Continue";
    $("next").disabled = !canContinue();
    // Choosing a file moves on by itself, so an empty "find" step shows no Continue button.
    $("next").style.visibility = state.step === "find" && !state.draft ? "hidden" : "visible";
    $("voicesBox").hidden = !(state.step === "who" || state.step === "done") || $("voicesBox").dataset.empty === "1";
    $("findTitle").textContent = `Find ${possessive()} voice`;
    $("listenTitle").textContent = `Hear ${who()} read`;
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

  async function upload(blob, label) {
    showError("findError", "");
    $("working").hidden = false;
    $("workingText").textContent = `Listening to ${label}…`;
    Object.assign(state, {draft: null, peaks: null, clip: null, checked: null, previewed: false});
    render();
    try {
      state.draft = await api("/api/voices", {method: "POST", headers: {"Content-Type": blob.type || "audio/webm"}, body: blob});
      $("workingText").textContent = "Finding the clearest parts…";
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
      return showError("findError", "This browser can't record. Choose a video or recording instead.");
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
    catch { return showError("findError", "The microphone is blocked. Allow it in the browser, or choose a file instead."); }
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
      cue.textContent = `Get ready to read this aloud… ${n}`;
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
      cue.textContent = "Read this aloud, slowly, the way you would at bedtime.";
      $("script").hidden = true;
      section.classList.remove("recording");
      render();
      document.querySelector(".ideas").hidden = false;
      $("record").textContent = `● Record ${RECORD_SECONDS} seconds now`;
      $("record").onclick = record;
      upload(new Blob(chunks, {type: recorder.mimeType || "audio/webm"}), "the recording");
    };
    recorder.start();
    cue.classList.add("live");
    cue.textContent = "Recording. Read slowly, the way you would at bedtime.";
    $("record").disabled = false;
    $("record").onclick = () => recorder.state === "recording" && recorder.stop();
    const label = () => { $("record").textContent = `■ I'm done (${left})`; };
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
    band.setAttribute("aria-label", `Part from ${clock(part.start)} to ${clock(part.end)}${best ? ", clearest" : ""}`);
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = best ? "Clearest part" : "Chosen part";
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
    $("checks").replaceChildren(Object.assign(document.createElement("li"), {textContent: "Checking this part…"}));
    $("heard").textContent = "";
    render();
    try {
      const meta = await api(`/api/voices/${state.draft.id}/clip`, post({start, end}));
      if (mine !== checking) return;
      const q = meta.quality;
      const items = [
        [q.duration >= 5 && q.duration <= 20, `${Math.round(q.duration)} seconds long`],
        [q.speech >= 0.6, q.speech >= 0.6 ? "Mostly talking" : "Lots of silence"],
        [q.snrDb >= 15, q.snrDb >= 15 ? "Quiet background" : "Noisy background"],
      ];
      $("checks").replaceChildren(...items.map(([good, text]) =>
        Object.assign(document.createElement("li"), {className: good ? "good" : "bad", textContent: text})));
      const heard = $("heard");
      heard.replaceChildren();
      if (meta.transcript) {
        heard.append(`“${meta.transcript}”`);
        heard.prepend(Object.assign(document.createElement("small"), {textContent: "We heard"}));
      } else {
        heard.append(Object.assign(document.createElement("small"), {textContent: "We couldn't make out the words, but the voice can still be used."}));
      }
      if (!q.ok) showError("pickError", "This part might not sound right. You can still try it, or slide to another part.");
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
    $("listenStatus").textContent = `Reading it in ${possessive()} voice. This takes about ten seconds…`;
    try {
      const clip = await api(`/api/voices/${state.draft.id}/preview`, post({}));
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
        $("listenStatus").textContent = "Tap to hear it again.";
        $("ask").textContent = `Does that sound like ${who()}?`;
        $("ask").hidden = false;
        render();
        resolve();
      };
      audio.onerror = () => { $("listenStatus").textContent = "The line isn't ready yet. Tap play to try again."; resolve(); };
      audio.play().catch(() => { $("listenStatus").textContent = "Tap play to listen."; resolve(); });
    });
  }

  async function save() {
    const relation = document.querySelector("input[name=relation]:checked").value;
    $("next").disabled = true;
    try {
      const meta = await api(`/api/voices/${state.draft.id}/save`, post({name: $("name").value, relation, attested: $("attest").checked}));
      store.set(meta.id);
      $("doneTitle").textContent = `${meta.name}’s voice is ready`;
      $("doneText").textContent = `Tonight's story will be read in ${meta.name}’s voice. Only the ten-second part was kept.`;
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

  /* ---------- voices on this device ---------- */

  async function loadVoices() {
    let voices;
    try { ({voices} = await api("/api/voices")); }
    catch { $("voicesBox").dataset.empty = "1"; $("voices").replaceChildren(); render(); return; }
    const active = store.get();
    if (active && !voices.some(v => v.id === active)) store.set(null);
    const rows = [{id: null, name: "Storybook voice", note: "The built-in reader"}, ...voices].map(voice => {
      const row = document.createElement("div");
      row.className = "voice";
      const pick = document.createElement("label");
      const radio = Object.assign(document.createElement("input"), {type: "radio", name: "active"});
      radio.checked = (store.get() || null) === voice.id;
      radio.onchange = () => store.set(voice.id);
      const text = document.createElement("span");
      text.append(voice.name, Object.assign(document.createElement("small"), {
        textContent: voice.note || (voice.consent?.relation === "family_late" ? "Someone we miss" :
          voice.consent?.relation === "me" ? "My own voice" : "A parent who is away")}));
      pick.append(radio, text);
      row.append(pick);
      if (voice.id) {
        const remove = Object.assign(document.createElement("button"), {type: "button", className: "btn small", textContent: "Delete"});
        remove.onclick = async () => {
          if (!confirm(`Delete ${voice.name}'s voice? The ten-second part and every story line read with it will be removed.`)) return;
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

  render();
  loadVoices();
})();
