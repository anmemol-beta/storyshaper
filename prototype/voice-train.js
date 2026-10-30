/* Voice practice: read 100 short sentences aloud so the parent's voice can be fine-tuned (narration/finetune.py).
   Each recording goes to the narration server (POST /api/voices/<id>/train/<n>), which keeps the audio with
   its sentence and checks with Muse Voice Transcribe that the sentence was read. The voice is the one saved on
   voice.html (localStorage "story-voice"). */
(() => {
  "use strict";

  const server = new URLSearchParams(location.search).get("voiceServer") || "http://127.0.0.1:8100";
  const $ = id => document.getElementById(id);
  const KO = {
    "Voice Practice · StoryShaper": "목소리 연습 · StoryShaper",
    "Teach the story voice": "동화 목소리 가르치기", "Teach the story {name} voice": "{name} 목소리 가르치기",
    "Read each sentence aloud, the way you would at bedtime. About 100 short sentences (10 minutes) make the stories sound much more like you. You can stop and come back any time.":
      "잠자리에서 읽어 주듯이 문장을 하나씩 소리 내어 읽어 주세요. 짧은 문장 100개(약 10분)면 동화 목소리가 훨씬 더 닮아져요. 언제든 멈췄다가 이어서 할 수 있어요.",
    "‹ Back": "‹ 이전", "▶ Listen": "▶ 들어 보기", "Skip ›": "건너뛰기 ›",
    "A quiet room, the phone about a hand's width from your mouth.": "조용한 방에서, 휴대폰을 입에서 한 뼘쯤 떨어뜨려 주세요.",
    "Read naturally. Small mistakes are fine; just record that sentence again.": "자연스럽게 읽어 주세요. 틀리면 그 문장만 다시 녹음하면 돼요.",
    "Press the space bar to start and stop on a computer.": "컴퓨터에서는 스페이스바로 녹음을 시작하고 멈출 수 있어요.",
    "Sentence {n} of {total}": "{total}개 중 {n}번째 문장",
    "{done} of {total} sentences · {minutes} min {seconds} s recorded": "{total}개 중 {done}개 · {minutes}분 {seconds}초 녹음",
    "Tap the button and read the sentence.": "버튼을 누르고 문장을 읽어 주세요.", "Recording… tap again when you finish.": "녹음 중… 다 읽으면 다시 눌러 주세요.",
    "Checking…": "확인하는 중…", "Saved. Next sentence.": "저장했어요. 다음 문장이에요.",
    "Saved, but it may not match the sentence. Listen, and record again if needed.": "저장했지만 문장과 조금 다르게 들렸어요. 들어 보고 필요하면 다시 녹음해 주세요.",
    "We heard: “{heard}”": "이렇게 들렸어요: “{heard}”", "Already recorded. Record again to replace it.": "이미 녹음했어요. 다시 녹음하면 바뀌어요.",
    "All sentences are recorded. Thank you! The voice can be trained now.": "모든 문장을 녹음했어요. 고마워요! 이제 목소리를 학습할 수 있어요.",
    "Save a parent's voice first, then come back here.": "먼저 부모 목소리를 저장한 다음 여기로 와 주세요.",
    "The voice helper on this computer isn't running. Start it, then try again.": "이 컴퓨터의 목소리 서버가 꺼져 있어요. 켠 다음 다시 해 주세요.",
    "The microphone is blocked. Allow it in the browser.": "마이크가 막혀 있어요. 브라우저에서 허용해 주세요.",
    "Record": "녹음", "Stop": "멈추기",
    "Can't read these sentences? Add videos or voice messages of them instead.": "문장을 읽어 줄 수 없나요? 그 사람의 영상이나 음성 메시지를 대신 올려 주세요.",
    "Add videos or voice messages": "영상·음성 메시지 올리기",
    "Listening to {name}…": "{name} 듣는 중…",
    "Added {added} clips ({seconds} s) from {name}.": "{name}에서 {added}개 구간({seconds}초)을 더했어요.",
  };
  let language = (() => {
    const asked = new URLSearchParams(location.search).get("lang");
    if (asked === "ko" || asked === "en") return asked;
    try { return localStorage.getItem("story-language") === "ko" ? "ko" : "en"; } catch { return "en"; }
  })();
  const tr = (source, values = {}) => (language === "ko" ? KO[source] || source : source)
    .replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const voiceId = stored("story-voice");
  const voiceName = stored("story-voice-name");

  let sentences = [];
  let done = {};               // n -> clip info from the server
  let index = 0;               // position in sentences
  let recorder = null;
  let lastUrl = null;

  function error(message) { $("error").textContent = message; $("error").hidden = !message; }

  async function call(path, options) {
    let response;
    try { response = await fetch(server + path, options); }
    catch { throw new Error(tr("The voice helper on this computer isn't running. Start it, then try again.")); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || String(response.status));
    return body;
  }

  function showProgress() {
    const clips = Object.values(done);
    const read = clips.filter(c => c.source !== "media").length;
    const secs = Math.round(clips.reduce((s, c) => s + c.seconds, 0));
    $("meter").style.width = `${Math.min(1, secs / 600) * 100}%`;          // ten minutes of speech fills the bar
    $("count").textContent = tr("{done} of {total} sentences · {minutes} min {seconds} s recorded",
      {done: read, total: sentences.length, minutes: Math.floor(secs / 60), seconds: secs % 60});
  }

  function show() {
    const s = sentences[index];
    if (!s) return;
    $("num").textContent = tr("Sentence {n} of {total}", {n: s.n, total: sentences.length});
    $("sentence").textContent = s.text;
    $("hint").textContent = done[s.n] ? tr("Already recorded. Record again to replace it.") : tr("Tap the button and read the sentence.");
    $("result").textContent = "";
    $("result").className = "result";
    $("listen").hidden = !lastUrl || lastUrl.n !== s.n;
    $("prev").disabled = index === 0;
    showProgress();
  }

  function next() {
    const open = sentences.findIndex((s, i) => i > index && !done[s.n]);
    if (open >= 0) index = open;
    else if (sentences.every(s => done[s.n])) { $("hint").textContent = tr("All sentences are recorded. Thank you! The voice can be trained now."); return; }
    else index = Math.min(index + 1, sentences.length - 1);
    show();
  }

  async function toggle() {
    if (recorder) return recorder.stop();
    error("");
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}}); }
    catch { return error(tr("The microphone is blocked. Allow it in the browser.")); }
    const chunks = [];
    const s = sentences[index];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      recorder = null;
      $("rec").classList.remove("on"); $("card").classList.remove("live");
      $("rec").textContent = "●"; $("rec").setAttribute("aria-label", tr("Record"));
      const blob = new Blob(chunks, {type: chunks[0]?.type || "audio/webm"});
      lastUrl = {n: s.n, url: URL.createObjectURL(blob)};
      $("hint").textContent = tr("Checking…");
      try {
        const clip = await call(`/api/voices/${voiceId}/train/${s.n}`, {method: "POST", headers: {"Content-Type": blob.type.split(";")[0]}, body: blob});
        done[s.n] = clip;
        const good = clip.match === null || clip.match >= 0.8;
        if (good) { show(); $("result").textContent = tr("Saved. Next sentence."); setTimeout(next, 700); }
        else {
          show();
          $("result").className = "result bad";
          $("result").textContent = tr("Saved, but it may not match the sentence. Listen, and record again if needed.") + " " + tr("We heard: “{heard}”", {heard: clip.heard});
        }
      } catch (e) { error(e.message); show(); }
    };
    recorder.start();
    $("rec").classList.add("on"); $("card").classList.add("live");
    $("rec").textContent = "■"; $("rec").setAttribute("aria-label", tr("Stop"));
    $("hint").textContent = tr("Recording… tap again when you finish.");
  }

  function applyCopy() {
    document.documentElement.lang = language;
    document.title = tr("Voice Practice · StoryShaper");
    document.querySelectorAll("[data-t]").forEach(el => {
      if (!el.dataset.source) el.dataset.source = el.textContent.trim().replace(/\s+/g, " ");
      el.textContent = tr(el.dataset.source);
    });
    document.querySelectorAll("[data-lang]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === language)));
    $("title").textContent = voiceName ? tr("Teach the story {name} voice", {name: voiceName + (language === "ko" ? "" : "’s")}) : tr("Teach the story voice");
    $("rec").setAttribute("aria-label", tr(recorder ? "Stop" : "Record"));
    $("home").href = `voice.html?lang=${language}`;
    show();
  }

  // Home videos and voice messages: the server cuts them at pauses and uses the transcript as each clip's text.
  $("media").onchange = async () => {
    const files = [...$("media").files];
    $("media").value = "";
    for (const file of files) {
      $("mediaStatus").textContent = tr("Listening to {name}…", {name: file.name});
      try {
        const result = await call(`/api/voices/${voiceId}/train`, {method: "POST", headers: {"Content-Type": file.type || "audio/mpeg"}, body: file});
        for (const c of result.clips) done[c.n] = c;
        $("mediaStatus").textContent = tr("Added {added} clips ({seconds} s) from {name}.", {added: result.added, seconds: result.seconds, name: file.name});
        showProgress();
      } catch (e) { error(e.message); }
    }
  };
  $("rec").onclick = toggle;
  $("skip").onclick = () => { index = Math.min(index + 1, sentences.length - 1); lastUrl = null; show(); };
  $("prev").onclick = () => { index = Math.max(0, index - 1); lastUrl = null; show(); };
  $("listen").onclick = () => lastUrl && new Audio(lastUrl.url).play();
  document.addEventListener("keydown", e => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); toggle(); } });
  document.querySelectorAll("[data-lang]").forEach(b => { b.onclick = () => { language = b.dataset.lang; try { localStorage.setItem("story-language", language); } catch {} applyCopy(); }; });

  (async () => {
    try { sentences = await (await fetch("audio/training-sentences.json")).json(); } catch { sentences = []; }
    if (!voiceId) { applyCopy(); $("card").hidden = true; return error(tr("Save a parent's voice first, then come back here.")); }
    try { for (const c of (await call(`/api/voices/${voiceId}/train`)).clips) done[c.n] = c; }
    catch (e) { error(e.message); }
    index = Math.max(0, sentences.findIndex(s => !done[s.n]));
    applyCopy();
  })();
})();
