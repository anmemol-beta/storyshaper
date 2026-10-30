/* Text-only agent test surface. All story data is rendered as text, never HTML. */
(() => {
  "use strict";

  const t = AgentLanguage.text;
  const languageButtons = [...document.querySelectorAll("[data-language]")];
  const historyEntries = [];
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries([
    "mode", "modeBadge", "configNote", "startButton", "connectionError",
    "connectionErrorText", "reconnectButton", "refreshConfig", "storyCard", "decisionBadge",
    "narrative", "questionTitle", "questionLabel", "questionIntent", "answerForm",
    "startPanel", "startStoryButton", "questionPanel", "attemptNote",
    "answer", "micButton", "cameraButton", "cameraPanel", "cameraVideo", "cameraShot", "snapButton", "cameraCancel",
    "sendButton", "choicePanel", "choices", "requestStatus", "requestError",
    "requestErrorText", "retryButton", "sceneValue", "versionValue", "attemptsValue",
    "inputModeValue", "reasonValue", "stateJson", "mediaJson", "diagnosticsJson",
    "history", "historyEmpty", "historyCount", "mediaNotice"
  ].map(id => [id, byId(id)]));

  const decisions = {
    ready: "Ready", accept: "Accepted", clarify: "Clarification", redirect: "Try again",
    service_error: "Service issue", complete: "Story complete"
  };
  let config = null;
  let connectionFailure = null;
  let snapshot = null;
  let busy = false;
  let epoch = 0;
  let controller = null;
  let retryRequest = null;
  let turnCount = 0;
  // Push-to-talk (voice-input.js). Absent outside a browser, and hidden until the server can transcribe.
  const voice = typeof VoiceInput === "undefined" ? null : VoiceInput;
  let recording = null;
  const voiceReady = () => Boolean(voice?.supported() && config?.speechAvailable);
  // Show-it answers (camera-input.js): the child holds the material up and the camera names it.
  const camera = typeof CameraInput === "undefined" ? null : CameraInput;
  let cameraSession = null;
  let cameraShotUrl = null;
  const cameraReady = () => Boolean(camera?.supported() && config?.visionAvailable);
  // The server allows three missed tries on a question before offering three choices (roadmap §4).
  const MAX_TRIES = 3;
  const reasonText = {
    unclear_answer: "the story could not use that answer",
    material_not_allowed: "that material is not one the pig can use here",
    unsupported_material: "a safe story branch for that material is not available yet",
    outside_story_rules: "it does not fit this part of the story",
    instruction_override: "it tries to change the story's rules",
    unsafe_request: "it is not safe for this story",
    private_information: "it contains private information",
    fixed_story_change: "it would change a fixed event of the story"
  };
  // A live turn takes 15-30 s; the button counts the seconds so the page never looks stuck.
  let clock = null;
  function startClock() {
    const started = Date.now();
    const tick = () => {
      ui.sendButton.textContent = t("Thinking… {seconds}s", {seconds: Math.round((Date.now() - started) / 1000)});
      clock = setTimeout(tick, 1000);
    };
    tick();
  }
  function stopClock() {
    clearTimeout(clock);
    clock = null;
    ui.sendButton.textContent = t("Continue story →");
  }
  function showAttemptNote(answer, result) {
    const used = result.decision !== "clarify" && result.decision !== "redirect";
    ui.attemptNote.hidden = used;
    if (used) return;
    const why = t(reasonText[result.reason] || result.reason);
    const shown = answer || t("(nothing heard)");
    ui.attemptNote.textContent = result.choiceMode
      ? t("“{answer}” was not used: {why}. Pick one of the three choices, or try another answer.", {answer: shown, why})
      : t("“{answer}” was not used: {why}. {left} more tries, then three choices appear.",
        {answer: shown, why, left: Math.max(0, MAX_TRIES - result.attempts)});
  }
  const decisionLabel = decision => t(decisions[decision] || decision);
  const errorMessage = error => AgentLanguage.language === "ko"
    ? (error.code ? t(error.code) : t("Could not connect to the local server. Please check the server and try again."))
    : error.message;

  function setBusy(value, message = "") {
    busy = value;
    ui.storyCard.setAttribute("aria-busy", String(value));
    ui.requestStatus.textContent = message;
    ui.mode.disabled = value || !config;
    // Restart can interrupt an answer; its generation token rejects the old result.
    ui.startButton.disabled = !config;
    ui.startButton.textContent = snapshot ? t("Start over") : t("Start session");
    const canAnswer = Boolean(snapshot?.question) && !value;
    // Before a session there is nothing to answer, so the answer box is hidden, not shown disabled.
    ui.startPanel.hidden = Boolean(snapshot);
    ui.questionPanel.hidden = !snapshot;
    ui.answerForm.hidden = !snapshot;
    ui.startStoryButton.disabled = !config || value;
    ui.answer.disabled = !canAnswer;
    ui.sendButton.disabled = !canAnswer || !ui.answer.value.trim();
    ui.micButton.hidden = !voiceReady();
    ui.micButton.disabled = (!canAnswer && !recording) || Boolean(cameraSession);
    ui.cameraButton.hidden = !cameraReady();
    ui.cameraButton.disabled = !canAnswer || Boolean(recording) || Boolean(cameraSession);
    ui.snapButton.disabled = value;
    ui.cameraCancel.disabled = value;
    ui.micButton.textContent = recording ? t("Stop and transcribe") : t("Speak an answer");
    ui.micButton.setAttribute("aria-pressed", String(Boolean(recording)));
    ui.choices.querySelectorAll("button").forEach(button => { button.disabled = !canAnswer; });
    ui.retryButton.disabled = value;
    ui.refreshConfig.disabled = value;
    languageButtons.forEach(button => { button.disabled = value; });
  }

  function clearRequestError() {
    ui.requestError.hidden = true;
    ui.requestErrorText.textContent = "";
    ui.retryButton.hidden = true;
    retryRequest = null;
  }

  function showRequestError(message, request = null) {
    ui.requestErrorText.textContent = message;
    ui.requestError.hidden = false;
    retryRequest = request;
    ui.retryButton.hidden = !request;
    ui.retryButton.textContent = request?.fresh ? t("Try generation again") : t("Retry this request");
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      cache: "no-store"
    });
    let body;
    try { body = await response.json(); }
    catch { throw new Error(t("The server returned an unreadable response. Check that the agent server is running.")); }
    if (!response.ok) {
      const error = new Error(body.error?.message || t("The request failed ({status}).", {status: response.status}));
      error.status = response.status;
      error.code = body.error?.code;
      error.snapshot = body.snapshot;
      throw error;
    }
    return body;
  }

  function isSnapshot(value) {
    return Boolean(value && typeof value.sessionId === "string" && Number.isInteger(value.version)
      && Array.isArray(value.lines) && (value.question === null || typeof value.question?.id === "string"));
  }

  function modeLabel(mode) {
    return mode === "live" ? t("Live model") : t("Deterministic mock · no model call");
  }

  function renderMode() {
    if (connectionFailure) {
      ui.modeBadge.textContent = t("Server unavailable");
      return;
    }
    const mode = snapshot?.providerMode || ui.mode.value;
    const authoredFallback = snapshot?.diagnostics?.authoredFallback === true;
    ui.modeBadge.dataset.mode = authoredFallback ? "authored" : mode;
    ui.modeBadge.textContent = authoredFallback
      ? t("Authored fallback · no model call this turn")
      : modeLabel(mode);
  }

  function renderSnapshot(next) {
    if (!isSnapshot(next)) throw new Error(t("The server returned an invalid story state. Please start a new session."));
    snapshot = next;
    renderMode();
    ui.decisionBadge.textContent = decisionLabel(next.decision);
    ui.decisionBadge.dataset.decision = next.decision;
    ui.narrative.replaceChildren();
    for (const line of next.lines) {
      const paragraph = document.createElement("p");
      paragraph.className = "story-line";
      const speaker = document.createElement("span");
      speaker.className = "speaker";
      speaker.textContent = t(String(line.speakerId || "narrator")).replaceAll("_", " ");
      const words = document.createElement("span");
      words.textContent = String(line.text || "");
      paragraph.append(speaker, words);
      ui.narrative.append(paragraph);
    }
    // Read the passage and question aloud in each character's voice (narration.js); a re-render of the same version is not read again.
    if (typeof Narration !== "undefined") {
      const paragraphs = [...ui.narrative.children];
      const spoken = next.question ? [...next.lines, {speakerId: "narrator", text: next.question.text}] : next.lines;
      Narration.speak(spoken, {
        key: `${next.sessionId}:${next.version}:${AgentLanguage.language}`, language: AgentLanguage.language,
        onLine: i => paragraphs.forEach((p, k) => p.classList.toggle("speaking", k === i))
      });
    }
    ui.questionLabel.textContent = next.question ? t("Current question") : t("The end");
    ui.questionTitle.textContent = next.question?.text || t("The pigs are safe together. Thank you for shaping their story.");
    ui.questionIntent.hidden = !next.question?.intent;
    ui.questionIntent.textContent = next.question?.intent ? t("Question intent: {intent}", {intent: t(next.question.intent)}) : "";
    ui.sceneValue.textContent = next.sceneId;
    ui.versionValue.textContent = String(next.version);
    ui.attemptsValue.textContent = String(next.attempts);
    ui.inputModeValue.textContent = next.choiceMode ? t("3 choices + text") : (next.question ? t("Free text") : t("Complete"));
    ui.reasonValue.textContent = next.reason ? t(next.reason) : "—";
    ui.stateJson.textContent = JSON.stringify(next.storyState, null, 2);
    ui.mediaJson.textContent = next.mediaPlan ? JSON.stringify(next.mediaPlan, null, 2) : t("No new media handoff for this turn.");
    ui.diagnosticsJson.textContent = JSON.stringify(next.diagnostics, null, 2);
    const state = next.storyState;
    const currentHouse = state?.houses?.find(house => house.houseId === `house${state.houseIndex}`);
    ui.mediaNotice.hidden = !(currentHouse?.material === "custom" && ["predict", "reflect"].includes(state.stage));
    ui.mediaNotice.textContent = ui.mediaNotice.hidden ? "" : t("A picture for this material is not available yet. Keep reading with the reference picture.");
    ui.choices.replaceChildren();
    const choices = next.question?.choices;
    ui.choicePanel.hidden = !(next.choiceMode && Array.isArray(choices) && choices.length === 3);
    if (!ui.choicePanel.hidden) {
      choices.forEach((choice, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice-button";
        const number = document.createElement("span");
        number.className = "choice-number";
        number.textContent = String(index + 1);
        const label = document.createElement("span");
        label.textContent = choice.label;
        button.append(number, label);
        button.addEventListener("click", () => sendAnswer(choice.answer, choice.id));
        ui.choices.append(button);
      });
    }
  }

  function appendHistory(question, answer, result) {
    turnCount += 1;
    historyEntries.unshift({question, answer, result, number: turnCount});
    if (historyEntries.length > 60) historyEntries.pop();
    renderHistory();
  }

  function renderHistory() {
    ui.history.replaceChildren();
    ui.historyEmpty.hidden = historyEntries.length > 0;
    ui.historyCount.textContent = t(turnCount === 1 ? "{count} turn" : "{count} turns", {count: turnCount});
    for (const {question, answer, result, number} of historyEntries) {
      const item = document.createElement("li");
      item.className = "history-turn";
      const meta = document.createElement("div");
      meta.className = "turn-meta";
      const label = document.createElement("strong");
      label.textContent = `${t("Turn {count}", {count: number})} · ${decisionLabel(result.decision)}${result.diagnostics?.authoredFallback === true ? " · " + t("Authored fallback") : ""}`;
      const scene = document.createElement("span");
      scene.textContent = `${result.sceneId} · v${result.version}`;
      meta.append(label, scene);
      const details = document.createElement("dl");
      const entries = [
        ["Question", question], ["Answer", answer],
        ["Story", result.lines.map(line => `${t(line.speakerId)}: ${line.text}`).join("\n")],
        ["Next", result.question?.text || t("Story complete")]
      ];
      for (const [name, value] of entries) {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const definition = document.createElement("dd");
        term.textContent = t(name);
        definition.textContent = value;
        row.append(term, definition);
        details.append(row);
      }
      item.append(meta, details);
      ui.history.append(item);
    }
  }

  async function loadConfig() {
    ui.connectionError.hidden = true;
    ui.reconnectButton.disabled = true;
    ui.refreshConfig.disabled = true;
    const configController = new AbortController();
    const timeout = setTimeout(() => configController.abort(), 15000);
    try {
      const data = await api("/api/config", { signal: configController.signal });
      connectionFailure = null;
      config = { liveAvailable: data.liveAvailable === true, model: String(data.model || "configured model"),
        speechAvailable: data.speechAvailable === true, visionAvailable: data.visionAvailable === true };
      ui.mode.querySelector('[value="live"]').disabled = !config.liveAvailable;
      ui.mode.value = snapshot?.providerMode || (config.liveAvailable ? "live" : "mock");
      renderConfig();
      renderMode();
      setBusy(false);
    } catch (error) {
      config = null;
      connectionFailure = error;
      ui.modeBadge.textContent = t("Server unavailable");
      ui.configNote.textContent = t("Serve this page from the local agent server to use the lab.");
      ui.connectionErrorText.textContent = error.name === "AbortError"
        ? t("The local server did not respond in time. Check that it is running, then reconnect.")
        : errorMessage(error);
      ui.connectionError.hidden = false;
      setBusy(false);
    } finally {
      clearTimeout(timeout);
      ui.reconnectButton.disabled = false;
      ui.refreshConfig.disabled = busy;
    }
  }

  async function startSession() {
    if (!config) return;
    const token = ++epoch;
    controller?.abort();
    controller = new AbortController();
    const activeController = controller;
    const mode = ui.mode.value;
    clearRequestError();
    setBusy(true, t("Starting a fresh story…"));
    const timeout = setTimeout(() => activeController.abort(), 30000);
    try {
      const result = await api("/api/sessions", {
        method: "POST", body: JSON.stringify({ mode, language: AgentLanguage.language }), signal: activeController.signal
      });
      if (token !== epoch) return;
      renderSnapshot(result);
      closeCamera();
      ui.attemptNote.hidden = true;
      historyEntries.length = 0;
      turnCount = 0;
      renderHistory();
      ui.answer.value = "";
      setBusy(false, t("{mode}. Answer the question to begin.", {mode: modeLabel(result.providerMode)}));
      ui.questionTitle.focus({ preventScroll: true });
    } catch (error) {
      if (token !== epoch) return;
      setBusy(false);
      showRequestError(error.name === "AbortError" ? t("Starting the session took too long. Try starting again.") : errorMessage(error));
    } finally {
      clearTimeout(timeout);
      if (token === epoch) controller = null;
    }
  }

  // heardNothing: a recording with no words. It is sent as an empty answer so the server counts
  // a missed try, the same as an unclear answer (development-roadmap.md §4).
  async function sendAnswer(answer, choiceId, retainedRequest = null, {heardNothing = false} = {}) {
    if (busy || !snapshot?.question || (!String(answer).trim() && !heardNothing && !retainedRequest)) return;
    const current = snapshot;
    const payload = retainedRequest?.payload || {
      sessionId: current.sessionId, version: current.version, questionId: current.question.id,
      requestId: crypto.randomUUID(), answer: String(answer).trim(),
      ...(choiceId ? { choiceId } : {})
    };
    const questionText = retainedRequest?.questionText || current.question.text;
    const token = epoch;
    controller = new AbortController();
    const activeController = controller;
    clearRequestError();
    setBusy(true, t("Listening to your idea and checking the next part…"));
    startClock();
    // A live turn performs interpretation and composition, each with a 30s timeout.
    const timeout = setTimeout(() => activeController.abort(), 110000);
    try {
      const result = await api("/api/answer", {
        method: "POST", body: JSON.stringify(payload), signal: activeController.signal
      });
      if (token !== epoch || snapshot.sessionId !== current.sessionId) return;
      renderSnapshot(result);
      // The picture stays on screen while the story thinks, and goes once the story has answered.
      closeCamera();
      appendHistory(questionText, payload.answer || t("(nothing heard)"), result);
      showAttemptNote(payload.answer, result);
      if (result.decision === "accept" || result.decision === "complete") ui.answer.value = "";
      const readyMessage = result.decision === "complete"
        ? t("The story is complete. Start over to test another idea.")
        : t("The current story and question are ready.");
      setBusy(false, result.diagnostics?.authoredFallback === true
        ? t("An authored option was applied without a model call. {message}", {message: readyMessage})
        : readyMessage);
      if (result.decision === "service_error") {
        const recoveryMessage = result.choiceMode
          ? t("The generation service could not complete this turn. Choose one of the three authored options to continue without a model call, or retry live generation. Your retry count is preserved.")
          : t("The generation service could not complete this turn. Your question and retry count are preserved.");
        showRequestError(recoveryMessage, {
          fresh: true, payload, questionText
        });
      }
      ui.questionTitle.focus({ preventScroll: true });
    } catch (error) {
      if (token !== epoch) return;
      setBusy(false);
      if (error.status === 409 && String(error.code).toLowerCase() === "turn_in_progress") {
        if (isSnapshot(error.snapshot)) renderSnapshot(error.snapshot);
        setBusy(false);
        showRequestError(t("This answer is still being processed. Wait a moment, then retry the same request to retrieve its result."), { payload, questionText });
      } else if (isSnapshot(error.snapshot)) {
        renderSnapshot(error.snapshot);
        setBusy(false);
        showRequestError(t("{message} The current server state has been restored. Review the question and answer again.", {message: errorMessage(error)}));
      } else {
        const message = error.name === "AbortError"
          ? t("The request timed out. Retry the same request to safely retrieve its result; this does not add another attempt.")
          : t("{message} Retry this request to safely recover its result.", {message: errorMessage(error)});
        showRequestError(message, { payload, questionText });
      }
    } finally {
      stopClock();
      clearTimeout(timeout);
      if (token === epoch) controller = null;
    }
  }

  function renderConfig() {
    ui.configNote.textContent = config
      ? (config.liveAvailable
        ? t("Live model available ({model}). Mock mode runs authored, repeatable rules for testing.", {model: config.model})
        : t("Live model is unavailable. Mock mode uses authored rules, without an AI call. Add MODEL_API_KEY to the server’s ignored .env file to test the live model."))
      : t("Serve this page from the local agent server to use the lab.");
  }

  function applyLanguage(language) {
    AgentLanguage.set(language);
    renderConfig();
    renderMode();
    renderHistory();
    ui.retryButton.textContent = t(retryRequest?.fresh ? "Try generation again" : "Retry this request");
    ui.micButton.textContent = recording ? t("Stop and transcribe") : t("Speak an answer");
    ui.cameraButton.textContent = t("Show it to the camera");
    ui.snapButton.textContent = t(ui.cameraShot.hidden ? "Take the picture" : "Show something else");
    if (connectionFailure) {
      ui.connectionErrorText.textContent = connectionFailure.name === "AbortError"
        ? t("The local server did not respond in time. Check that it is running, then reconnect.")
        : errorMessage(connectionFailure);
    }
    if (!snapshot) {
      ui.decisionBadge.textContent = t("Not started");
      ui.questionLabel.textContent = t("Current question");
      ui.questionTitle.textContent = t("The story is ready when you are.");
      ui.reasonValue.textContent = t("No session yet.");
      ui.inputModeValue.textContent = t("Free text");
      ui.stateJson.textContent = t("No state yet.");
      ui.mediaJson.textContent = t("No media plan yet.");
      ui.diagnosticsJson.textContent = t("No diagnostics yet.");
    }
  }

  async function switchLanguage(language) {
    if (busy || language === AgentLanguage.language) return;
    if (!snapshot) {
      clearRequestError();
      applyLanguage(language);
      setBusy(false);
      return;
    }
    const current = snapshot;
    const token = ++epoch;
    controller?.abort();
    controller = new AbortController();
    const activeController = controller;
    clearRequestError();
    setBusy(true, t("Changing language…"));
    const timeout = setTimeout(() => activeController.abort(), 30000);
    try {
      const result = await api("/api/language", {
        method: "POST", signal: activeController.signal,
        body: JSON.stringify({sessionId: current.sessionId, version: current.version, language})
      });
      if (token !== epoch) return;
      applyLanguage(result.language || result.storyState.language);
      renderSnapshot(result);
      setBusy(false, t("Language changed. Your story progress has been preserved."));
    } catch (error) {
      if (token !== epoch) return;
      if (isSnapshot(error.snapshot)) {
        applyLanguage(error.snapshot.language || error.snapshot.storyState.language);
        renderSnapshot(error.snapshot);
      }
      setBusy(false);
      showRequestError(error.name === "AbortError"
        ? t("Language switching took too long. Try the language button again.") : errorMessage(error));
    } finally {
      clearTimeout(timeout);
      if (token === epoch) controller = null;
    }
  }

  // First press records, second press (or 8 s) stops. The text lands in the answer box so the
  // tester confirms with "Continue" or speaks again. Speech service errors never use up a try.
  async function toggleRecording() {
    if (recording) return recording.stop();
    if (busy || !snapshot?.question || !voiceReady()) return;
    // Stop the story voice so the microphone hears only the child.
    if (typeof Narration !== "undefined") Narration.stop();
    const token = epoch, questionId = snapshot.question.id;
    // Opening the microphone takes a moment. A second press meanwhile means "stop", not a second recording.
    const opening = {stopRequested: false, stop() { this.stopRequested = true; }};
    recording = opening;
    clearRequestError();
    setBusy(false, t("Listening… press the button again when you are done (8 seconds at most)."));
    let active;
    try {
      active = await voice.record();
    } catch (error) {
      recording = null;
      setBusy(false);
      showRequestError(error.name === "NotAllowedError"
        ? t("Microphone permission was refused. Type the answer or choose an option instead.")
        : t("The microphone could not start. Type the answer instead."));
      return;
    }
    recording = active;
    if (opening.stopRequested) active.stop();
    let transcript;
    try {
      const clip = await active.done;
      recording = null;
      setBusy(true, t("Turning your voice into text…"));
      transcript = await voice.transcribe(clip);
    } catch (error) {
      recording = null;
      if (token !== epoch) return;
      setBusy(false);
      showRequestError(t("{message} Your retry count is unchanged.", {message: errorMessage(error)}));
      return;
    }
    setBusy(false);
    if (token !== epoch || snapshot?.question?.id !== questionId) return;
    if (!transcript.trim()) {
      await sendAnswer("", null, null, {heardNothing: true});
      if (ui.requestError.hidden) ui.requestStatus.textContent = t("Nothing was heard. That counts as one try.");
      return;
    }
    ui.answer.value = transcript;
    setBusy(false, t("Heard: “{text}”. Continue the story, or speak again.", {text: transcript}));
    ui.sendButton.focus();
  }

  function closeCamera() {
    cameraSession?.close();
    cameraSession = null;
    if (cameraShotUrl) URL.revokeObjectURL(cameraShotUrl);
    cameraShotUrl = null;
    ui.cameraShot.removeAttribute("src");
    ui.cameraPanel.hidden = true;
  }

  // The camera only fills the answer box, like the microphone: the tester sends it with "Continue",
  // so a camera answer passes the same story checks. A frame with no clear object is not a try.
  async function openCamera() {
    if (busy || cameraSession || recording || !snapshot?.question || !cameraReady()) return;
    clearRequestError();
    closeCamera();
    ui.cameraShot.hidden = true;
    ui.cameraVideo.hidden = false;
    ui.snapButton.textContent = t("Take the picture");
    ui.cameraPanel.hidden = false;
    const opening = {close() {}};
    cameraSession = opening;
    setBusy(false, t("Opening the camera…"));
    try {
      const session = await camera.open(ui.cameraVideo);
      if (cameraSession !== opening) return session.close();
      cameraSession = session;
    } catch (error) {
      closeCamera();
      setBusy(false);
      showRequestError(error.name === "NotAllowedError"
        ? t("Camera permission was refused. Type or speak the answer instead.")
        : t("The camera could not start. Type or speak the answer instead."));
      return;
    }
    setBusy(false, t("Hold it up to the camera, then take the picture."));
    ui.snapButton.focus();
  }

  async function snapAndName() {
    if (!cameraSession?.snap) return openCamera();
    const token = epoch, questionId = snapshot.question.id;
    const blob = await cameraSession.snap();
    cameraSession = null;
    cameraShotUrl = URL.createObjectURL(blob);
    ui.cameraShot.src = cameraShotUrl;
    ui.cameraShot.hidden = false;
    ui.cameraVideo.hidden = true;
    ui.snapButton.textContent = t("Show something else");
    setBusy(true, t("Looking at the picture…"));
    let name;
    try {
      name = await camera.name(blob, AgentLanguage.language);
    } catch (error) {
      if (token !== epoch) return;
      setBusy(false);
      showRequestError(t("{message} Your retry count is unchanged.", {message: errorMessage(error)}));
      return;
    }
    setBusy(false);
    if (token !== epoch || snapshot?.question?.id !== questionId) return;
    if (!name) {
      ui.requestStatus.textContent = t("The camera could not see one thing clearly. Hold it closer and show it again. This is not counted as a try.");
      return;
    }
    ui.answer.value = name;
    setBusy(false, t("The camera saw: “{text}”. Continue the story, or show something else.", {text: name}));
    ui.sendButton.focus();
  }

  languageButtons.forEach(button => button.addEventListener("click", () => switchLanguage(button.dataset.language)));
  ui.cameraButton.addEventListener("click", openCamera);
  ui.snapButton.addEventListener("click", snapAndName);
  ui.cameraCancel.addEventListener("click", () => { closeCamera(); setBusy(false); });
  ui.micButton.addEventListener("click", toggleRecording);

  ui.startButton.addEventListener("click", startSession);
  ui.startStoryButton.addEventListener("click", startSession);
  ui.reconnectButton.addEventListener("click", loadConfig);
  ui.refreshConfig.addEventListener("click", loadConfig);
  // The selector must change the provider actually used, not just its visible label.
  ui.mode.addEventListener("change", () => snapshot ? startSession() : renderMode());
  ui.answer.addEventListener("input", () => { ui.sendButton.disabled = busy || !snapshot?.question || !ui.answer.value.trim(); });
  ui.answerForm.addEventListener("submit", event => {
    event.preventDefault();
    sendAnswer(ui.answer.value);
  });
  ui.retryButton.addEventListener("click", () => {
    if (!retryRequest) return;
    const request = retryRequest;
    sendAnswer(request.payload.answer, request.payload.choiceId, request.fresh ? null : request);
  });
  applyLanguage(AgentLanguage.language);
  setBusy(false);
  loadConfig();
})();
