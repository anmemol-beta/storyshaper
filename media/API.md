# 미디어 API — 준비 그림과 실시간 생성

`MediaPlayground`/`MediaHandler`로 동화 서버를 확장한다. `prototype/index.html`의 플레이어가 승인된 새 답마다 미디어 작업을 요청한다. 앱 실행은 `src.server`로 통일하며 mock 모드는 키 없이 준비된 그림을 제공한다.

```powershell
python3 -m src.server
```

같은 서버의 `http://127.0.0.1:8000/`에서 mock 동화를 진행할 수 있다. 통합 앱은 `.env`를 읽는다. 실제 이미지·마이크·카메라는 `ffmpeg` 설치와 `.env`의 `MODEL_API_KEY` 설정 후 같은 `python3 -m src.server`로 실행한다. 실시간 영상 생성은 포함하지 않는다.

## 새 답마다 실시간 그림

- `/api/config`의 `mediaAvailable`, `imageGenerationAvailable`, `speechAvailable`로 기능을 알린다. 실제 AI 세션의 승인된 자유 답은 Muse Image 편집 1회(`muse-image-1.0`)와 독립 이미지 검수 1회(`muse-spark-1.3`, `low`)를 사용한다. mock 세션은 이미지 모델을 호출하지 않는다.
- **객관식은 저장 그림을 즉시 제공한다.** 서버 snapshot의 검증된 `selection`과 진행 후 `spec.asset_key`에 정확히 일치하는 파일이 있으면 AI/mock 모두 작업 큐·모델 호출 없이 `status:ready`, `source:prepared_choice`, `reason:prepared_choice_image`, `generated:false`, `generationRequested:false`를 반환한다. 재료·예상·이유 보기와 다음 집 이동·결말에 같은 규칙을 적용한다. 저장 그림은 기존 `prototype/img/`와 `prototype/img/scenes/`의 Git 추적 파일이며 레지스트리를 공유한다. 새 재료의 그림이 없으면 기존 생성 경로를 유지한다.
- 승인된 재료·시공·행동·배역·앞선 집 상태만 프롬프트에 넣는다. 자유 답 원문·실패한 발화·오디오·카메라 프레임은 이미지 요청에 넣지 않는다. 기존 장면·배역, 가능하면 같은 집의 직전 생성 그림을 참조한다. JPEG로 디코딩해 2MB 이하로 제한하며 안전·재료·배역·행동 검수 네 항목을 모두 통과해야 제공한다.
- 성공은 `status:ready`, `source:muse_image`, `generated:true`, `generationRequested:true`, `image.reviewed:true`다. `/api/media/images/<id>?sessionId=<id>`로 JPEG를 제공하며 미만료 세션과 이미지 소유 세션이 같아야 한다. 운영 계정 인증은 별도다.
- 실패는 `generated:false`, `generationRequested:true`다. 해당 재료의 준비 그림 또는 이전 그림을 유지하며 생성 성공과 구분한다. 아이용 독서 화면은 복구 전까지 다음 장면을 잠그며 자동 유료 재시도는 없다.
- 생성 키는 세션·승인된 장면 사실이다. 중복 요청·언어만 바뀐 버전은 같은 진행 중/완료 작업을 공유하며 취소된 같은 장면도 자동 재제출하지 않는다. 세션 간 생성 그림은 공유하지 않는다. 서버 재시작 이후에는 새 생성이다.
- 아이용 독서 화면은 그림 로딩·디코딩·전환이 끝날 때까지 다음 본문·질문·입력을 잠근다. 정상 `prepared_choice`는 표시 완료 후 진행하고, 생성 실패의 대체 그림은 잠금을 유지한다. 저장 그림 로딩 실패의 재시도는 같은 파일을 다시 불러오며 유료 생성으로 바꾸지 않는다. 새 답·재시작·페이지 이탈은 이전 표시를 취소하며 언어 전환은 작업을 유지해 새 버전에 연결한다. 늦은 응답·이미지 로딩도 현재 바인딩을 확인한다.

