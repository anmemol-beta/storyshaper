# img2vid 구현 계획 — 동화 에이전트 연결 기준

작성: 2026-10-29 KST. 기준: fetch로 확인한 `origin/main`의 `18f92d5`.
상태: 1~2단계의 계약·정적 자산 선택·로컬 작업 관리·HTTP API를 구현했다. 실제 파일 구성과 실행 규격은 [API 문서](API.md)를 따른다. 아래는 전체 설계안이며 prompt_builder/image_service/video_service/외부 제공자/유료 생성·검수는 후속 범위다.

## 1. main에서 확인한 것

- `story_agent/engine.py`: 답 해석 → 서버 규칙으로 분기 결정 → 대사·질문 작성 → 규칙 검증 → 모델 검토 → 상태 확정과 `mediaPlan` 작성.
- `story_agent/story.json`: 첫 두 집은 paper/straw/wood/cookie/icecream, 마지막 집은 brick/stone. 재료별 사건은 미리 정의돼 있다. 현재는 무제한 자유 재료 생성이 아니다.
- `story_agent/provider.py`: Muse Spark의 텍스트 응답 어댑터. 이미지 생성 어댑터가 아니다.
- `prototype/agent.js`: `mediaPlan`을 JSON으로 표시한다. 미디어 생성·재생 연결은 없다.
- `experiments/gen_story_images.py`: Muse Image 편집으로 미리 정한 그림책 자산을 제작하는 별도 실험 스크립트. 에이전트 입력에서 이미지까지 연결한 서버가 아니다. import 시에도 외부 호출 준비와 실행이 이어지므로 미디어 서비스에서 그대로 import하지 않는다.
- 현재 `media/prepare.py`: 종이집 한 장면의 Runway 요청을 로컬에서 작성한다. `mediaPlan` 입력, 작업 관리, API 제출·폴링, 앱 연결은 없다.

기존 가이드에 적힌 실제 Muse Spark 검증 기록과 이번 확인을 구분한다. 이번에는 키를 읽거나 모델을 호출하지 않았다. `MockProvider`로 종이·과자·아이스크림 각 3단계의 전달값 9개를 관찰했으며 생성 품질 검증은 아니다.

## 2. 책임과 흐름

```text
동료: 아이 답 → 허용 여부/재질문 → 이야기 상태·mediaPlan 확정
                                        ↓
img2vid: 전달값 검사 → 장면/참조 자산 선택 → 이미지 확보
                                        ↓
                           필요한 사건만 영상 작업 예약
                                        ↓
                          검수된 이미지·영상·작업 상태
                                        ↓
ui_mvp: 현재 장면과 버전 확인 → 표시·재생·건너뛰기·복구
```

미디어 계층은 아이 답을 다시 해석하거나 사건을 새로 결정하지 않는다. 영상 프롬프트는 검증된 재료·동작·허용 배역·시각 제약과 참조 이미지에서 구성한다. 원본 발화나 생성 대사를 그대로 영상 지시문에 붙이지 않는다. narration은 음성 계층에 전달할 데이터로 취급한다.

## 3. 현재 전달 규격의 주의점

### 결과 예고를 실제 사건으로 재생하지 않기

| 입력 후 상태 | 실제 전달값 예 | 미디어 동작 제안 |
| --- | --- | --- |
| 재료 선택 → `house1_predict` | `action=build`, `outcome=blown_away` | 완성된 종이집 정지 이미지. 붕괴 영상은 표시하지 않음 |
| 예상 답 → `house1_reflect` | `action=blown_away` | 실제 사건을 보여주는 클립 또는 결과 이미지 |
| 이유 설명 → `house2_choose` | `action=move_to_next_house`, `houseId=house1` | 다음 집의 빈 터/이동 장면. 앞집 붕괴를 다시 재생하지 않음 |
| 마지막 이유 설명 → `ending` | `action=safe_ending` | 함께 안전하게 있는 결말 이미지 |

`outcome`은 `build` 단계에도 미래 사건으로 존재한다. 재생 트리거는 `action`이며, 장면의 단계와 교차 확인한다. 내부 사전 생성은 가능하지만 결과 공개 시점과 분리한다.

