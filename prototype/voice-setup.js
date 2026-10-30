/* Parent voice registration against the narration server (narration/server.py, /api/voices).
   The chosen voice id is kept in localStorage "story-voice"; narration.js reads stories with it. */
(() => {
  "use strict";

  const server = new URLSearchParams(location.search).get("voiceServer") || "http://127.0.0.1:8100";
  const $ = id => document.getElementById(id);
  const RECORD_SECONDS = 30;
  let draft = null;          // {id, suggestions}
  let chosen = null;         // {start, end}
  let player = null;

  const store = {
    get() { try { return localStorage.getItem("story-voice"); } catch { return null; } },
    set(id) { try { id ? localStorage.setItem("story-voice", id) : localStorage.removeItem("story-voice"); } catch {} }
  };

  async function api(path, options = {}) {
    const response = await fetch(server + path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `The voice server answered ${response.status}.`);
    return body;
  }
  const json = (method, body) => ({method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});

  function enable(card, on) { $(card).setAttribute("aria-disabled", String(!on)); }

  function consentReady() {
    const relation = document.querySelector("input[name=relation]:checked");
    return Boolean(relation && $("attest").checked && $("name").value.trim());
  }

  function refresh() {
    const consent = consentReady();
    enable("uploadCard", consent);
    enable("clipCard", consent && Boolean(draft));
    enable("previewCard", consent && Boolean(chosen));
    enable("saveCard", consent && Boolean(chosen));
  }

  function stopPlayer() { if (player) { player.pause(); player = null; } }

  function playPart(start, end) {
    stopPlayer();
    const audio = new Audio(`${server}/api/voices/${draft.id}/full.wav`);
    player = audio;
    audio.addEventListener("loadedmetadata", () => { audio.currentTime = start; audio.play(); }, {once: true});
    audio.addEventListener("timeupdate", () => { if (audio.currentTime >= end) audio.pause(); });
  }

  async function upload(blob, label) {
    stopPlayer();
    draft = null; chosen = null;
    $("clips").replaceChildren(); $("clipResult").replaceChildren();
    $("uploadStatus").textContent = `Reading the sound from ${label}…`;
    refresh();
    try {
      draft = await api("/api/voices", {method: "POST", headers: {"Content-Type": blob.type || "audio/webm"}, body: blob});
      const found = draft.suggestions.length;
      $("uploadStatus").textContent = `${draft.sourceSeconds} seconds of audio. ` +
        (found ? `Found ${found} part${found > 1 ? "s" : ""} with clear talking.` : "No clear talking found; choose a part yourself.");
      renderClips();
    } catch (error) {
      $("uploadStatus").textContent = error.message;
    }
    refresh();
  }

  function renderClips() {
    $("clips").replaceChildren(...draft.suggestions.map((clip, i) => {
      const row = document.createElement("div");
      row.className = "clip";
      const label = document.createElement("span");
      label.textContent = `Part ${i + 1}: ${clip.start.toFixed(1)}–${clip.end.toFixed(1)} s · ${Math.round(clip.speech * 100)}% talking`;
      const buttons = document.createElement("div");
      buttons.className = "row";
      const listen = Object.assign(document.createElement("button"), {type: "button", textContent: "▶ Listen"});
      listen.onclick = () => playPart(clip.start, clip.end);
      const use = Object.assign(document.createElement("button"), {type: "button", textContent: "Use this part"});
      use.onclick = () => choose(clip.start, clip.end, row);
      buttons.append(listen, use);
      row.append(label, buttons);
      return row;
    }));
    const first = draft.suggestions[0];
    $("start").value = first ? first.start : 0;
    $("end").value = first ? first.end : 10;
  }

  async function choose(start, end, row = null) {
    stopPlayer();
    document.querySelectorAll(".clip").forEach(el => el.classList.toggle("chosen", el === row));
    const result = document.createElement("p");
    result.className = "status";
    result.textContent = "Checking the part and listening to what was said…";
    $("clipResult").replaceChildren(result);
    try {
      const meta = await api(`/api/voices/${draft.id}/clip`, json("POST", {start, end}));
      chosen = {start, end};
      const q = meta.quality;
      const note = document.createElement("div");
      note.className = `note ${q.ok ? "ok" : "warn"}`;
      note.textContent = q.ok
        ? `Good clip: ${q.duration} s, ${Math.round(q.speech * 100)}% talking, voice ${q.snrDb} dB above the background.`
        : `This part may not sound right: ${q.problems.join(" ")} You can still try it, or pick another part.`;
      const heard = document.createElement("p");
      heard.className = "muted";
      heard.textContent = meta.transcript ? `We heard: “${meta.transcript}”` : "The words could not be transcribed; the voice can still be used.";
      $("clipResult").replaceChildren(note, heard);
      $("previewStatus").textContent = "";
    } catch (error) {
      chosen = null;
      result.textContent = error.message;
    }
    refresh();
  }

  async function preview() {
    stopPlayer();
    $("previewStatus").textContent = "Reading the line in this voice (about 10 seconds)…";
    try {
      const clip = await api(`/api/voices/${draft.id}/preview`, json("POST", {}));
      const audio = new Audio(`${server}${clip.url}?wait=30`);
      player = audio;
      audio.onplaying = () => { $("previewStatus").textContent = "Playing."; };
      audio.onended = () => { $("previewStatus").textContent = "Does it sound like them? If not, try another part."; };
      audio.onerror = () => { $("previewStatus").textContent = "The line is not ready yet. Try again in a moment."; };
      await audio.play();
    } catch (error) {
      $("previewStatus").textContent = error.message;
    }
  }

  async function save() {
    const relation = document.querySelector("input[name=relation]:checked").value;
    try {
      const meta = await api(`/api/voices/${draft.id}/save`, json("POST", {name: $("name").value, relation, attested: $("attest").checked}));
      store.set(meta.id);
      $("saveStatus").textContent = `Saved. Stories will be read in ${meta.name}'s voice.`;
      draft = null; chosen = null;
      $("clips").replaceChildren(); $("clipResult").replaceChildren(); $("file").value = "";
      $("uploadStatus").textContent = ""; $("previewStatus").textContent = "";
      refresh();
      loadVoices();
    } catch (error) {
      $("saveStatus").textContent = error.message;
    }
  }

  async function loadVoices() {
    const list = $("voices");
    try {
      const {voices} = await api("/api/voices");
      const active = store.get();
      if (active && !voices.some(v => v.id === active)) store.set(null);
      const rows = [{id: null, name: "Sample voice (built in)"}, ...voices].map(voice => {
        const row = document.createElement("div");
        row.className = "voice";
        const pick = document.createElement("label");
        pick.className = "option";
        const radio = Object.assign(document.createElement("input"), {type: "radio", name: "active"});
        radio.checked = (store.get() || null) === voice.id;
        radio.onchange = () => store.set(voice.id);
        const text = document.createElement("span");
        text.textContent = voice.name + (voice.consent ? ` · ${voice.consent.statement}` : "");
        pick.append(radio, text);
        row.append(pick);
        if (voice.id) {
          const remove = Object.assign(document.createElement("button"), {type: "button", textContent: "Delete voice"});
          remove.onclick = async () => {
            if (!confirm(`Delete ${voice.name}'s voice and every story line read with it?`)) return;
            await api(`/api/voices/${voice.id}`, {method: "DELETE"}).catch(error => alert(error.message));
            loadVoices();
          };
          row.append(remove);
        }
        return row;
      });
      list.replaceChildren(...rows);
    } catch {
      list.textContent = "The voice server is not running. Start it with: voice/.venv-chatterbox/bin/python -m narration.server";
    }
  }

  async function record() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      $("uploadStatus").textContent = "This browser cannot record. Choose a file instead.";
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
    catch { $("uploadStatus").textContent = "Microphone permission was refused. Choose a file instead."; return; }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      $("record").textContent = `● Record ${RECORD_SECONDS} seconds`;
      $("record").onclick = record;
      upload(new Blob(chunks, {type: recorder.mimeType || "audio/webm"}), "the recording");
    };
    recorder.start();
    let left = RECORD_SECONDS;
    $("uploadStatus").textContent = "Recording. Read a page of any picture book aloud.";
    $("record").textContent = `■ Stop (${left})`;
    $("record").onclick = () => recorder.state === "recording" && recorder.stop();
    const tick = setInterval(() => {
      left -= 1;
      if (recorder.state !== "recording") return clearInterval(tick);
      $("record").textContent = `■ Stop (${left})`;
      if (left <= 0) { clearInterval(tick); recorder.stop(); }
    }, 1000);
  }

  document.querySelectorAll("input[name=relation], #attest").forEach(el => el.addEventListener("change", refresh));
  $("name").addEventListener("input", refresh);
  $("file").addEventListener("change", () => { const f = $("file").files[0]; if (f) upload(f, f.name); });
  $("record").onclick = record;
  $("playManual").onclick = () => playPart(+$("start").value, +$("end").value);
  $("useManual").onclick = () => choose(+$("start").value, +$("end").value);
  $("preview").onclick = preview;
  $("save").onclick = save;
  refresh();
  loadVoices();
})();
