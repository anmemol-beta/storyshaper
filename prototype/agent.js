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
    "answer", "sendButton", "choicePanel", "choices", "requestStatus", "requestError",
    "requestErrorText", "retryButton", "sceneValue", "versionValue", "attemptsValue",
    "inputModeValue", "reasonValue", "stateJson", "mediaJson", "diagnosticsJson",
    "history", "historyEmpty", "historyCount"
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
    ui.answer.disabled = !canAnswer;
    ui.sendButton.disabled = !canAnswer || !ui.answer.value.trim();
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
      config = { liveAvailable: data.liveAvailable === true, model: String(data.model || "configured model") };
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

  async function sendAnswer(answer, choiceId, retainedRequest = null) {
    if (busy || !snapshot?.question || !String(answer).trim()) return;
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
    // A live turn performs three sequential model calls, each with a 30s timeout.
    const timeout = setTimeout(() => activeController.abort(), 110000);
    try {
      const result = await api("/api/answer", {
        method: "POST", body: JSON.stringify(payload), signal: activeController.signal
      });
      if (token !== epoch || snapshot.sessionId !== current.sessionId) return;
      renderSnapshot(result);
      appendHistory(questionText, payload.answer, result);
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

  languageButtons.forEach(button => button.addEventListener("click", () => switchLanguage(button.dataset.language)));

  ui.startButton.addEventListener("click", startSession);
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