공식 규격: [Meta Image Generation](https://dev.meta.ai/docs/image-generation), [Image Understanding](https://dev.meta.ai/docs/image-understanding). 키·공급자 오류 본문을 클라이언트에 노출하지 않는다.

## 클라이언트 연결 순서

1. 기존 `POST /api/sessions`와 `POST /api/answer`로 동화를 진행한다.
2. 응답의 decision이 accept/complete이고 mediaPlan이 존재하면 아래 작업 생성 API를 호출한다. mediaPlan 자체는 보내지 않는다.
3. 응답의 sessionId/sceneId/version이 앱의 현재 상태와 모두 같고 apply=true일 때 image를 표시한다. image=null이면 마지막 검증 이미지를 유지하고 미지원 장면임을 안내한다. 이전 이미지를 새 재료의 생성 결과로 표시하지 않는다.
4. queued/running 동안 이미지를 유지하면서 상태를 조회한다. 준비된 결과에 video가 있어야만 재생한다. fallback/failed는 영상 재생 없이 이미지를 유지하는 정상 복구 경로다.
5. 언어 변경과 동화 답변으로 새 version이 오면 이전 결과를 바로 적용하지 않는다. 현재 바인딩으로 다시 요청한다. 같은 공개 로컬 콘텐츠는 진행 중 작업 또는 완료 결과를 재사용한다.
6. 페이지 이탈·새 답·재시작은 기존 jobId 표시를 취소한다. 녹음 시작은 이미지 작업을 막지 않는다. 재시작은 새 sessionId를 사용한다. 서버는 어느 탭·세션이 현재 화면인지 알 수 없으므로 취소 호출과 클라이언트의 현재 토큰 검사가 필요하다.

## 생성·조회·취소

| 메서드 | 경로 | 입력 |
| --- | --- | --- |
| POST | `/api/media/jobs` | `{sessionId, sceneId, version, retryOf?}` |
| GET | `/api/media/jobs/<jobId>?sessionId=<sessionId>` | 해당 작업의 세션 |
| GET | `/api/media/images/<imageId>?sessionId=<sessionId>` | 해당 세션의 검수된 JPEG |
| POST | `/api/media/cancel` | `{sessionId, jobId}` |

현재 세션의 권위 있는 snapshot에서 MediaSpec을 만든다. 클라이언트가 전송한 mediaPlan·상태·자산 URL은 허용하지 않는다. 오래된 scene/version은 HTTP 409, 다른 세션의 작업 조회는 404, 서버 인스턴스의 작업 한도는 429다. 기존 localhost Host/Origin 검사를 재사용한다. 세션 ID는 로컬 개발용 접근 구분이며 운영 로그인/가족 권한이 아니다.

`retryOf`는 사용자가 명시적으로 다시 불러오기를 누른 경우의 이전 실패 `jobId`다. 생성이 실패한 현재 AI 작업만 새 생성·독립 검수로 대체하며, 같은 `retryOf`의 중복 요청·동시 클릭은 최신 대체 작업을 반환한다. 진행 중·완료된 작업은 재생성 없이 재연결한다. 취소한 작업·다른 장면/버전은 409, 다른 세션/없는 작업은 404다. 한 장면 사실당 수동 재생성은 최대 두 번이며 초과하면 429 `image_retry_limit`이다. `generationRetryAvailable`·`retriesRemaining`으로 복구 가능 여부를 안내한다. 언어 변경으로 한도를 초기화하지 않는다. 이미지 다운로드·디코딩 실패는 `retryOf` 없이 같은 결과를 다시 불러온다.

응답 예시(종이집 객관식을 선택한 뒤, 즉시 저장 그림을 반환):

```json
{
  "jobId": "<job-id>",
  "sessionId": "<session-id>",
  "sceneId": "house1_predict",
  "version": 1,
  "status": "ready",
  "reason": "prepared_choice_image",
  "apply": true,
  "image": {
    "url": "/prototype/img/paper_house.jpg",
    "sha256": "<file-hash>",
    "cast": ["pig1"]
  },
  "video": null,
  "fallback": {
    "keepCurrentImage": false,
    "message": "Continue with the prepared picture for this choice."
  },
  "source": "prepared_choice",
  "generated": false,
  "generationRequested": false,
  "generationRetryAvailable": false,
  "retriesRemaining": 0,
  "spec": {"action": "build", "outcome": "blown_away"}
}
```

예시의 spec은 핵심 두 항목만 발췌했다. 실제 응답은 정규화한 story_id/house_id/target_house_id/material 등도 포함한다.

터치로 고른 답은 동화 응답의 `selection`과 `mediaPlan.selection`에 서버가 확정한 `{choiceId, label, answer, sessionId, sceneId, questionId, version, language}`를 담는다. 장면·질문·버전·언어는 **선택 당시의 원래 질문**을 가리키며, 미디어 계획 자체는 진행 후 장면을 가리킨다. 미디어 작업의 `spec.selection`에도 같은 기록을 전달해 추후 이미지 생성에서 실제 선택과 재료를 대조할 수 있다. 언어 전환은 원래 기록을 보존한다. 클라이언트가 보낸 임의 선택 문구·재료는 사용하지 않으며 미디어 작업 생성 요청에는 계속 바인딩 3개 필드만 받는다. 자유 발화 턴의 `selection`은 `null`이고 이전 터치를 새 발화의 출처로 표시하지 않는다.

상태는 queued/running/ready/fallback/failed/cancelled다. ready는 객관식에 정확히 맞는 저장 그림, 독립 검수된 생성 이미지 또는 등록된 reviewed=true 로컬 MP4가 있을 때 반환한다. `prepared_choice` 캐시는 일반 로컬 영상 대체 작업과 분리해 결과가 섞이지 않는다. clarify/redirect/service_error 등 새 미디어 계획이 없으면 `{status: "no_new_media", jobId: null, apply: false}`를 반환한다. `generated=false`는 실제 생성 성공을 뜻하지 않는다.

## 자산과 캐시

- `scene_registry.json`은 집·재료·action을 정확히 매핑한다. 등록 재료의 집별 build·outcome 24개 장면과 빈 터·결말 이미지가 등록돼 있다. 검증된 새 재료는 materialSpec·materialId를 보존하지만 그림이 없으면 명시적인 미지원 fallback을 반환하며 다른 재료·배역 자산으로 치환하지 않는다.
- `build`는 아직 사건 전이다. `outcome`에 예정된 사건이 있어도 사건 클립을 선택하지 않는다. `move_to_next_house`는 scene의 목적지 집으로 이동한다.
- clips는 현재 비어 있다. 실제 검수된 MP4를 `prototype/video/`에 두고 해당 asset_key에 `{file, reviewed: true, cast}`를 등록하면 로컬 클립 경로로 연결할 수 있다. 테스트의 MP4 바이트는 HTTP 전달용 fixture이며 재생 가능한 생성 결과가 아니다.
- 미검수/누락/허용 경로 밖 자산은 선택하지 않는다. video 경로는 레지스트리에 등록된 검수 파일만 video/mp4로 제공한다.
- 동일 session/scene/version은 같은 jobId를 반환한다. 같은 정적 자산 키·레지스트리 버전·파일 해시·배역은 언어와 무관하게 같은 콘텐츠 작업을 사용한다. 개인화된 이미지·영상은 이 공개 캐시에 연결하지 않는다. 이후 가족별 접근 경계·캐시 키가 먼저 필요하다.

## 작업 한계와 후속 연결

동시 작업자는 2개, 바인딩은 서버 인스턴스당 최대 256개다. 대기 포함 제한시간은 로컬 15초, 실제 이미지 120초다. 이미지 HTTP 요청은 75초, 검수는 30초, 디코딩은 15초 이내로 제한하며 자동 재호출하지 않는다. 작업·그림·중복 방지·캐시는 메모리에만 존재하고 서버 재시작 시 사라진다. 한도에 도달하면 새 로컬 서버 인스턴스로 시험한다.

취소와 timeout은 늦은 결과 적용을 막는다. 제공자는 취소 Event를 협조적으로 확인해야 한다. 무효화된 바인딩의 공유 작업은 제한시간 안에서 끝날 수 있지만 옛 화면에는 적용하지 않는다. 동일 sessionId/sceneId/version의 보통 요청은 기존 jobId와 실패·취소 상태를 유지하며 자동 재시도하지 않는다. 위 `retryOf`만 제한된 수동 재생성을 허용한다. 대체된 이전 작업은 `reason:retried`, `apply:false`로 새 결과를 덮지 못한다. 로컬 콘텐츠는 취소 뒤 새 세션·새 버전에서 새 작업을 만들 수 있다. 실제 이미지는 같은 세션·같은 장면 사실의 취소 상태를 언어 전환 뒤에도 유지해 유료 재제출하지 않는다. 이전 완료·제한시간 콜백과 반복 취소는 새 작업에 영향을 주지 않는다.

`LocalProvider`는 오프라인 전용이며 별도 `MuseImageProvider`가 실시간 생성·검수를 담당한다. 운영 영속 제출 기록·서버 재시작 이후 중복 방지·가족 권한·영상 공급자 연결은 후속이다. 유료 영상 어댑터에는 별도 제출 기록과 과금 중복 방지 규약이 필요하다.

검증 명령:

```powershell
python -m unittest discover -s tests -p test_media.py -v
python -m unittest discover -s tests -v
```

Z Fold8의 재생·접기/펼치기·회전 검증은 UI 플레이어가 연결된 뒤 실제 기기에서 진행한다.