이동 단계의 `sceneId`는 목적지, `houseId/material`은 출발한 집을 가리킨다. 이것을 오류로 수정하지 말고 미디어 어댑터에서 두 역할을 분리한다. 첫 버전은 서버가 발급한 snapshot의 `storyState.houseIndex`와 허용된 scene 매핑으로 목적지를 결정한다. 범용화를 위해 동료와 `sourceHouseId/targetHouseId` 추가를 협의할 수 있으나 기존 규격을 먼저 재사용한다.

`characters`는 고정 배역 목록이다. 매 장면에 돼지 셋을 모두 그리라는 지시로 사용하지 않는다. 집·동작별 출연 배역과 의상은 자산 레지스트리에 둔다. 첫째와 둘째의 같은 재료 그림도 돼지·배경이 다르므로 무조건 공유하지 않는다.

`decision=accept/complete`, `diagnostics.validated=true`, 현재 서버 snapshot과 일치하는 mediaPlan만 처리한다. `clarify/redirect/service_error`와 `mediaPlan=null`이면 새 생성 작업을 만들지 않는다. 검증된 선택지의 `authoredFallback=true`는 정상 입력으로 처리한다. `validated_plan_only`는 영상 준비 완료 상태가 아니다.

## 4. 모듈 경계 제안

```text
media/
  contracts.py          # 서버 snapshot → 정규화된 MediaSpec, 허용값/단계 검사
  scene_registry.json   # 집·재료·동작 → 출연 배역·참조 이미지·대체 자산
  prompt_builder.py     # build/event/transition/ending별 제한된 이미지·동작 지시
  image_service.py      # 기존 이미지 선택; 이후 Muse Image 편집 어댑터 연결
  video_service.py      # 사건 클립 선택·생성 예약
  jobs.py               # 중복 방지, 상태 전이, task ID, 시간 제한
  providers/
    local.py            # 검수된 로컬 자산; 생성 성공으로 위장하지 않음
    runway.py           # 별도 키가 준비되면 제출·조회·취소 지원 범위 구현
tests/
  test_media_contracts.py
  test_media_jobs.py
```

기존 `prepare.py`와 `paper-wind.json`은 독립 제공사 POC로 유지한다. 먼저 새로운 정규화 입력과 연결한 후 공통 요청 작성 부분만 추출한다. 위 파일을 한 번에 모두 만드는 대신 아래 PR 순서로 최소 단위를 구현한다.

이미지/영상의 외부 호출은 서버에서 수행한다. 브라우저가 arbitrary mediaPlan·이미지 URL을 보내면 그대로 신뢰하지 않고, 서버 세션의 확정된 snapshot에서 다시 조회한다. 기존 동화 서버는 메모리 기반 로컬 시험 서버이므로 운영 인증·영속 저장이 완료된 것으로 가정하지 않는다.

## 5. 작업 상태와 중복·버전 처리

- 상태 제안: `queued → running → needs_review → ready`; 실패·취소는 `failed/cancelled`. 검수된 기존 자산은 바로 `ready`, 자산 없음은 명시적인 fallback 결과를 반환한다.
- 영상 실패는 동화 에이전트의 실패 횟수를 올리지 않는다. 이미지와 대사는 계속 사용할 수 있다.
- 요청 식별: sessionId + sceneId + version + media type. 같은 요청 재전송은 동일 작업을 반환한다.
- 무음 영상의 콘텐츠 캐시: story/house/material/action + visible cast/reference image hashes + prompt version + provider/model/settings. 언어 전환·발표용 version 증가만으로 같은 영상을 유료 재생성하지 않는다.
- 화면에 적용할 때는 현재 sessionId/sceneId/version을 모두 확인한다. 언어 변경으로 version이 바뀌면 콘텐츠는 재사용하되 현재 요청에 새로 연결하고, 이전 요청 결과를 직접 적용하지 않는다.
- 최초 유료 제출 전에 작업 의도를 기록한다. task ID를 받으면 저장하고 같은 ID만 조회한다. 제출 응답이 유실돼 생성 여부를 모르면 `submission_unknown`으로 기록하고 자동 재제출하지 않는다.
- 가족별 참조·개인화 결과는 가족 접근 경계를 추가한다. 공개 기본 자산의 공유 캐시와 섞지 않는다.

## 6. 구현·PR 순서

