# ui_mvp 다음 작업 — 수찬님

작성: 2026-10-30 KST. fetch 후 `origin/main` **4eb7873**(PR #9 병합)을 확인하고 이 브랜치를 fast-forward했다. 아래는 로드맵 단계 2~4·7·9와 §12에 연결한 실행 제안이다.

## 판단과 현재 상태

### main 재점검 결과 (2026-10-30)

재요청 후 `git fetch origin --prune`을 실행했으며 main은 이전과 같은 `4eb7873`이다. 따라서 아래 후속 작업은 아직 main에서 완료되지 않았다. 이 브랜치의 계획 문서가 올라간 것과 기능 구현을 구분한다.

| 계획 항목 | main 판정 | 코드 근거와 다음 행동 |
| --- | --- | --- |
| 독서 화면에 에이전트 연결 | 미완료 | `agent.js`에 `/api/sessions`, `/api/answer` 호출이 있지만 `app.js` 독서 흐름과 분리돼 있다. 서버 상태를 독서 화면에 연결하는 P0-1부터 진행 |
| 그림·미디어 API 연결 | 미완료 | `agent.js`는 mediaPlan을 JSON으로 표시하며 `/api/media/jobs` 호출이 없다. P0-2에서 실제 결과 표시·취소 연결 |
| 실제 음성 입력 재사용 | 통합 대기 | main에 `speech/`가 없으며 `app.js`는 첫 답을 모의 인식한다. `feat/voice-input` 작업을 검토·통합한 뒤 독서 화면에 재사용 |
| 부모 낭독 | 일부 구현 | `app.js`는 사전 생성 audio 클립과 브라우저 TTS를 재생한다. 새 에이전트 대사에 대한 부모 음성 생성·재생 연결은 미완료 |
| 화면 일관성·이미지 전환 | 코드 반영 완료 | 오른쪽 마이크·StoryImageTransition이 main에 있다. 실제 기기에서 전환 품질을 확인해야 함 |
| 실기기·영상 플레이어 | 완료 근거 없음 / 플레이어 미구현 | 이전 브라우저 스크린샷은 Fold 기기·실제 영상 재생 증거가 아님 |

**바로 다음 작업:** 기존 이미지·음성 브랜치의 main 통합 상태를 확인하면서 P0-1과 P0-2를 먼저 구현한다. 음성·영상 준비가 늦어져도 개발용 답 입력과 정지 이미지로 실제 서버 한 편을 완주하도록 한다. 이번 점검은 코드 확인이며 기능 테스트·기기 시험을 새로 실행한 결과가 아니다.

**독서 화면에서 실제 에이전트·그림·음성을 한 편 끝까지 연결하는 것이 최우선**이다. 앱 패키징과 추가 화면 확장은 그 다음이다.

- main 완료: 마이크 오른쪽 배치, 이미지 디코딩 후 420ms 크로스페이드, 로딩 실패·구요청 콜백 방어, 움직임 줄이기 지원.
- `index.html/app.js`는 고정 그림책 데모, `agent.html/agent.js`는 에이전트 시험 화면이다. agent.js는 mediaPlan을 JSON으로 보여주며 미디어 API를 호출하지 않는다.
- 영상 플레이어·실제 폴더블 검증·실제 입력부터 부모 목소리까지의 한 화면 통합은 미완료다. 이미지 전환 개선을 GIF/영상 구현 완료로 취급하지 않는다.
- **중복 개발 주의:** `origin/feat/voice-input`에 `voice-input.js`, `/api/transcribe`, `speech/server.py`와 agent 화면 연결이 있다. 녹음/STT를 다시 만들기보다 main 통합 상태를 확인하고 독서 화면에서 재사용한다. 해당 브랜치의 실행·품질은 이번 문서 작업에서 재검증하지 않았다.
- `origin/fix/choose-retry-materials`는 서버 재질문·허용 재료 관련 변경이다. 프런트에서 판정 규칙을 새로 만들지 않는다.
- `origin/feat/scene-pictures`에는 추가 재료 이미지가 있다. main에는 아직 없으므로 과자/아이스크림 등 지원을 완료로 표시하지 않는다.
- `origin/docs/roadmap-to-deadline` §13의 핵심 통합 우선 제안을 반영했다. 이 문서와 해당 원격 브랜치는 확정 일정이나 main 구현 완료의 증거가 아니다.

## 수찬님이 먼저 확인할 것

- [ ] 지호님과 독서 화면에서 사용할 세션·답변·언어 변경 응답, 서버가 반환하는 선택지 규격을 맞춘다.
- [ ] 음성 입력 브랜치 담당자와 main 반영 시점·서버 실행법을 확인한다. 현준님에게는 동적 대사 낭독의 요청/응답·기본 음성 대체 규약을 확인한다.
- [ ] img2vid와 시연 경로·이미지 준비 상태를 공유한다. 제안: 종이 → 과자 또는 아이스크림 → 벽돌.
- [ ] 실제 사용할 기기와 OS/브라우저를 기록한다. 사용자가 예상한 Z Fold8은 실기기 확인 전이며, iPad 목표를 자동 폐기하는 결정은 아니다.
- [ ] 한 편에서 보여줄 입력·선택지·낭독 범위를 정한다. 생성형 영상 유무에 관계없이 완주 가능한 흐름을 우선한다.

## 개발 순서와 완료 기준

| 순서 | 작업 | 완료 기준 |
| --- | --- | --- |
| P0-1 | 독서 화면에 서버 세션 상태 연결. 고정 데모와 실제 모드 진입을 명확히 표시 | 버튼/개발용 텍스트 답으로 영어 한 편 완주. 서버 상태가 장면·재료·질문을 결정 |
| P0-2 | 미디어 작업 생성·조회·취소와 이미지 표시 연결 | 현재 sessionId/sceneId/version 및 apply=true를 확인한 결과만 반영. pending/실패에도 마지막 검증 이미지 유지 |
| P0-3 | voice-input 변경을 재사용해 녹음·인식 결과 확인·재녹음 연결 | 실제 마이크 답이 에이전트에 도달. 권한 거절은 즉시 선택형 입력, 서비스 장애는 아이 실패 횟수에 미포함 |
| P0-4 | 현준님 낭독 연결·중단·기본 음성 대체 | 동적 대사를 읽고 녹음 시작 시 낭독 중단. 구버전 음성이 새 장면과 겹치지 않음 |
| P0-5 | 한 편의 오류·언어 변경·재시작 및 실기기 화면 검증 | 3회 실패 시 서버의 보기 표시. 접기/펼치기·회전·복귀 시 내용과 마이크 위치 유지, 이미지 공백·잔상 없음 |
| P1 | 검수된 MP4 플레이어, 건너뛰기, 종료 후 이미지 유지 | 재생 거절·영상 지연·실패에도 이야기 진행. 페이지 이동·녹음·재시작 때 재생과 조회를 정리 |
| 이후 | 보호자 설정·진행 저장/재개·앱 패키징 | 서버 저장/복구 규약과 목표 기기 검증 후 범위를 결정. 계정·앱 프레임워크를 미리 확정하지 않음 |

## 연결 시 지킬 경계

1. 서버가 승인한 상태를 표시한다. 클라이언트에서 mediaPlan이나 허용 재료·사건을 만들어 보내지 않는다. 미디어 API 입력은 `{sessionId, sceneId, version}`이다.
2. build의 outcome은 미래 사건일 수 있다. 장면 선택은 action 기준으로 하고 이동 장면에서는 목적지 sceneId를 따른다.
3. 이미지가 준비될 때까지 이전 그림을 유지하되 새 답의 생성 결과로 오해시키지 않는다. 디코딩 완료 후 기존 StoryImageTransition을 사용한다. 느린 네트워크·빠른 연속 탭에서도 이를 우회하지 않는다.
4. 녹음·이동·재시작·이탈 시 영상/낭독을 중단하고 조회와 이전 job 바인딩을 정리한다. 취소한 동일 토큰을 다시 요청해도 취소 상태가 유지되므로 재개 규약을 서버와 합의한다.
5. 두 서버 프로세스의 메모리 세션을 서로 공유한다고 가정하지 않는다. voice-input의 SpeechPlayground는 MediaPlayground를 상속하므로 통합 서버 경로를 검토한다.

## 다음 PR 범위와 검증 계획

다음 구현 PR은 `ui_mvp → main`: `prototype/`의 독서 연결과 UI 테스트·기기 증거를 묶는다. `speech/`·동화 판정은 담당자 변경을 재사용하고 API 수정이 필요하면 함께 규격을 맞춘다. `media/` 제공자·자산 생성은 img2vid에서 관리한다.

- 변경 후 `node --test tests/book-ui.test.cjs tests/agent-ui.test.cjs tests/image-transitions.test.cjs` 및 새 연결에 필요한 테스트 실행.
- 실제 통합 서버에서 정상 답, 의미 확인, 3회 실패, 서비스 장애, 언어 변경, 생성 중 재시작을 검증.
- 실제 기기에서 좁은/넓은 화면·회전·백그라운드 복귀, 권한 거절, 낭독과 녹음 겹침, 영상 재생 실패를 확인. 기기/브라우저·재현 단계·녹화와 결과 기록.
- 이미지 전환은 최종 스크린샷만으로 매끄러움을 단정하지 않는다. 화면 녹화로 공백·잔상·잘못된 그림 노출을 확인한다.

이번 커밋은 문서만 변경했다. PR #9의 Python 81개·Node 35개 통과는 과거 기록이며 새 테스트 실행이나 실기기 확인을 뜻하지 않는다.

참고: [미디어 API](../media/API.md), [개발 로드맵](../docs/internal/development-roadmap.md), [이전 구현 보고서](../docs/reports/2026-10-29-media-ui-implementation.md).

## 2026-10-30 P0 implementation update (ChatGPT)

- Merged latest main commit `8810e0f` into `ui_mvp` without replacing branch-specific planning.
- Added `prototype/live.html`, `live-book.js`, `live-book.css`: browser book view driven by real `/api/sessions`, `/api/answer`, `/api/language` responses; input via text or existing `VoiceInput` public API; narration via existing `Narration.speak/stop` API; images/videos through `/api/media/jobs` and `StoryImageTransition`.
- Added Reader + Change (opens voice registration in new tab), Read aloud On/Off, and default-reader cover copy. Existing fixed demo remains accessible; `index.html` links to the new live page.
- Video layer only plays video URL returned with `apply=true, status=ready`. Previous image remains visible on failure. Scene/version guard blocks old media jobs.
- Changed **no** `narration/`, `voice/`, or `speech/` implementation files. Existing `voice.html` still links back to `agent.html`; new tab preserves the live book's session rather than changing the voice author's screen.
- Added `tests/live-book.test.cjs`. JavaScript parser validation completed; browser end-to-end playback, recording, iPad/Safari, and connected-model flow were **not** verified here. Do not claim production readiness.
- Potential integration blockers: Narration defaults to `127.0.0.1:8100`, inaccessible on a separate tablet, and cloned voice for English only. Voice author owns service exposure and voice internals; UI can accept a `?voiceServer=...` parameter via the narration module.
- Run: `python -m speech.server`, separate narration server if available, then open `http://127.0.0.1:8000/prototype/live.html`. Test `node --test tests/live-book.test.cjs` and existing UI tests before PR.

