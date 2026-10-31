/* Child reader: server-owned story state, shared input, narration and image modules. */
(() => {
  "use strict";
  const ids = ["book", "cover", "startLabel", "storyTitle", "readBy", "language", "mode",
    "languageLabel", "modeLabel", "settingsButton", "readerSettings", "readerName", "changeVoice",
    "readAloud", "readAloudLabel", "imgCur", "imgNext", "storyVideo", "narrative", "question",
    "freeInput", "inputActions", "answer", "send", "mic", "cameraButton", "cameraPanel",
    "cameraPreview", "cameraSnap", "cameraCancel", "status", "choices", "progress", "restart",
    "loading", "loadingText", "retryMedia", "addVoice", "voiceSelect", "voiceSelectLabel", "voiceSelectStatus",
    "narrationControls", "playNarration", "pauseNarration", "narrationStatus",
    "pageNavigation", "previousPage", "nextPage", "pictureNotice"];
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
  let pages = [], pageIndex = -1, displayedImage = "img/intro.jpg", latestDraft = "";
  let advancePayload = null;
  let scenePreparation = null, preparedPassage = null, stagedPicture = null, pictureSerial = 0;
  let cueCover = null, cueCoverTimer = null;
  let playback = typeof Narration !== "undefined" ? Narration.playbackState?.() || "idle" : "idle";
  ui.language.value = selectedLanguage;
  ui.mode.value = selectedMode;

  const picture = new StoryImageTransition(ui.imgCur, ui.imgNext);
  // Decode the next picture while the full passage is voiced, but keep the
  // current bitmap visible until that passage is ready to play in one piece.
  const stagedTransition = {
    get current() { return picture.current; }, get next() { return picture.next; },
    cancel() { pictureSerial++; stagedPicture = null; picture.cancel(); },
    show(url, options = {}) {
      const preparation = scenePreparation;
      if (!preparation) return picture.show(url, options);
      const staged = {serial: ++pictureSerial, preparation, ready: false, revealed: false, reveal: null};
      stagedPicture = staged;
      const live = () => staged.serial === pictureSerial;
      staged.reveal = () => {
        if (!live() || !staged.ready || staged.revealed || !preparation.audioReady) return;
        if (preparation.key !== passageKey(preparation.state)) return narrationFailed(preparation);
        staged.revealed = true;
        stageCueCover(preparation.state);
        stagedPicture = null;
        if (typeof picture.reveal === "function") picture.reveal(options.onComplete);
        else picture.show(url, options);
      };
      if (typeof picture.prepare === "function") picture.prepare(url, {
        onReady: () => { if (live()) { staged.ready = true; staged.reveal(); } },
        onError: () => { if (live()) options.onError?.(); }
      });
      else { staged.ready = true; staged.reveal(); }
    }
  };
  const media = new StoryMediaPlayer(ui.imgCur, ui.imgNext, {onState: mediaState, transition: stagedTransition});
  const motion = typeof StoryMotion !== "undefined" ? new StoryMotion(ui.imgCur.parentElement) : null;
  const choiceOnly = (state = snapshot) => Boolean(state?.question &&
    (state.choiceMode || choiceLocks.has(questionKey(state))));
  const reviewing = () => pageIndex >= 0 && pageIndex < pages.length - 1;
  const canAnswer = () => configured && activity === "idle" && !pending && !cueCover
    && displayed === snapshot && Boolean(snapshot?.question);
  const voiceSupported = () => typeof VoiceInput !== "undefined" && VoiceInput.supported();
  const cameraSupported = () => typeof CameraInput !== "undefined" && CameraInput.supported();

  function syncControls() {
    const locked = !canAnswer();
    const visible = displayed || snapshot;
    const choices = !reviewing() && choiceOnly(visible);
    ui.freeInput.hidden = !visible?.question || choices || reviewing();
    ui.inputActions.hidden = !visible?.question || choices || reviewing();
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
    ui.language.disabled ||= reviewing();
    ui.cover.disabled = !configured || activity !== "idle" || Boolean(pending);
    ui.restart.disabled = !configured;
    ui.book.setAttribute("aria-busy", String(Boolean(pending) || ["request", "navigation"].includes(activity)));
    ui.book.dataset.state = !snapshot ? "COVER" : pending ? scenePreparation && !scenePreparation.audioReady ? "VOICING" : "DRAWING"
      : activity === "recording" ? "LISTENING" : snapshot.question ? "ASKING" : "COMPLETE";
    ui.voiceSelect.disabled = !configured || voiceListLoading || activity !== "idle" || Boolean(pending);
    ui.previousPage.disabled = !configured || (!pending && pageIndex <= 0);
    ui.nextPage.disabled = !configured || (Boolean(snapshot) && !pending && !reviewing() && !snapshot.question);
    syncPlayback();
  }

  function syncPlayback() {
    const available = configured && Boolean(displayed) && !pending && activity === "idle";
    ui.playNarration.disabled = !available || ["playing", "loading"].includes(playback);
    ui.pauseNarration.disabled = !available || !["playing", "loading"].includes(playback);
    ui.playNarration.textContent = playback === "paused" ? t("▶ Resume", "▶ 이어 듣기") : t("▶ Play", "▶ 재생");
    ui.pauseNarration.textContent = t("Ⅱ Pause", "Ⅱ 일시정지");
    const browserVoice = typeof Narration !== "undefined" && Narration.voiceSource?.() === "browser";
    ui.narrationStatus.textContent = scenePreparation && !scenePreparation.audioReady
      ? t("Preparing the whole page's voice…", "장면 전체의 목소리를 준비하고 있어요…")
      : !displayed ? "" : playback === "paused" ? t("Paused", "일시정지했어요")
      : playback === "loading" ? t("Preparing narration…", "낭독을 준비하고 있어요…")
      : playback === "playing" ? browserVoice ? t("Reading with the browser voice", "기본 음성으로 읽는 중")
        : t("Reading aloud", "소리 내어 읽는 중")
      : t("Tap Play to hear this page", "재생을 누르면 이 장면을 읽어 줘요");
  }

  function stopNarration() {
    spokenKey = null;
    if (typeof Narration !== "undefined") Narration.stop();
    motion?.pause();
    highlight(-1);
  }

  function stopVideo() {
    ui.storyVideo.pause();
    ui.storyVideo.removeAttribute("src");
    ui.storyVideo.load();
    ui.storyVideo.hidden = true;
  }

  function playCuedVideo() {
    if (!ui.storyVideo.src || !ui.storyVideo.hidden) return;
    ui.storyVideo.hidden = false;
    ui.storyVideo.play().catch(stopVideo);
  }

  function clearCueCover() {
    clearTimeout(cueCoverTimer);
    cueCoverTimer = null;
    cueCover?.remove();
    cueCover = null;
  }

  function revealCueCover() {
    if (!cueCover || cueCover.classList.contains("is-revealing")) return;
    cueCover.classList.add("is-revealing");
    cueCoverTimer = setTimeout(() => { clearCueCover(); syncControls(); }, 280);
  }

  function stageCueCover(state) {
    clearCueCover();
    if (!motion || !ui.readAloud.checked ||
        !["blown_away", "collapsed", "eaten", "melted", "stood"].includes(state.mediaPlan?.action) ||
        displayed?.storyState?.houseIndex !== state.storyState?.houseIndex ||
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const previous = picture.current?.getAttribute("src");
    if (!previous) return;
    const cover = document.createElement("img");
    cover.className = "story-cue-cover";
    cover.src = previous;
    cover.alt = "";
    cover.setAttribute("aria-hidden", "true");
    ui.imgCur.parentElement.append(cover);
    cueCover = cover;
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
    clearCueCover();
    if (scenePreparation) {
      scenePreparation.cancelled = true;
      clearTimeout(scenePreparation.timer);
      scenePreparation.controller?.abort();
      scenePreparation = null;
    }
    preparedPassage = null;
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
    ui.pageNavigation.setAttribute("aria-label", t("Page navigation", "장면 이동"));
    for (const [button, label] of [[ui.previousPage, t("Previous page", "이전 장면")],
      [ui.nextPage, t("Next page", "다음 장면")]]) {
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
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
    if (displayed && !pending && activity === "idle" && ui.readAloud.checked) {
      replay++;
      preparePresentation(displayed, {remember: false, image: displayedImage});
    }
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

  function passageLines(state) {
    return state.question ? [...state.lines, {speakerId: "narrator", text: state.question.text,
      kind: "narration", tone: "curious", emotion: "curious"}] : state.lines;
  }

  function passageKey(state) {
    return JSON.stringify([state.sessionId, state.sceneId, state.version, state.language,
      typeof Narration === "undefined" ? null : Narration.voiceId?.() || null,
      localStorage.getItem("story-voice-all"), passageLines(state)]);
  }

  function preparationLive(preparation) {
    return scenePreparation === preparation && preparation.epoch === epoch && !preparation.cancelled
      && preparation.key === passageKey(preparation.state);
  }

  function finishPresentation(preparation) {
    if (scenePreparation === preparation && preparation.epoch === epoch && !preparation.cancelled
        && preparation.key !== passageKey(preparation.state)) return narrationFailed(preparation);
    if (!preparationLive(preparation) || !preparation.audioReady || (preparation.waitForImage && !preparation.imageReady)) return;
    clearTimeout(preparation.timer);
    scenePreparation = null;
    pending = null;
    ui.loading.hidden = true;
    ui.retryMedia.hidden = true;
    preparedPassage = preparation.asset ? {key: preparation.key, asset: preparation.asset} : null;
    displayedImage = preparation.image;
    const video = Boolean(preparation.video?.url?.startsWith("/prototype/video/"));
    if (preparation.image) motion?.scene({action: preparation.state.mediaPlan?.action,
      lines: preparation.state.lines.map(line => line.text), video,
      narrated: ui.readAloud.checked && typeof Narration !== "undefined"});
    else motion?.stop();
    render(preparation.state, {remember: preparation.remember});
    preparation.after?.();
    if (video) {
      ui.storyVideo.src = preparation.video.url;
      ui.storyVideo.hidden = true;
      ui.storyVideo.onended = ui.storyVideo.onerror = stopVideo;
      if (!ui.readAloud.checked) playCuedVideo();
    }
  }

  function narrationReady(preparation, asset) {
    if (scenePreparation !== preparation || preparation.epoch !== epoch || preparation.cancelled) return;
    if (preparation.key !== passageKey(preparation.state)) return narrationFailed(preparation);
    if (!asset) return narrationFailed(preparation);
    clearTimeout(preparation.timer);
    preparation.asset = asset;
    preparation.audioReady = true;
    preparation.failed = false;
    if (stagedPicture?.preparation === preparation) stagedPicture.reveal();
    if (!preparation.waitForImage) finishPresentation(preparation);
    else if (preparation.imageFailure) mediaState(preparation.imageFailure);
    else {
      ui.loadingText.textContent = t("Loading your picture…", "그림을 불러오고 있어요…");
      syncControls();
    }
  }

  function narrationFailed(preparation) {
    if (scenePreparation !== preparation || preparation.epoch !== epoch || preparation.cancelled) return;
    const currentKey = passageKey(preparation.state);
    if (preparation.key !== currentKey) {
      preparation.key = currentKey;
      preparation.audioReady = false;
      preparation.asset = null;
    } else if (preparation.audioReady) return;
    clearTimeout(preparation.timer);
    preparation.failed = true;
    preparation.controller?.abort();
    ui.loading.hidden = false;
    ui.loadingText.textContent = t("The whole page's voice isn't ready yet.", "장면 전체의 목소리를 아직 준비하지 못했어요.");
    ui.retryMedia.textContent = t("Prepare voice again", "목소리 다시 준비하기");
    ui.retryMedia.hidden = false;
    ui.retryMedia.disabled = false;
    say(t("Retry the voice, or turn off Read aloud in settings to continue without sound.",
      "목소리를 다시 준비하거나, 낭독 설정에서 소리 내어 읽기를 끄면 소리 없이 이어갈 수 있어요."));
    syncControls();
  }

  function prepareAudio(preparation, {retry = false} = {}) {
    preparation.controller?.abort();
    preparation.controller = new AbortController();
    preparation.failed = false;
    const attempt = ++preparation.attempt;
    ui.retryMedia.hidden = true;
    ui.retryMedia.disabled = true;
    ui.loadingText.textContent = t("Preparing every voice for this page…", "이 장면의 목소리를 모두 준비하고 있어요…");
    say(t("The next page opens when its whole narration is ready.", "장면의 낭독이 모두 준비되면 다음 장면이 열려요."));
    preparation.timer = setTimeout(() => narrationFailed(preparation), 180000);
    try {
      const options = {language: preparation.state.language, signal: preparation.controller.signal,
        key: preparation.key, retry, onProgress: ({ready, total}) => {
          if (!preparationLive(preparation) || preparation.failed || preparation.audioReady
              || attempt !== preparation.attempt || !Number.isInteger(ready) || !Number.isInteger(total)
              || total < 1 || ready < 0 || ready > total) return;
          ui.loadingText.textContent = t(`Preparing page voices (${ready}/${total})…`,
            `이 장면의 목소리를 준비하고 있어요 (${ready}/${total})…`);
        }};
      const operation = (!retry && Narration.getPreparedScene?.(passageLines(preparation.state), options))
        || Narration.prepareScene(passageLines(preparation.state), options);
      if (!operation?.then) narrationReady(preparation, operation);
      else operation.then(asset => {
        if (attempt === preparation.attempt && !preparation.failed) narrationReady(preparation, asset);
      }, () => { if (attempt === preparation.attempt) narrationFailed(preparation); });
    } catch { narrationFailed(preparation); }
    syncControls();
  }

  function preparePresentation(state, {remember = true, image = displayedImage, waitForImage = false,
    after = null, deferAudio = false} = {}) {
    if (scenePreparation) {
      scenePreparation.cancelled = true;
      clearTimeout(scenePreparation.timer);
      scenePreparation.controller?.abort();
    }
    stopNarration();
    const preparation = {state, remember, image, waitForImage, after, epoch, key: passageKey(state),
      audioReady: !ui.readAloud.checked || typeof Narration === "undefined" || !Narration.prepareScene,
      imageReady: !waitForImage, asset: null, failed: false, attempt: 0, cancelled: false};
    scenePreparation = preparation;
    preparedPassage = null;
    pending = state;
    ui.loading.hidden = false;
    ui.retryMedia.hidden = true;
    if (preparation.audioReady) finishPresentation(preparation);
    else if (!deferAudio) prepareAudio(preparation);
    syncControls();
    return preparation;
  }

  function narrate() {
    if (!displayed || pending || !ui.readAloud.checked || typeof Narration === "undefined") return;
    const state = displayed;
    const choices = !reviewing() && choiceOnly(state);
    const key = `${choices ? 'choices:' : ''}${state.sessionId}:${state.version}:${state.language}:${replay}`;
    if (spokenKey === key) return;
    spokenKey = key;
    const lines = choices ? [
      {speakerId: "narrator", text: t("Tap one of these three words.", "세 가지 중 하나를 톡 골라 줘!")},
      ...state.question.choices.map(choice => ({speakerId: "narrator", text: choice.label}))
    ] : passageLines(state);
    const prepared = choices ? null : Narration.getPreparedScene
      ? Narration.getPreparedScene(lines, {language: state.language})
      : preparedPassage?.key === passageKey(state) ? preparedPassage.asset : null;
    if (!choices && Narration.prepareScene && !prepared) {
      spokenKey = null;
      preparePresentation(state, {remember: false, image: displayedImage});
      return;
    }
    Promise.resolve(Narration.speak(lines, {key, language: state.language, ...(!choices ? {scene: true, prepared} : {}),
      onLine: index => { if (spokenKey === key && !pending) highlight(choices ? -1 : index); },
      onSentence: (index, sentence) => {
        if (spokenKey !== key || pending || choices) return;
        if (motion?.cue(index, key, sentence)) { revealCueCover(); playCuedVideo(); }
      }})).catch(() => {
      if (choices || spokenKey !== key || displayed !== state || pending) return;
      const preparation = preparePresentation(state, {remember: false, image: displayedImage, deferAudio: true});
      narrationFailed(preparation);
    }).finally(() => { if (spokenKey === key && !pending) { revealCueCover(); playCuedVideo(); } });
  }

  function rememberPage(state, image) {
    const page = {state, image};
    const last = pages.at(-1)?.state;
    if (last?.sessionId === state.sessionId && last.sceneId === state.sceneId) pages[pages.length - 1] = page;
    else pages.push(page);
  }

  function pictureVisibility() {
    ui.imgCur.hidden = ui.imgNext.hidden = !displayedImage;
    ui.pictureNotice.hidden = Boolean(displayedImage);
    ui.pictureNotice.textContent = t("Picture skipped. You can keep reading.", "그림을 건너뛰었어요. 이야기는 계속 읽을 수 있어요.");
  }

  function render(state, {remember = true} = {}) {
    displayed = state;
    if (remember) { rememberPage(state, displayedImage); pageIndex = pages.length - 1; }
    pictureVisibility();
    if (state.choiceMode) choiceLocks.add(questionKey(state));
    ui.cover.hidden = true;
    ui.narrative.replaceChildren(...state.lines.map(line => {
      const paragraph = document.createElement("p");
      if (line.speakerId && line.speakerId !== "narrator") {
        const names = state.language === "ko"
          ? {pig1: "첫째 돼지", pig2: "둘째 돼지", pig3: "막내 돼지", wolf: "늑대"}
          : {pig1: "Oldest pig", pig2: "Middle pig", pig3: "Youngest pig", wolf: "Wolf"};
        const speaker = document.createElement("span");
        speaker.className = "line-speaker";
        speaker.textContent = (names[line.speakerId] || line.speakerId) + ": ";
        const words = document.createElement("span");
        words.textContent = `“${line.text}”`;
        paragraph.replaceChildren(speaker, words);
      } else paragraph.textContent = line.text;
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
    say(reviewing() ? t("An earlier page. Tap ▶ to return to your question.", "앞에서 읽은 장면이에요. ▶를 눌러 질문으로 돌아가요.")
      : choiceOnly() ? t("Tap one of the three words.", "세 가지 중 하나를 톡 골라 줘!")
      : state.question ? t("Your turn!", "이제 네 차례야!") : t("Story complete", "이야기 끝"));
    syncControls();
    narrate();
  }

  function receive(state) {
    if (!valid(state)) throw new Error("Invalid story state");
    const translationOnly = state.diagnostics?.languageChanged === true
      && displayed?.sessionId === state.sessionId && displayed?.sceneId === state.sceneId;
    snapshot = state;
    activity = "idle";
    // A recovery choice belongs to the same question, rather than a new page.
    // Its touch handlers must work immediately even while voice generation is slow.
    if (!state.mediaPlan && state.question && choiceOnly(state) && questionKey(displayed) === questionKey(state)) {
      if (scenePreparation) {
        scenePreparation.cancelled = true;
        clearTimeout(scenePreparation.timer);
        scenePreparation.controller?.abort();
        scenePreparation = null;
      }
      stopNarration();
      pending = null;
      preparedPassage = null;
      ui.loading.hidden = ui.retryMedia.hidden = true;
      render(state);
      return;
    }
    if (state.diagnostics?.manualNavigation?.skippedPicture) {
      preparePresentation(state, {image: null, after: () => say(ui.pictureNotice.textContent)});
      return;
    }
    if (!translationOnly && state.mediaPlan && ["accept", "complete"].includes(state.decision)) {
      preparePresentation(state, {waitForImage: true});
      if (scenePreparation?.audioReady) {
        ui.loadingText.textContent = t("Drawing your next page…", "다음 그림을 그리고 있어요…");
        say(t("The story will continue when the picture is ready.", "그림이 완성되면 이야기가 이어져요."));
      }
      syncControls();
      media.update(state);
    } else preparePresentation(state);
  }

  function mediaState(result) {
    if (!pending) return;
    if (["generating", "loading"].includes(result.state)) {
      if (scenePreparation && !scenePreparation.audioReady) return;
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
      const preparation = scenePreparation;
      if (!preparation) return;
      preparation.imageReady = true;
      preparation.image = result.image?.url || displayedImage;
      preparation.video = result.video;
      finishPresentation(preparation);
    } else if (["failed", "fallback", "unavailable"].includes(result.state)) {
      if (scenePreparation) {
        scenePreparation.imageFailure = result;
        if (!scenePreparation.audioReady) return;
      }
      ui.retryMedia.textContent = t("Reload picture", "그림 다시 불러오기");
      ui.loadingText.textContent = t("The picture isn't ready yet.", "아직 그림을 완성하지 못했어요.");
      ui.retryMedia.hidden = result.retryable === false;
      ui.retryMedia.disabled = result.retryable === false;
      say(result.retryable === false
        ? t("Couldn't finish the picture. Tap ▶ to keep reading.", "그림을 완성하지 못했어요. ▶를 누르면 계속 읽을 수 있어요.")
        : t("Reload the picture, or tap ▶ to keep reading.", "그림을 다시 불러오거나 ▶를 눌러 계속 읽을 수 있어요."));
      syncControls(); // A failed live generation's substitute picture keeps the next turn locked.
    }
  }

  function openChoices() {
    if (!snapshot?.question || displayed !== snapshot || pending || reviewing()) return;
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
    pages = [];
    pageIndex = -1;
    displayedImage = "img/intro.jpg";
    pictureVisibility();
    advancePayload = null;
    latestDraft = "";
    ui.language.value = selectedLanguage;
    labels();
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

  function showPage(target) {
    if (target < 0 || target >= pages.length) return;
    cancelWork({server: Boolean(pending)});
    const token = epoch, page = pages[target];
    pageIndex = target;
    ui.language.value = page.state.language;
    labels();
    preparePresentation(page.state, {remember: false, image: null, after: () => {
      if (!reviewing()) ui.answer.value = latestDraft;
      if (!page.image) say(ui.pictureNotice.textContent);
      else ui.pictureNotice.textContent = t("Loading this picture. You can still turn the page.", "그림을 불러오고 있어요. 기다리지 않고 넘길 수 있어요.");
    }});
    if (!page.image) return;
    media.picture.show(page.image, {
      onComplete: () => {
        if (token !== epoch) return;
        media.describePicture();
        displayedImage = page.image;
        pictureVisibility();
      },
      onError: () => {
        if (token !== epoch) return;
        pictureVisibility();
        say(t("Couldn't load this picture. You can keep reading.", "그림을 불러오지 못했어요. 이야기는 계속 읽을 수 있어요."));
      }
    });
  }

  ui.previousPage.onclick = () => {
    if (ui.previousPage.disabled) return;
    if (pending) {
      rememberPage(pending, null);
      latestDraft = "";
      showPage(pages.length - 2);
    } else {
      if (!reviewing()) latestDraft = ui.answer.value;
      showPage(pageIndex - 1);
    }
  };
  ui.nextPage.onclick = () => {
    if (ui.nextPage.disabled) return;
    if (!snapshot) return begin();
    if (pending) {
      rememberPage(pending, null);
      latestDraft = "";
      return showPage(pages.length - 1);
    }
    if (reviewing()) return showPage(pageIndex + 1);
    return advancePage();
  };

  async function advancePage() {
    const state = snapshot;
    cancelWork();
    retryPayload = null;
    const token = epoch;
    if (!advancePayload || advancePayload.sessionId !== state.sessionId || advancePayload.version !== state.version)
      advancePayload = {sessionId: state.sessionId, version: state.version, requestId: crypto.randomUUID()};
    activity = "request";
    say(t("Turning the page…", "다음 장면으로 넘어가요…"));
    syncControls();
    requestController = new AbortController();
    try {
      const next = await api("/api/advance", advancePayload, requestController.signal);
      if (token !== epoch) return;
      if (!valid(next)) throw new Error("Invalid story state");
      snapshot = next;
      const choice = next.diagnostics?.manualNavigation?.defaultChoice;
      preparePresentation(next, {image: null, after: () => {
        say(choice ? t(`Continuing with “${choice}”. Picture skipped.`, `“${choice}”로 이어가요. 그림은 건너뛰었어요.`)
          : ui.pictureNotice.textContent);
      }});
      advancePayload = null;
    } catch (error) {
      if (token !== epoch) return;
      if (valid(error.snapshot)) {
        snapshot = error.snapshot;
        preparePresentation(snapshot, {image: null});
      } else {
        activity = "idle";
        say(t("Couldn't turn the page. Tap ▶ to retry.", "장면을 넘기지 못했어요. ▶를 다시 눌러 주세요."));
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
    if (scenePreparation?.failed) return prepareAudio(scenePreparation, {retry: true});
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
    else { replay++; preparePresentation(displayed, {remember: false, image: displayedImage}); }
  };
  ui.pauseNarration.onclick = () => {
    if (!ui.pauseNarration.disabled && typeof Narration !== "undefined") Narration.pause?.();
  };
  if (typeof Narration !== "undefined") Narration.subscribe?.(state => {
    const wasPaused = playback === "paused";
    playback = state;
    if (state === "paused") { motion?.pause(); ui.storyVideo.pause(); }
    else if (state === "playing" && wasPaused) {
      motion?.resume();
      if (!ui.storyVideo.hidden) ui.storyVideo.play().catch(stopVideo);
    }
    syncPlayback();
  });
  ui.readAloud.checked = localStorage.getItem("story-read-aloud") !== "0";
  ui.readAloud.onchange = () => {
    localStorage.setItem("story-read-aloud", ui.readAloud.checked ? "1" : "0");
    if (!ui.readAloud.checked) {
      stopNarration();
      revealCueCover();
      motion?.start();
      playCuedVideo();
      const preparation = scenePreparation;
      if (preparation) {
        preparation.attempt++;
        clearTimeout(preparation.timer);
        preparation.controller?.abort();
        preparation.audioReady = true;
        preparation.failed = false;
        preparation.asset = null;
        if (stagedPicture?.preparation === preparation) stagedPicture.reveal();
        if (!preparation.waitForImage) finishPresentation(preparation);
        else if (preparation.imageFailure) mediaState(preparation.imageFailure);
        else syncControls();
      }
    } else if (displayed && !pending) {
      replay++;
      preparePresentation(displayed, {remember: false, image: displayedImage});
    }
  };
  ui.language.onchange = async () => {
    if (!configured || activity !== "idle" || pending || reviewing()) {
      ui.language.value = displayed?.language || selectedLanguage;
      return;
    }
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
    if (scenePreparation && !scenePreparation.audioReady) narrationFailed(scenePreparation);
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
