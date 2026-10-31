/* Child reader: server-owned story state, shared input, narration and image modules. */
(() => {
  "use strict";
  const ids = ["book", "cover", "startLabel", "storyTitle", "readBy", "language", "mode",
    "languageLabel", "modeLabel", "settingsButton", "readerSettings", "readerName", "changeVoice",
    "readAloud", "readAloudLabel", "imgCur", "imgNext", "storyVideo", "narrative", "question",
    "freeInput", "inputActions", "answer", "send", "mic", "cameraButton", "cameraPanel",
    "cameraPreview", "cameraSnap", "cameraCancel", "status", "choices", "progress", "restart",
    "loading", "loadingText", "retryMedia", "addVoice", "voiceSelect", "voiceSelectLabel", "voiceSelectStatus",
    "narrationControls", "playNarration", "pauseNarration", "narrationStatus"];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const t = (en, ko) => ui.language.value === "ko" ? ko : en;
  const say = message => { ui.status.textContent = message; };
  const questionKey = state => state?.question ? `${state.sessionId}:${state.question.id}` : null;
  const choiceLocks = new Set();
  let snapshot = null, displayed = null, pending = null, activity = "idle", epoch = 0;
  let requestController = null, inputController = null, inputToken = 0, recording = null, camera = null;
  let retryPayload = null, spokenKey = null, replay = 0, configured = false, config = {};
  let selectedMode = "mock", selectedLanguage = localStorage.getItem("story-language") === "en" ? "en" : "ko";
  let savedVoices = [], voiceListLoading = false, voiceListRequest = 0;
  let playback = typeof Narration !== "undefined" ? Narration.playbackState?.() || "idle" : "idle";
  ui.language.value = selectedLanguage;
  ui.mode.value = selectedMode;

  const media = new StoryMediaPlayer(ui.imgCur, ui.imgNext, {onState: mediaState});
  const motion = typeof StoryMotion !== "undefined" ? new StoryMotion(ui.imgCur.parentElement) : null;
  const choiceOnly = (state = snapshot) => Boolean(state?.question &&
    (state.choiceMode || choiceLocks.has(questionKey(state))));
  const canAnswer = () => configured && activity === "idle" && !pending && Boolean(snapshot?.question);
  const voiceSupported = () => typeof VoiceInput !== "undefined" && VoiceInput.supported();
  const cameraSupported = () => typeof CameraInput !== "undefined" && CameraInput.supported();

  function syncControls() {
    const locked = !canAnswer();
    const visible = pending ? displayed : snapshot;
    const choices = choiceOnly(visible);
    ui.freeInput.hidden = !visible?.question || choices;
    ui.inputActions.hidden = !visible?.question || choices;
    ui.answer.disabled = locked || choices;
    ui.send.disabled = locked || choices;
    ui.mic.disabled = choices || (activity === "recording" ? false : locked);
    ui.mic.textContent = activity === "recording" ? "■" : selectedMode === "mock"
      ? t("Choose", "고르기") : "🎙";
    ui.mic.setAttribute("aria-label", activity === "recording" ? t("Finish recording", "녹음 끝내기")
      : selectedMode === "mock" ? t("Choose an answer", "선택지로 답하기") : t("Record answer", "말로 답하기"));
    ui.cameraButton.hidden = selectedMode !== "live" || !config.visionAvailable || !cameraSupported();
    ui.cameraButton.disabled = locked || choices;
    ui.choices.hidden = !choices;
    for (const button of ui.choices.children) button.disabled = locked;
    ui.language.disabled = ui.mode.disabled = !configured || activity !== "idle" || Boolean(pending);
    ui.cover.disabled = !configured || activity !== "idle" || Boolean(pending);
    ui.restart.disabled = !configured;
    ui.book.setAttribute("aria-busy", String(Boolean(pending) || activity === "request"));
    ui.book.dataset.state = !snapshot ? "COVER" : pending ? "DRAWING"
      : activity === "recording" ? "LISTENING" : snapshot.question ? "ASKING" : "COMPLETE";
    ui.voiceSelect.disabled = !configured || voiceListLoading || activity !== "idle" || Boolean(pending);
    syncPlayback();
  }

  function syncPlayback() {
    const available = configured && Boolean(displayed) && !pending && activity === "idle";
    ui.playNarration.disabled = !available || ["playing", "loading"].includes(playback);
    ui.pauseNarration.disabled = !available || !["playing", "loading"].includes(playback);
    ui.playNarration.textContent = playback === "paused" ? t("▶ Resume", "▶ 이어 듣기") : t("▶ Play", "▶ 재생");
    ui.pauseNarration.textContent = t("Ⅱ Pause", "Ⅱ 일시정지");
    const browserVoice = typeof Narration !== "undefined" && Narration.voiceSource?.() === "browser";
    ui.narrationStatus.textContent = !displayed ? "" : playback === "paused" ? t("Paused", "일시정지했어요")
      : playback === "loading" ? t("Preparing narration…", "낭독을 준비하고 있어요…")
      : playback === "playing" ? browserVoice ? t("Reading with the browser voice", "기본 음성으로 읽는 중")
        : t("Reading aloud", "소리 내어 읽는 중")
      : t("Tap Play to hear this page", "재생을 누르면 이 장면을 읽어 줘요");
  }

  function stopNarration() {
    spokenKey = null;
    if (typeof Narration !== "undefined") Narration.stop();
    highlight(-1);
  }

  function stopVideo() {
    ui.storyVideo.pause();
    ui.storyVideo.removeAttribute("src");
    ui.storyVideo.load();
    ui.storyVideo.hidden = true;
  }

  function closeCamera() {
    camera?.close();
    camera = null;
    ui.cameraPanel.hidden = true;
  }

  function cancelInput() {
    inputToken++;
    inputController?.abort();
    inputController = null;
    recording?.stop();
    recording = null;
    closeCamera();
  }

  function cancelWork({server = true} = {}) {
    epoch++;
    requestController?.abort();
    requestController = null;
    cancelInput();
    stopNarration();
    stopVideo();
    motion?.stop();
    media.cancel({server});
    pending = null;
    ui.loading.hidden = true;
    ui.retryMedia.hidden = true;
  }

  async function api(path, body, signal) {
    const response = await fetch(path, {method: body ? "POST" : "GET", cache: "no-store", signal,
      headers: {"Content-Type": "application/json"}, ...(body ? {body: JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error?.message || "Server unavailable");
      error.snapshot = data.snapshot;
      throw error;
    }
    return data;
  }

  function valid(state) {
    return state && typeof state.sessionId === "string" && Number.isInteger(state.version)
      && Array.isArray(state.lines) && (state.question === null ||
        (typeof state.question?.id === "string" && Array.isArray(state.question.choices)
          && state.question.choices.length === 3 && state.question.choices.every(choice =>
            typeof choice.id === "string" && typeof choice.label === "string" && typeof choice.answer === "string")));
  }

  function labels() {
    document.documentElement.lang = ui.language.value;
    ui.storyTitle.textContent = t("The Three Little Pigs", "아기돼지 삼형제");
    ui.startLabel.textContent = t("▶ Start", "▶ 동화 시작");
    ui.languageLabel.textContent = t("Language", "언어");
    ui.modeLabel.textContent = t("Version", "버전");
    ui.mode.options[0].textContent = t("Offline version", "오프라인 버전");
    ui.mode.options[1].textContent = t("AI version", "AI 버전");
    ui.send.textContent = t("Send", "답하기");
    ui.answer.placeholder = t("Your answer or idea", "답이나 생각을 적어 줘");
    ui.answer.setAttribute("aria-label", t("Your answer", "답변"));
    ui.restart.textContent = t("↻ Restart", "↻ 처음부터");
    ui.changeVoice.textContent = t("Change voice", "목소리 바꾸기");
    ui.readAloudLabel.textContent = t("Read aloud", "소리 내어 읽기");
    ui.cameraButton.textContent = t("📷 Show an object", "📷 물건 보여주기");
    ui.cameraSnap.textContent = t("Take picture", "사진 찍기");
    ui.cameraCancel.textContent = t("Cancel", "닫기");
    ui.retryMedia.textContent = t("Reload picture", "그림 다시 불러오기");
    ui.settingsButton.setAttribute("aria-label", t("Reader settings", "낭독 설정"));
    ui.voiceSelectLabel.textContent = t("Saved voices", "저장된 목소리");
    ui.narrationControls.setAttribute("aria-label", t("Narration playback", "낭독 재생"));
    voiceOptions();
    reader();
    syncPlayback();
  }

  function voiceOptions() {
    const selected = typeof Narration !== "undefined" ? Narration.voiceId?.() || "" : "";
    const options = [{id: "", name: t("Storybook voice", "기본 목소리")}, ...savedVoices];
    // Keep the selected name while a service error prevents refreshing the list.
    if (selected && !options.some(voice => voice.id === selected))
      options.push({id: selected, name: Narration.voiceName?.() || selected});
    ui.voiceSelect.replaceChildren(...options.map(voice => {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name;
      return option;
    }));
    ui.voiceSelect.value = selected;
  }

  async function loadVoices() {
    const request = ++voiceListRequest;
    voiceListLoading = true;
    ui.voiceSelectStatus.textContent = t("Loading saved voices…", "저장된 목소리를 불러오고 있어요…");
    syncControls();
    try {
      if (typeof Narration === "undefined" || !Narration.listVoices) throw new Error("Voice service unavailable");
      const voices = await Narration.listVoices();
      if (request !== voiceListRequest || ui.readerSettings.hidden) return;
      savedVoices = voices.filter(voice => typeof voice.id === "string" && typeof voice.name === "string");
      const selected = Narration.voiceId?.();
      if (selected && !savedVoices.some(voice => voice.id === selected)) chooseVoice("");
      voiceOptions();
      ui.voiceSelectStatus.textContent = savedVoices.length ? t("Choose a voice to read this story.", "동화를 읽어 줄 목소리를 골라 주세요.")
        : t("No saved voices yet. Add a parent's voice.", "저장된 목소리가 없어요. 부모 목소리를 추가해 주세요.");
    } catch {
      if (request !== voiceListRequest || ui.readerSettings.hidden) return;
      voiceOptions();
      ui.voiceSelectStatus.textContent = t("Couldn't load saved voices. Reopen settings to try again.", "목소리 목록을 불러오지 못했어요. 설정을 다시 열어 주세요.");
    } finally {
      if (request === voiceListRequest) { voiceListLoading = false; syncControls(); }
    }
  }

  function chooseVoice(id) {
    const voice = savedVoices.find(voice => voice.id === id);
    if (id && !voice) { voiceOptions(); return; }
    stopNarration();
    Narration.selectVoice?.(id || null, voice?.name || "");
    reader();
    voiceOptions();
    if (displayed && !pending && activity === "idle" && ui.readAloud.checked) { replay++; narrate(); }
  }

  function reader() {
    const saved = typeof Narration !== "undefined" && Narration.voiceName?.();
    const name = saved || t("Storybook voice", "기본 목소리");
    ui.readerName.textContent = t("Reader: ", "읽어주는 목소리: ") + name;
    ui.readBy.textContent = t("Read by ", "읽어주는 목소리: ") + name;
    ui.changeVoice.textContent = saved ? t("Change voice", "목소리 바꾸기") : t("Add a parent's voice", "부모 목소리 추가하기");
    ui.addVoice.hidden = Boolean(saved);
    ui.addVoice.textContent = t("🎙 Add a parent's voice", "🎙 부모 목소리 추가");
    for (const link of [ui.changeVoice, ui.addVoice])
      link.href = "voice.html?return=index.html&lang=" + ui.language.value;
  }

  function highlight(index) {
    [...ui.narrative.children].forEach((paragraph, i) => paragraph.classList.toggle("speaking", i === index));
    ui.question.classList.toggle("speaking", index === ui.narrative.children.length);
  }

  function narrate() {
    if (!displayed || pending || !ui.readAloud.checked || typeof Narration === "undefined") return;
    const state = displayed;
    const choices = choiceOnly();
    const key = `${choices ? 'choices:' : ''}${state.sessionId}:${state.version}:${state.language}:${replay}`;
    if (spokenKey === key) return;
    spokenKey = key;
    const lines = choices ? [
      {speakerId: "narrator", text: t("Tap one of these three words.", "세 가지 중 하나를 톡 골라 줘!")},
      ...state.question.choices.map(choice => ({speakerId: "narrator", text: choice.label}))
    ] : state.question ? [...state.lines, {speakerId: "narrator", text: state.question.text}] : state.lines;
    Promise.resolve(Narration.speak(lines, {key, language: state.language,
      onLine: index => { if (spokenKey === key && !pending) highlight(choices ? -1 : index); },
      onSpeak: index => { if (spokenKey === key && !pending && !choices) motion?.cue(index, key); }})).catch(() => {});
  }

  function render(state) {
    displayed = snapshot = state;
    if (state.choiceMode) choiceLocks.add(questionKey(state));
    ui.cover.hidden = true;
    ui.narrative.replaceChildren(...state.lines.map(line => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line.text;
      return paragraph;
    }));
    ui.question.textContent = state.question?.text || t("The End", "이야기 끝");
    ui.answer.value = "";
    ui.choices.replaceChildren(...(state.question?.choices || []).map(choice => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice.label;
      const binding = questionKey(state);
      button.onclick = () => {
        if (binding === questionKey(snapshot) && state.version === snapshot.version) return answer(choice.answer, choice.id);
      };
      return button;
    }));
    ui.progress.textContent = state.question
      ? t("House ", "집 ") + (state.storyState?.houseIndex || 1) + " / 3"
      : t("Story complete", "동화를 다 읽었어요");
    activity = "idle";
    say(choiceOnly() ? t("Tap one of the three words.", "세 가지 중 하나를 톡 골라 줘!")
      : state.question ? t("Your turn!", "이제 네 차례야!") : t("Story complete", "이야기 끝"));
    syncControls();
    narrate();
  }

  function receive(state) {
    if (!valid(state)) throw new Error("Invalid story state");
    if (typeof Narration !== "undefined" && ui.readAloud.checked)
      Narration.prefetch?.(state.question ? [...state.lines, {speakerId: "narrator", text: state.question.text}] : state.lines,
        {language: state.language});
    const translationOnly = state.diagnostics?.languageChanged === true
      && displayed?.sessionId === state.sessionId && displayed?.sceneId === state.sceneId;
    snapshot = state;
    activity = "idle";
    if (!translationOnly && state.mediaPlan && ["accept", "complete"].includes(state.decision)) {
      motion?.stop();
      pending = state;
      ui.loading.hidden = false;
      ui.retryMedia.hidden = true;
      ui.loadingText.textContent = t("Drawing your next page…", "다음 그림을 그리고 있어요…");
      say(t("The story will continue when the picture is ready.", "그림이 완성되면 이야기가 이어져요."));
      syncControls();
      media.update(state);
    } else {
      const sceneChanged = displayed?.sessionId !== state.sessionId || displayed?.sceneId !== state.sceneId;
      // A translation rereads the same picture, so its event plays again with the new words.
      if (sceneChanged || translationOnly) motion?.scene({action: translationOnly ? state.mediaPlan?.action : null,
        lines: state.lines.map(line => line.text), narrated: ui.readAloud.checked && typeof Narration !== "undefined"});
      render(state);
    }
  }

  function mediaState(result) {
    if (!pending) return;
    if (["generating", "loading"].includes(result.state)) {
      ui.retryMedia.hidden = true;
      ui.retryMedia.disabled = true;
      ui.loadingText.textContent = result.retrying
        ? t("Drawing the picture again…", "그림을 다시 만들고 있어요…")
        : t("Loading your picture…", "그림을 불러오고 있어요…");
      return;
    }
    const prepared = result.state === "prepared";
    const ready = pending.providerMode === "live"
      ? result.state === "generated" || (prepared && result.source === "prepared_choice") : prepared;
    if (ready) {
      const state = pending;
      pending = null;
      ui.loading.hidden = true;
      ui.retryMedia.hidden = true;
      const video = Boolean(result.video?.url?.startsWith("/prototype/video/"));
      // The picture moves with its narration; a reviewed clip, when registered, shows the event instead.
      motion?.scene({action: state.mediaPlan?.action, lines: state.lines.map(line => line.text), video,
        narrated: ui.readAloud.checked && typeof Narration !== "undefined"});
      render(state);
      if (video) {
        ui.storyVideo.src = result.video.url;
        ui.storyVideo.hidden = false;
        ui.storyVideo.onended = ui.storyVideo.onerror = stopVideo;
        ui.storyVideo.play().catch(stopVideo);
      }
    } else if (["failed", "fallback", "unavailable"].includes(result.state)) {
      ui.loadingText.textContent = t("The picture isn't ready yet.", "아직 그림을 완성하지 못했어요.");
      ui.retryMedia.hidden = result.retryable === false;
      ui.retryMedia.disabled = result.retryable === false;
      say(result.retryable === false
        ? t("Couldn't finish the picture. Please restart the story.", "그림을 완성하지 못했어요. 처음부터 다시 시작해 주세요.")
        : t("Try loading the picture again.", "그림 다시 불러오기를 눌러 주세요."));
      syncControls(); // A failed live generation's substitute picture keeps the next turn locked.
    }
  }

  function openChoices() {
    if (!snapshot?.question || pending) return;
    cancelInput();
    stopNarration();
    choiceLocks.add(questionKey(snapshot));
    activity = "idle";
    ui.answer.value = "";
    retryPayload = null;
    say(t("Tap one of the three words.", "세 가지 중 하나를 톡 골라 줘!"));
    syncControls();
    narrate(); // Reading the keywords never delays their touch handlers.
  }

  async function begin() {
    if (!configured) return;
    cancelWork();
    choiceLocks.clear();
    snapshot = displayed = null;
    retryPayload = null;
    ui.narrative.replaceChildren();
    ui.question.textContent = "";
    ui.choices.replaceChildren();
    ui.cover.hidden = true;
    media.reset();
    activity = "request";
    say(t("Starting story…", "동화를 시작해요…"));
    syncControls();
    const token = epoch;
    requestController = new AbortController();
    try {
      const state = await api("/api/sessions", {mode: selectedMode, language: selectedLanguage}, requestController.signal);
      if (token === epoch) receive(state);
    } catch {
      if (token === epoch) {
        activity = "idle";
        ui.cover.hidden = false;
        say(t("Couldn't start. Please try again.", "동화를 열지 못했어요. 다시 시작해 주세요."));
        syncControls();
      }
    } finally { if (token === epoch) requestController = null; }
  }

  async function answer(value, choiceId) {
    if (!canAnswer() || (choiceOnly() && !choiceId)) return;
    if (choiceId && !snapshot.question.choices.some(choice => choice.id === choiceId)) return;
    const text = String(value ?? "").trim();
    if (!text && !choiceId) return;
    cancelInput();
    stopNarration();
    stopVideo();
    const state = snapshot, token = epoch;
    const payload = retryPayload && retryPayload.answer === text && retryPayload.choiceId === choiceId
      ? retryPayload : {sessionId: state.sessionId, version: state.version, questionId: state.question.id,
        requestId: crypto.randomUUID(), answer: text, ...(choiceId ? {choiceId} : {})};
    retryPayload = payload; // A lost response can be replayed without advancing twice.
    activity = "request";
    say(t("Thinking…", "생각하고 있어요…"));
    if (!choiceId && ui.readAloud.checked && typeof Narration !== "undefined")
      Narration.interject?.(selectedLanguage);
    syncControls();
    requestController = new AbortController();
    try {
      const next = await api("/api/answer", payload, requestController.signal);
      if (token !== epoch) return;
      receive(next);
      retryPayload = null;
    } catch (error) {
      if (token !== epoch) return;
      activity = "idle";
      if (valid(error.snapshot)) {
        retryPayload = null;
        receive(error.snapshot);
      } else {
        ui.answer.value = text;
        say(t("Couldn't send. Tap the same answer to retry.", "답을 보내지 못했어요. 같은 답을 다시 눌러 주세요."));
        syncControls();
      }
    } finally { if (token === epoch) requestController = null; }
  }

  ui.send.onclick = () => answer(ui.answer.value);
  ui.answer.onkeydown = event => {
    if (event.key === "Enter") { event.preventDefault(); return answer(ui.answer.value); }
  };
  ui.mic.onclick = async () => {
    if (choiceOnly() || pending) return;
    if (activity === "recording" && recording) { recording.stop(); return; }
    if (!canAnswer()) return;
    if (selectedMode === "mock" || !config.speechAvailable || !voiceSupported()) { openChoices(); return; }
    stopNarration();
    stopVideo();
    const token = ++inputToken, generation = epoch;
    const current = () => token === inputToken && generation === epoch && !choiceOnly() && !pending;
    activity = "opening_mic";
    syncControls();
    try {
      const item = await VoiceInput.record();
      if (!current()) { item.stop(); return; }
      recording = item;
      activity = "recording";
      say(t("Listening… Tap again to finish.", "듣고 있어요. 다 말하면 한 번 더 눌러 줘."));
      syncControls();
      const clip = await item.done;
      if (!current()) return;
      recording = null;
      activity = "recognizing";
      say(t("Listening to your answer…", "네 말을 알아듣고 있어요…"));
      syncControls();
      inputController = new AbortController();
      const text = await VoiceInput.transcribe(clip, {signal: inputController.signal});
      if (!current()) return;
      inputController = null;
      activity = "idle";
      if (!text.trim()) { openChoices(); return; }
      ui.answer.value = text;
      say(t("Check your words and tap Send.", "네 말을 확인하고 답하기를 눌러 줘."));
      syncControls();
    } catch { if (current()) openChoices(); }
  };

  ui.cameraButton.onclick = async () => {
    if (!canAnswer() || choiceOnly() || selectedMode !== "live" || !config.visionAvailable || !cameraSupported()) return;
    stopNarration();
    stopVideo();
    const token = ++inputToken, generation = epoch;
    activity = "camera";
    ui.cameraPanel.hidden = false;
    ui.cameraSnap.disabled = true;
    say(t("Show one object to the camera.", "카메라에 물건 하나를 보여 줘."));
    syncControls();
    try {
      const item = await CameraInput.open(ui.cameraPreview);
      if (token !== inputToken || generation !== epoch) { item.close(); return; }
      camera = item;
      ui.cameraSnap.disabled = false;
    } catch { if (token === inputToken && generation === epoch) openChoices(); }
  };
  ui.cameraCancel.onclick = () => {
    if (activity !== "camera") return;
    cancelInput();
    activity = "idle";
    say(t("Your turn!", "이제 네 차례야!"));
    syncControls();
  };
  ui.cameraSnap.onclick = async () => {
    if (!camera || activity !== "camera" || choiceOnly() || pending) return;
    const item = camera, token = inputToken, generation = epoch;
    const current = () => token === inputToken && generation === epoch && !choiceOnly() && !pending;
    activity = "recognizing";
    ui.cameraSnap.disabled = true;
    syncControls();
    try {
      const photo = await item.snap();
      if (!current()) return;
      closeCamera();
      inputController = new AbortController();
      const name = await CameraInput.name(photo, selectedLanguage, {signal: inputController.signal});
      if (!current()) return;
      inputController = null;
      activity = "idle";
      if (!name.trim()) { openChoices(); return; }
      ui.answer.value = name;
      say(t("Check the object and tap Send.", "물건 이름을 확인하고 답하기를 눌러 줘."));
      syncControls();
    } catch { if (current()) openChoices(); }
  };

  ui.retryMedia.onclick = () => {
    if (!pending || ui.retryMedia.disabled) return;
    ui.retryMedia.hidden = true;
    ui.retryMedia.disabled = true;
    ui.loadingText.textContent = t("Loading the picture…", "그림을 다시 불러오고 있어요…");
    media.retry(pending);
  };
  ui.restart.onclick = ui.cover.onclick = begin;
  ui.settingsButton.onclick = () => {
    ui.readerSettings.hidden = !ui.readerSettings.hidden;
    ui.settingsButton.setAttribute("aria-expanded", String(!ui.readerSettings.hidden));
    if (!ui.readerSettings.hidden) return loadVoices();
    voiceListRequest++;
    voiceListLoading = false;
    syncControls();
  };
  ui.voiceSelect.onchange = () => {
    if (!ui.voiceSelect.disabled && typeof Narration !== "undefined") chooseVoice(ui.voiceSelect.value);
  };
  ui.playNarration.onclick = () => {
    if (ui.playNarration.disabled || !displayed || pending || activity !== "idle" || typeof Narration === "undefined") return;
    ui.readAloud.checked = true;
    localStorage.setItem("story-read-aloud", "1");
    if (playback === "paused") Narration.resume?.();
    else { replay++; narrate(); }
  };
  ui.pauseNarration.onclick = () => {
    if (!ui.pauseNarration.disabled && typeof Narration !== "undefined") Narration.pause?.();
  };
  if (typeof Narration !== "undefined") Narration.subscribe?.(state => {
    playback = state;
    if (state === "paused") motion?.pause(); else motion?.resume();
    syncPlayback();
  });
  ui.readAloud.checked = localStorage.getItem("story-read-aloud") !== "0";
  ui.readAloud.onchange = () => {
    localStorage.setItem("story-read-aloud", ui.readAloud.checked ? "1" : "0");
    if (!ui.readAloud.checked) { stopNarration(); motion?.start(); }
    else { replay++; narrate(); }
  };
  ui.language.onchange = async () => {
    if (!configured || activity !== "idle" || pending) { ui.language.value = selectedLanguage; return; }
    const language = ui.language.value;
    if (!snapshot) {
      selectedLanguage = language;
      localStorage.setItem("story-language", language);
      labels();
      syncControls();
      return;
    }
    cancelWork({server: false});
    const state = snapshot, token = epoch;
    activity = "request";
    syncControls();
    requestController = new AbortController();
    try {
      const next = await api("/api/language", {sessionId: state.sessionId, version: state.version, language}, requestController.signal);
      if (token !== epoch) return;
      selectedLanguage = language;
      localStorage.setItem("story-language", language);
      labels();
      receive(next);
    } catch {
      if (token !== epoch) return;
      ui.language.value = selectedLanguage;
      activity = "idle";
      say(t("Couldn't change language. Try again.", "언어를 바꾸지 못했어요. 다시 시도해 주세요."));
      syncControls();
    } finally { if (token === epoch) requestController = null; }
  };
  ui.mode.onchange = () => {
    if (!configured || activity !== "idle" || pending) { ui.mode.value = selectedMode; return; }
    if (ui.mode.value === "live" && !config.liveAvailable) {
      ui.mode.value = selectedMode;
      say(t("AI version is unavailable. Choose the offline version.", "AI 연결을 확인해 주세요. 오프라인 버전으로 읽을 수 있어요."));
      return;
    }
    selectedMode = ui.mode.value;
    if (snapshot) return begin();
    syncControls();
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    stopNarration();
    if (["opening_mic", "recording", "recognizing", "camera"].includes(activity)) {
      cancelInput();
      activity = "idle";
      syncControls();
    }
  });
  window.addEventListener("pagehide", () => cancelWork());
  window.addEventListener("focus", () => { reader(); voiceOptions(); if (!ui.readerSettings.hidden) loadVoices(); });
  labels();
  syncControls();
  if (typeof Narration !== "undefined") Narration.warm?.(selectedLanguage);
  api("/api/config").then(data => {
    config = data;
    media.configure(data);
  }).catch(() => {
    say(t("Check the story server connection.", "동화 서버 연결을 확인해 주세요."));
  }).finally(() => {
    configured = true;
    syncControls();
  });
})();
