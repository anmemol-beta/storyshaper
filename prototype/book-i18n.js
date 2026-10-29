// UI copy is independent of the story's language-neutral scene IDs and material choices.
const BOOK_COPY = {
  en: {
    language: "Story language", lab: "Live AI", labTitle: "Open the live AI test", settings: "Settings",
    demoModeLabel: "Prototype mode", fixedDemoNotice: "Fixed story demo: the microphone and story changes are simulated.",
    openLiveTest: "Open the live AI test →",
    look: "Look", light: "Light", dark: "Dark", auto: "Auto", voice: "Read aloud in a parent's voice",
    speed: "Reading speed", showDemo: "Show demo answers", restart: "Start over",
    confirmRestart: "Start from the beginning?", yes: "Yes", no: "No", fullscreen: "Full screen",
    help: "This page plays a fixed story with prepared pictures and simulated microphone input. Open the live AI test to type an answer and generate new story text. Existing English narration uses prepared recordings.",
    storyTitle: "The Three Little Pigs", start: "▶ Start the story", retry: "Try again", sayAgain: "Say it again", again: "Read again ↻",
    demo: "Demo answers", progress: "Story progress", next: "Next ›", talk: "Tap to talk", finish: "Tap to finish",
    lightMode: "Switch to light mode", darkMode: "Switch to dark mode",
    noAnswers: "Listening time. Nothing to answer yet.", built: "Houses you built today",
    heard: (answer) => `You said “${answer}”`,
    READING: "Listening to the story", ASKING: "What do you think?", PICK: "Tap a picture",
    LISTENING: "I'm listening…", GENERATING: "Painting a new picture…", UPDATED: "Look what happened!",
    CHOICES: "Let's pick a picture! Tap the one you like.",
    ERROR: "I didn't catch that. Say it again?", DONE: "The End"
  },
  ko: {
    language: "동화 언어", lab: "실제 AI 시험", labTitle: "실제 AI 모델 시험 화면 열기", settings: "설정",
    demoModeLabel: "프로토타입 방식", fixedDemoNotice: "고정 동화 데모입니다. 마이크와 이야기 변경은 모의 동작입니다.",
    openLiveTest: "실제 AI 모델 시험하기 →",
    look: "화면 모양", light: "밝게", dark: "어둡게", auto: "자동", voice: "한국어 음성으로 읽어주기",
    speed: "읽는 속도", showDemo: "시험용 답변 보기", restart: "처음부터 읽기",
    confirmRestart: "이야기를 처음부터 읽을까요?", yes: "네", no: "아니요", fullscreen: "전체 화면",
    help: "이 화면은 준비된 그림과 고정 대사로 진행하며 마이크 입력도 모의 동작입니다. 실제 생성은 ‘실제 AI 모델 시험하기’에서 글로 답을 입력해 확인할 수 있어요. 한국어 낭독은 브라우저 음성이고, 기기에 한국어 음성이 없으면 소리가 나지 않을 수 있어요.",
    storyTitle: "아기돼지 삼형제", start: "▶ 이야기 시작", retry: "다시 말하기", sayAgain: "다시 말하기", again: "다시 읽기 ↻",
    demo: "시험용 답변", progress: "이야기 진행", next: "다음 ›", talk: "눌러서 말하기", finish: "눌러서 말하기 마치기",
    lightMode: "밝은 화면으로 바꾸기", darkMode: "어두운 화면으로 바꾸기",
    noAnswers: "지금은 이야기를 듣는 시간이에요.", built: "오늘 함께 지은 집",
    heard: (answer) => `“${answer}” 하고 말했구나!`,
    READING: "이야기를 듣고 있어요", ASKING: "어떻게 생각하니?", PICK: "그림을 골라보렴",
    LISTENING: "네 말을 듣고 있어…", GENERATING: "새 그림을 그리고 있어요…", UPDATED: "어떻게 달라졌는지 보렴!",
    CHOICES: "이번에는 그림을 보고 골라 볼까? 마음에 드는 걸 눌러 줘!",
    ERROR: "잘 못 들었어. 다시 말해줄래?", DONE: "이야기 끝"
  }
};
