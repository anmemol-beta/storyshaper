/* English source copy and Korean UI translation. Story text comes from the server. */
const AgentLanguage = (() => {
  let language = "en";
  try { if (localStorage.getItem("story-language") === "ko") language = "ko"; } catch {}
  const korean = {
    "Story agent lab · StoryShaper": "동화 에이전트 시험 · StoryShaper",
    "Skip to the current question": "현재 질문으로 이동",
    "Display language": "화면 언어",
    "Back to picture book ↗": "그림책으로 돌아가기 ↗",
    "Fixed story demo ↗": "고정 동화 데모 ↗",
    "Developer prototype · Text input": "개발용 프로토타입 · 글로 답하기",
    "Story agent lab": "동화 에이전트 시험",
    "Try an answer. See how the next scene and question follow it.": "답을 입력하고, 다음 장면과 질문이 어떻게 달라지는지 확인해 보세요.",
    "Checking connection…": "연결 확인 중…",
    "Session controls": "시험 설정",
    "Mode for the new session": "새 시험의 실행 방식",
    "Mode · changing starts a new session": "실행 방식 · 바꾸면 새로 시작",
    "Refresh connection": "연결 다시 확인",
    "Deterministic mock": "오프라인 규칙 모드",
    "Live model": "실제 AI 모델",
    "Connecting to the local agent server…": "로컬 에이전트 서버에 연결하는 중…",
    "Start session": "시험 시작",
    "Start over": "처음부터",
    "Reconnect": "다시 연결",
    "The Three Little Pigs": "아기돼지 삼형제",
    "Your version of the story": "내가 바꾸는 동화",
    "Not started": "시작 전",
    "Reference illustration of the three little pigs in a sunny woodland.": "햇살 가득한 숲속의 아기돼지 삼형제 참고 그림",
    "Original reference illustration · not generated for this answer": "기존 참고 그림 · 이번 답으로 생성한 그림이 아닙니다",
    "Current story passage": "현재 동화 내용",
    "Start a session to choose a material, explore what happens, and help the pigs find a safe home.": "시험을 시작하고 집 재료를 골라 보세요. 어떤 일이 생기는지 살펴보며 돼지들이 안전한 집을 찾도록 도와주세요.",
    "Current question": "현재 질문",
    "The story is ready when you are.": "준비가 되면 동화를 시작해 주세요.",
    "Your test answer": "시험할 답변",
    "Type your answer to the current question…": "현재 질문에 대한 답을 입력해 주세요…",
    "Text input is for testing the story agent. Voice and media generation are separate integrations.": "글 입력은 동화 에이전트를 시험하기 위한 기능입니다. 음성·이미지·영상 생성은 별도로 연결합니다.",
    "Continue story →": "이야기 이어가기 →",
    "Choose a story-safe option": "동화에 맞는 보기에서 골라 주세요",
    "Tap an option, or try another answer above.": "보기를 누르거나 위에 다른 답을 입력해 주세요.",
    "Test information": "시험 안내",
    "A fixed goal. A question that fits.": "목적은 정하고, 질문은 상황에 맞게.",
    "The learning intent and key events are authored. Question wording follows the accepted story state: a cookie wall invites a different question from a wooden wall.": "질문의 목적과 주요 사건은 미리 정합니다. 실제 질문은 확정된 동화 상황을 따릅니다. 과자 벽과 나무 벽에는 서로 다른 질문을 합니다.",
    "The agent can adapt the conversation while the server checks the permitted changes and story progression.": "에이전트가 상황에 맞게 대화하고, 서버가 변경 범위와 이야기 진행을 확인합니다.",
    "Current run": "현재 시험 상태",
    "Scene": "장면",
    "Version": "버전",
    "Question retries": "질문 재시도 횟수",
    "Input mode": "입력 방식",
    "Free text": "자유 입력",
    "3 choices + text": "보기 3개 + 자유 입력",
    "Complete": "완료",
    "No session yet.": "아직 시작하지 않았습니다.",
    "Inspect story state": "동화 상태 자세히 보기",
    "No state yet.": "아직 동화 상태가 없습니다.",
    "Inspect media handoff": "미디어 전달 데이터 보기",
    "Validated data for image, video, and narration services. This lab does not generate media.": "이미지·영상·낭독 서비스로 전달할 검증된 데이터입니다. 이 시험 화면에서는 미디어를 생성하지 않습니다.",
    "No media plan yet.": "아직 미디어 전달 데이터가 없습니다.",
    "Inspect diagnostics": "진단 정보 보기",
    "No diagnostics yet.": "아직 진단 정보가 없습니다.",
    "This browser session only": "현재 브라우저에서만 보관",
    "Turn history": "질문과 답변 기록",
    "Your questions, test answers, and validated responses will appear here.": "질문과 시험한 답변, 검증된 응답이 여기에 표시됩니다.",
    "Earlier story passages and your answers stay in their original language.": "이전 동화 기록과 직접 입력한 답변은 당시 언어 그대로 보관합니다.",
    "Prototype for checking story behavior. Educational quality and age-specific personas will be evaluated separately.": "동화 진행을 확인하기 위한 프로토타입입니다. 교육적 품질과 연령별 페르소나는 별도로 검토합니다.",
    "Ready": "준비 완료", "Accepted": "수용", "Clarification": "뜻 확인", "Try again": "다시 생각해 보기",
    "Service issue": "서비스 오류", "Story complete": "동화 완료",
    "Try generation again": "AI 생성 다시 시도", "Retry this request": "같은 요청 다시 시도",
    "The server returned an unreadable response. Check that the agent server is running.": "서버 응답을 읽을 수 없습니다. 에이전트 서버가 실행 중인지 확인해 주세요.",
    "The request failed ({status}).": "요청을 처리하지 못했습니다 ({status}).",
    "The server returned an invalid story state. Please start a new session.": "서버가 잘못된 동화 상태를 반환했습니다. 새 시험을 시작해 주세요.",
    "Deterministic mock · no model call": "오프라인 규칙 모드 · AI 호출 없음",
    "Authored fallback · no model call this turn": "준비된 대사로 진행 · 이번 응답은 AI 호출 없음",
    "The end": "끝",
    "The pigs are safe together. Thank you for shaping their story.": "돼지 삼형제가 함께 안전해졌어요. 동화를 함께 만들어 줘서 고마워요.",
    "Question intent: {intent}": "질문의 목적: {intent}",
    "choose_material": "재료 선택", "predict_consequence": "결과 예상", "reflect_on_cause": "원인 돌아보기",
    "No new media handoff for this turn.": "이번 응답에는 새 미디어 전달 데이터가 없습니다.",
    "narrator": "이야기꾼", "pig1": "첫째 돼지", "pig2": "둘째 돼지", "pig3": "셋째 돼지", "wolf": "늑대",
    "{count} turns": "{count}회", "{count} turn": "{count}회", "Turn {count}": "{count}번째 응답", "Authored fallback": "준비된 대사",
    "Question": "질문", "Answer": "답변", "Story": "동화 내용", "Next": "다음 질문",
    "Live model available ({model}). Mock mode runs authored, repeatable rules for testing.": "실제 AI 모델({model})을 사용할 수 있습니다. 오프라인 모드는 미리 정한 규칙으로 시험합니다.",
    "Live model is unavailable. Mock mode uses authored rules, without an AI call. Add MODEL_API_KEY to the server’s ignored .env file to test the live model.": "실제 AI 모델이 연결되지 않았습니다. 현재는 AI 호출 없이 미리 정한 규칙으로 동작합니다. 실제 모델을 시험하려면 서버의 .env 파일에 MODEL_API_KEY를 설정해 주세요.",
    "Server unavailable": "서버 연결 안 됨",
    "Serve this page from the local agent server to use the lab.": "로컬 에이전트 서버에서 이 화면을 열어 주세요.",
    "The local server did not respond in time. Check that it is running, then reconnect.": "로컬 서버의 응답이 늦습니다. 서버가 실행 중인지 확인한 뒤 다시 연결해 주세요.",
    "Starting a fresh story…": "새 동화를 준비하는 중…",
    "{mode}. Answer the question to begin.": "{mode}. 질문에 답하면 동화가 이어집니다.",
    "Starting the session took too long. Try starting again.": "시험 시작이 지연되었습니다. 다시 시작해 주세요.",
    "Listening to your idea and checking the next part…": "답을 살펴보고 다음 이야기를 확인하는 중…",
    "The story is complete. Start over to test another idea.": "동화가 끝났습니다. 처음부터 시작하면 다른 답을 시험할 수 있습니다.",
    "The current story and question are ready.": "동화와 다음 질문이 준비되었습니다.",
    "An authored option was applied without a model call. {message}": "AI 호출 없이 준비된 보기를 반영했습니다. {message}",
    "The generation service could not complete this turn. Choose one of the three authored options to continue without a model call, or retry live generation. Your retry count is preserved.": "AI 생성을 완료하지 못했습니다. 보기 3개에서 고르면 AI 호출 없이 이어가거나, AI 생성을 다시 시도할 수 있습니다. 아이의 실패 횟수는 늘어나지 않습니다.",
    "The generation service could not complete this turn. Your question and retry count are preserved.": "AI 생성을 완료하지 못했습니다. 현재 질문과 재시도 횟수는 유지됩니다.",
    "This answer is still being processed. Wait a moment, then retry the same request to retrieve its result.": "아직 답을 처리하고 있습니다. 잠시 후 같은 요청을 다시 시도하면 결과를 확인할 수 있습니다.",
    "{message} The current server state has been restored. Review the question and answer again.": "{message} 서버의 현재 상태를 불러왔습니다. 질문을 확인하고 다시 답해 주세요.",
    "The request timed out. Retry the same request to safely retrieve its result; this does not add another attempt.": "응답 대기 시간이 지났습니다. 같은 요청을 다시 시도해 주세요. 시도 횟수가 중복으로 늘어나지 않습니다.",
    "{message} Retry this request to safely recover its result.": "{message} 같은 요청을 다시 시도하면 결과를 확인할 수 있습니다.",
    "Changing language…": "언어를 바꾸는 중…",
    "Language changed. Your story progress has been preserved.": "언어를 바꿨습니다. 동화 진행과 선택은 그대로 유지됩니다.",
    "Language switching took too long. Try the language button again.": "언어 전환이 지연되었습니다. 언어 버튼을 다시 눌러 주세요.",
    "Could not connect to the local server. Please check the server and try again.": "로컬 서버에 연결하지 못했습니다. 서버를 확인한 뒤 다시 시도해 주세요.",
    "story_started": "동화를 시작했습니다", "answer_accepted": "답을 반영했습니다", "story_complete": "동화를 마쳤습니다",
    "unclear_answer": "답의 뜻을 다시 확인합니다", "material_not_allowed": "이 장면에서 사용할 다른 재료가 필요합니다",
    "outside_story_rules": "현재 장면의 범위에 맞춰 다시 생각해 주세요", "generation_unavailable": "생성을 완료하지 못했습니다",
    "instruction_override": "동화 진행 규칙을 바꾸는 요청입니다", "unsafe_request": "안전한 내용으로 다시 이야기해 주세요",
    "private_information": "개인정보가 포함되어 있습니다", "fixed_story_change": "동화의 고정 사건을 바꾸는 요청입니다",
    "missing_api_key": "서버에 MODEL_API_KEY를 설정한 뒤 서버를 다시 시작해 주세요.",
    "invalid_mode": "오프라인 규칙 모드나 실제 AI 모델을 선택해 주세요.",
    "invalid_language": "영어나 한국어를 선택해 주세요.",
    "session_limit": "시작한 시험이 너무 많습니다. 로컬 서버를 다시 시작해 주세요.",
    "invalid_request": "요청 형식이 올바르지 않습니다. 현재 질문을 확인해 주세요.",
    "session_not_found": "이 시험을 찾을 수 없습니다. 새 시험을 시작해 주세요.",
    "turn_in_progress": "이전 답을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
    "request_id_conflict": "다른 답변에는 새 요청을 사용해 주세요.",
    "stale_question": "이야기 상태가 바뀌었습니다. 현재 질문을 확인해 주세요.",
    "invalid_choice": "현재 질문에 표시된 보기 중에서 골라 주세요.",
    "turn_limit": "이번 시험의 요청 한도에 도달했습니다. 새 시험을 시작해 주세요.",
    "server_error": "서버가 요청을 처리하지 못했습니다. 다시 시도하거나 새 시험을 시작해 주세요."
  };
  function text(source, values = {}) {
    const result = language === "ko" ? (korean[source] || source) : source;
    return result.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
  }
  function apply() {
    document.documentElement.lang = language;
    document.title = text("Story agent lab · StoryShaper");
    document.querySelectorAll("[data-copy]").forEach(element => {
      if (!element.dataset.sourceText) element.dataset.sourceText = element.textContent.trim();
      element.textContent = text(element.dataset.sourceText);
    });
    for (const attribute of ["alt", "placeholder", "aria-label"]) {
      document.querySelectorAll(`[data-copy-${attribute}]`).forEach(element => {
        const key = `source-${attribute}`;
        if (!element.hasAttribute(`data-${key}`)) element.setAttribute(`data-${key}`, element.getAttribute(attribute));
        element.setAttribute(attribute, text(element.getAttribute(`data-${key}`)));
      });
    }
    document.querySelectorAll("[data-language]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    });
  }
  function set(value) {
    language = value === "ko" ? "ko" : "en";
    try { localStorage.setItem("story-language", language); } catch {}
    apply();
  }
  return { text, apply, set, get language() { return language; } };
})();