| 순서 | 범위 | 키 필요 | 완료 기준 |
| --- | --- | --- | --- |
| PR 1 | MediaSpec 검사, action 분기, 자산 레지스트리, 로컬 이미지 선택 | 없음 | 실제 mock snapshot을 받아 종이집 build/사건/다음 집을 구분. 빈 자산은 fallback으로 반환 |
| PR 2 | 비동기 작업·조회, 중복 방지·취소/구버전 차단, 로컬 클립 인터페이스 | 없음 | 느림/실패/중복/언어 변경/페이지 이동을 재현하고 새 상태 보존. 클립 부재를 생성 성공으로 표시하지 않음 |
| PR 3 | Runway 어댑터와 종이집 단일 장면 실제 생성·수동 검수 | 별도 Runway 키·예산 | 캐릭터·종이/바람 인과관계·구도 검수. 비용·지연·실패 원본 기록. 영상은 검수 후 ready |
| PR 4 | Muse Image 편집 어댑터, 현재 에이전트 상태에 맞는 이미지 생성·확인 | Meta 키 또는 동료 개발 서버 연동 | 동일 배역/집을 유지하며 과자·아이스크림처럼 기존 자산 없는 분기도 표현 |

`ui_mvp`의 플레이어는 PR 1~2 계약에 맞춰 별도 PR로 `main`에 통합한다. 영상 쪽이 UI 파일을 수정하지 않는다. 작업 후 각 PR을 `main`에 합친 다음 다른 작업 브랜치가 가져온다.

첫 통합은 house1/paper 한 경로를 끝까지 연결한다. 그다음 straw/wood/brick을 자산별 검수 후 확대한다. cookie/icecream/stone과 house2의 다른 재료는 레지스트리에서 지원 여부를 명시한다. 없는 그림을 종이집 영상으로 대체하지 않고 마지막 검증 이미지 또는 준비된 해당 장면 안내를 사용한다.

## 7. 키가 없을 때 진행할 일

지금은 PR 1~2를 먼저 진행할 수 있다. 기존 이미지와 mock mediaPlan으로 서버 연결·화면 상태·타이밍을 완성한다. 기존 종이집 한 장면 POC는 영상 제공사 키가 생기면 별도로 실제 생성한다. Meta 키를 얻기 위해 동료 키를 복사하거나 프런트에 넣을 필요는 없다. 동료 서버를 이용한다면 합의된 개발 서버 API와 서버 측 키로 처리한다.

생성형 영상이 없는 동안 정지 이미지·간단한 화면 전환으로 진행할 수 있지만 이를 실제 image-to-video 결과로 표시하지 않는다. 실시간 생성이 기본 독서 흐름의 선행 조건이 되지 않게 한다.

## 8. 검증 계획

실제 프로젝트의 Python unittest에 tests/test_media.py를 추가했다. 키 없는 계약·작업 관리·HTTP 검증을 실행하며, 유료 생성·실기기 검증은 포함하지 않는다. 아래 항목 중 5번의 유료 제출은 로컬 제공자 호출 중복 방지까지만 검증했다.

1. paper/build에 미래 outcome이 있어도 사건 영상 미노출.
2. cookie/eaten, icecream/melted를 wind 레시피로 만들지 않음.
3. `move_to_next_house`에서 이전 집 재료와 새 목적지를 구분.
4. redirect/clarify/service_error에서 새 생성·과금 작업 없음; authored fallback 정상 수용.
5. 동일 요청 두 번·동시 요청에서도 유료 제출 한 번. 제출 불명확 상태는 자동 재시도 금지.
6. 지연 완료 후 재시작/페이지 이동/언어 변경에도 구버전 결과 적용 금지.
7. 언어만 바꾸면 무음 클립 콘텐츠 캐시 재사용. narration은 별도 처리.
8. 키 없음·영상 없음·타임아웃·검수 탈락에도 이미지로 진행.
9. Z Fold8 실기기: 접음/펼침/회전 도중 재생, 건너뛰기, 녹음 시작 시 재생 중단, contain 구도·자막 확인. 기기 해상도·브라우저는 실제 확인 후 기록.

실제 유료 영상 생성 횟수와 예산은 실행 전에 정한다. 이번 조사에서는 외부 API 호출 0회, 실제 생성·품질·지연·실기기 검증 미실행이다.
