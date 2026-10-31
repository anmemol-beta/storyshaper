/* Voice practice: read 100 short sentences aloud so the parent's voice can be fine-tuned (narration/finetune.py).
   Each recording goes to the narration server (POST /api/voices/<id>/train/<n>), which keeps the audio with
   its sentence and checks with Muse Voice Transcribe that the sentence was read. The voice is the one saved on
   voice.html (localStorage "story-voice"). */
(() => {
  "use strict";

  // The voice server: Modal (deploy/modal_voice.py) unless ?voiceServer= names another, e.g. http://127.0.0.1:8100 for
  // the server on this Mac. The choice is remembered so links between pages keep it; ?voiceServer=modal goes back.
  // Same in narration.js, voice-setup.js and voice-train.js.
  const server = (() => {
    const MODAL = "https://shj0213--storyshaper-voice.us-east.modal.run";
    const asked = new URLSearchParams(location.search).get("voiceServer");
    const chosen = asked && asked !== "modal" ? asked.replace(/\/$/, "") : null;
    try {
      if (asked === "modal") localStorage.removeItem("voice-server");
      else if (chosen) localStorage.setItem("voice-server", chosen);
      return chosen || localStorage.getItem("voice-server") || MODAL;
    } catch { return chosen || MODAL; }
  })();
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
    "Listen to each part and fix any words we heard wrong. Wrong words teach the voice wrong sounds.": "구간을 하나씩 들어 보고 잘못 받아쓴 말을 고쳐 주세요. 틀린 문장은 목소리에 틀린 발음을 가르쳐요.",
    "Don't use": "쓰지 않기", "Play part {n}": "{n}번 구간 듣기",
    "Sound more like your bedtime reading: build the story voice from the practice sentences you read in your usual voice. You can go back any time.":
      "잠자리에서 읽어 주는 목소리에 더 가깝게: 평소 목소리로 읽은 연습 문장으로 동화 목소리를 다시 만들어요. 언제든 되돌릴 수 있어요.",
    "Use my practice reading": "연습한 목소리 쓰기", "Go back to the first recording": "처음 녹음으로 되돌리기",
    "Making the voice…": "목소리를 만드는 중…",
    "Done. Stories now use sentences {list}. New pages will be read in this voice.": "완료! 이제 {list}번 문장으로 읽어요. 새로 읽는 페이지부터 이 목소리예요.",
    "Back to the first recording.": "처음 녹음으로 되돌렸어요.",
    "Practice": "연습", "Story characters": "동화 배역", "Usual voice · English": "평소 목소리 · 영어",
    "Character": "등장인물", "All characters": "모든 배역", "Narrator": "이야기꾼", "Oldest pig": "첫째 돼지",
    "Middle pig": "둘째 돼지", "Youngest pig": "막내 돼지", "Wolf": "늑대",
    "I listened: the role and emotion match": "들어 보니 배역과 감정에 맞아요",
    "Listen before confirming the performance.": "녹음을 들어 본 다음 배역과 감정을 확인해 주세요.",
    "Performance reviewed. Ready to include in the matching training dataset.": "연기를 확인했어요. 같은 배역·감정의 학습 자료에 넣을 수 있어요.",
    "Performance reviewed; the transcript still needs a matching check.": "연기는 확인했지만, 읽은 문장이 대본과 맞는지 확인이 더 필요해요.",
    "Personality: {traits}. {style}": "성격: {traits}. {style}",
    "Story practice recordings need a listening check before training. Recording a line does not start model training.":
      "동화 연습 녹음은 들어 보고 확인한 뒤 학습 자료에 넣어요. 녹음만으로 모델 학습이 시작되지는 않아요.",
    "Recordings are saved. Listen and confirm each role and emotion before preparing training data.":
      "녹음을 저장했어요. 학습 자료를 만들기 전에 각 배역과 감정을 들어 보고 확인해 주세요.",
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
  let generalSentences = [], storySamples = [], scriptRevision = null;
  let practiceMode = "story", catalogRequest = 0, listened = new Set();
  let done = {};               // n -> clip info from the server
  let index = 0;               // position in sentences
  let recorder = null;
  let lastUrl = null;
  let practiceAudio = null, listenRequest = 0, practiceBusy = false;

  function stopPracticeAudio() {
    listenRequest++;
    if (practiceAudio) { practiceAudio.onended = null; practiceAudio.pause(); practiceAudio = null; }
  }

  function setPracticeBusy(busy) {
    practiceBusy = busy;
    for (const id of ["practiceMode", "speakerFilter", "skip", "listen", "media"]) $(id).disabled = busy;
    $("prev").disabled = busy || index === 0;
    $("rec").disabled = busy && !recorder;
    $("reviewPerformance").disabled = busy || !listened.has(sentences[index]?.n);
    document.querySelectorAll("[data-lang]").forEach(b => { b.disabled = busy; });
  }

  function recorded(s) {
    const clip = done[s.n];
    return !s.id || (clip?.desiredPerformance?.scriptLineId === s.id && clip?.desiredPerformance?.revision === s.revision && clip.text === s.text) ? clip : null;
  }

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
    const read = sentences.filter(s => recorded(s)).length;
    const secs = Math.round(clips.filter(c => !c.excluded).reduce((s, c) => s + c.seconds, 0));
    $("meter").style.width = `${Math.min(1, secs / 600) * 100}%`;          // ten minutes of speech fills the bar
    $("count").textContent = tr("{done} of {total} sentences · {minutes} min {seconds} s recorded",
      {done: read, total: sentences.length, minutes: Math.floor(secs / 60), seconds: secs % 60});
  }

  function show() {
    const s = sentences[index];
    if (!s) return;
    $("num").textContent = tr("Sentence {n} of {total}", {n: index + 1, total: sentences.length});
    $("sentence").textContent = s.text;
    const directed = Boolean(s.id);
    $("performanceDirection").hidden = $("personality").hidden = !directed;
    $("performanceDirection").textContent = s.recordingPrompt || "";
    $("personality").textContent = directed ? tr("Personality: {traits}. {style}", {traits: s.personality.join(", "), style: s.speechStyle}) : "";
    $("hint").textContent = recorded(s) ? tr("Already recorded. Record again to replace it.") : tr("Tap the button and read the sentence.");
    $("result").textContent = "";
    $("result").className = "result";
    $("listen").hidden = !(lastUrl?.n === s.n || recorded(s));
    const clip = recorded(s);
    $("reviewPerformance").hidden = !directed || !clip || clip.performanceReview === "confirmed";
    $("reviewPerformance").disabled = !listened.has(s.n);
    $("performanceReview").hidden = !directed || !clip;
    $("performanceReview").textContent = clip?.performanceReview === "confirmed"
      ? tr(clip.match !== null && clip.match >= 0.8 ? "Performance reviewed. Ready to include in the matching training dataset."
        : "Performance reviewed; the transcript still needs a matching check.")
      : tr("Listen before confirming the performance.");
    $("prev").disabled = index === 0;
    showProgress();
    setPracticeBusy(practiceBusy);
  }

  function next() {
    stopPracticeAudio();
    const open = sentences.findIndex((s, i) => i > index && !recorded(s));
    if (open >= 0) index = open;
    else if (sentences.every(s => recorded(s))) {
      const reviewed = sentences.every(s => !s.id || (recorded(s).performanceReview === "confirmed" && recorded(s).match !== null && recorded(s).match >= 0.8));
      $("hint").textContent = tr(reviewed ? "All sentences are recorded. Thank you! The voice can be trained now."
        : "Recordings are saved. Listen and confirm each role and emotion before preparing training data."); return;
    }
    else index = Math.min(index + 1, sentences.length - 1);
    show();
  }

  async function toggle() {
    if (recorder) return recorder.stop();
    if (practiceBusy) return;
    stopPracticeAudio();
    setPracticeBusy(true);
    error("");
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}}); }
    catch { setPracticeBusy(false); return error(tr("The microphone is blocked. Allow it in the browser.")); }
    const chunks = [];
    const s = sentences[index];
    recorder = new MediaRecorder(stream);
    setPracticeBusy(true);
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      recorder = null;
      setPracticeBusy(true);
      $("rec").classList.remove("on"); $("card").classList.remove("live");
      $("rec").textContent = "●"; $("rec").setAttribute("aria-label", tr("Record"));
      const blob = new Blob(chunks, {type: chunks[0]?.type || "audio/webm"});
      lastUrl = {n: s.n, url: URL.createObjectURL(blob)};
      $("hint").textContent = tr("Checking…");
      try {
        const query = s.id ? `?scriptLineId=${encodeURIComponent(s.id)}&revision=${encodeURIComponent(s.revision)}` : "";
        const clip = await call(`/api/voices/${voiceId}/train/${s.n}${query}`, {method: "POST", headers: {"Content-Type": blob.type.split(";")[0]}, body: blob});
        done[s.n] = clip;
        listened.delete(s.n);
        showSample();
        const good = clip.match === null || clip.match >= 0.8;
        if (good) { show(); $("result").textContent = tr("Saved. Next sentence."); if (!s.id) setTimeout(next, 700); }
        else {
          show();
          $("result").className = "result bad";
          $("result").textContent = tr("Saved, but it may not match the sentence. Listen, and record again if needed.") + " " + tr("We heard: “{heard}”", {heard: clip.heard});
        }
      } catch (e) { error(e.message); show(); }
      finally { setPracticeBusy(false); }
    };
    recorder.start();
    $("rec").classList.add("on"); $("card").classList.add("live");
    $("rec").textContent = "■"; $("rec").setAttribute("aria-label", tr("Stop"));
    $("hint").textContent = tr("Recording… tap again when you finish.");
  }

  function selectSentences() {
    stopPracticeAudio();
    const speaker = $("speakerFilter").value;
    sentences = practiceMode === "general" ? generalSentences : storySamples.filter(s => speaker === "all" || s.speakerId === speaker);
    $("speakerFilterLabel").hidden = practiceMode !== "story";
    index = Math.max(0, sentences.findIndex(s => !recorded(s)));
    lastUrl = null;
    show();
  }

  async function loadScript() {
    const request = ++catalogRequest;
    const catalog = await call(`/api/voice/training-script?language=${language}`);
    if (request !== catalogRequest) return;
    if (scriptRevision !== catalog.revision) listened.clear();
    scriptRevision = catalog.revision;
    storySamples = catalog.samples.map(s => ({...s, revision: scriptRevision}));
    selectSentences();
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

  // Clips cut from videos: listen, correct the words, or leave a clip out (POST /train/<n> with JSON).
  function renderMedia() {
    const clips = Object.values(done).filter(c => c.source === "media").sort((a, b) => a.n - b.n);
    $("mediaHelp").hidden = !clips.length;
    $("mediaClips").replaceChildren(...clips.map(c => {
      const li = document.createElement("li");
      li.classList.toggle("off", Boolean(c.excluded));
      const play = Object.assign(document.createElement("button"), {type: "button", textContent: "▶"});
      play.setAttribute("aria-label", tr("Play part {n}", {n: c.n - 1000}));
      play.onclick = () => new Audio(`${server}/api/voices/${voiceId}/train/${c.n}.wav`).play();
      const text = Object.assign(document.createElement("textarea"), {rows: 2, value: c.text});
      const save = async body => {
        try { done[c.n] = await call(`/api/voices/${voiceId}/train/${c.n}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}); }
        catch (e) { error(e.message); }
        renderMedia();
        showProgress();
      };
      text.onchange = () => save({text: text.value});
      const off = document.createElement("label");
      const box = Object.assign(document.createElement("input"), {type: "checkbox", checked: Boolean(c.excluded)});
      box.onchange = () => save({excluded: box.checked});
      off.append(box, " " + tr("Don't use"));
      li.append(play, text, off);
      return li;
    }));
  }

  // The voice sample (ref.wav) from practice sentences read in the parent's usual voice; off until asked for.
  let sample = null;
  function showSample() {
    const clear = Object.values(done).filter(c => c.source !== "media" && !c.excluded && c.match >= 0.9).length;
    $("sampleCard").hidden = clear < 3 && !sample;
    $("undoSample").hidden = !sample;
  }
  async function setSample(from) {
    error("");
    $("useSample").disabled = $("undoSample").disabled = true;
    $("sampleStatus").textContent = tr("Making the voice…");
    try {
      const result = await call(`/api/voices/${voiceId}/sample`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({from})});
      sample = from === "practice" ? result : null;
      $("sampleStatus").textContent = sample ? tr("Done. Stories now use sentences {list}. New pages will be read in this voice.", {list: sample.sentences.join(", ")}) : tr("Back to the first recording.");
    } catch (e) { $("sampleStatus").textContent = ""; error(e.message); }
    $("useSample").disabled = $("undoSample").disabled = false;
    showSample();
  }
  $("useSample").onclick = () => setSample("practice");
  $("undoSample").onclick = () => setSample("original");

  // Home videos and voice messages: the server cuts them at pauses and uses the transcript as each clip's text.
  $("media").onchange = async () => {
    const files = [...$("media").files];
    $("media").value = "";
    for (const file of files) {
      $("mediaStatus").textContent = tr("Listening to {name}…", {name: file.name});
      try {
        const result = await call(`/api/voices/${voiceId}/train`, {method: "POST", headers: {"Content-Type": file.type || "audio/mpeg"}, body: file});
        for (const c of result.clips) done[c.n] = c;
        renderMedia();
        $("mediaStatus").textContent = tr("Added {added} clips ({seconds} s) from {name}.", {added: result.added, seconds: result.seconds, name: file.name});
        showProgress();
      } catch (e) { error(e.message); }
    }
  };
  $("rec").onclick = toggle;
  $("skip").onclick = () => { stopPracticeAudio(); index = Math.min(index + 1, sentences.length - 1); lastUrl = null; show(); };
  $("prev").onclick = () => { stopPracticeAudio(); index = Math.max(0, index - 1); lastUrl = null; show(); };
  $("listen").onclick = async () => {
    const s = sentences[index];
    if (!s || !(lastUrl?.n === s.n || recorded(s))) return;
    stopPracticeAudio();
    const request = listenRequest;
    const audio = new Audio(lastUrl?.n === s.n ? lastUrl.url : `${server}/api/voices/${voiceId}/train/${s.n}.wav`);
    practiceAudio = audio;
    audio.onended = () => { if (request !== listenRequest || practiceAudio !== audio) return; practiceAudio = null; listened.add(s.n); show(); };
    try { await audio.play(); } catch (e) { error(e.message); }
  };
  $("reviewPerformance").onclick = async () => {
    const s = sentences[index];
    if (!s?.id || !listened.has(s.n)) return;
    try {
      done[s.n] = await call(`/api/voices/${voiceId}/train/${s.n}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({performanceReviewed: true})});
      show();
    } catch (e) { error(e.message); }
  };
  $("practiceMode").onchange = () => { if (recorder) return; practiceMode = $("practiceMode").value; selectSentences(); };
  $("speakerFilter").onchange = () => { if (!recorder) selectSentences(); };
  document.addEventListener("keydown", e => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); toggle(); } });
  document.querySelectorAll("[data-lang]").forEach(b => { b.onclick = async () => {
    if (recorder) return;
    language = b.dataset.lang; try { localStorage.setItem("story-language", language); } catch {}
    applyCopy();
    try { await loadScript(); } catch (e) { error(e.message); }
  }; });

  (async () => {
    try { generalSentences = await (await fetch("audio/training-sentences.json")).json(); } catch { generalSentences = []; }
    if (!voiceId) { applyCopy(); $("card").hidden = true; return error(tr("Save a parent's voice first, then come back here.")); }
    try { const status = await call(`/api/voices/${voiceId}/train`); for (const c of status.clips) done[c.n] = c; sample = status.sample; }
    catch (e) { error(e.message); }
    try { await loadScript(); } catch (e) { error(e.message); practiceMode = "general"; $("practiceMode").value = "general"; selectSentences(); }
    applyCopy();
    renderMedia();
    showSample();
  })();
})();
