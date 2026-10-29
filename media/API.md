# 로컬 미디어 API — 1~2단계 구현

외부 API·키 없이 실행하는 동화 시험 서버 + 미디어 API다. 동화 엔진·기존 서버 파일과 UI 파일은 수정하지 않고 `MediaPlayground`/`MediaHandler`로 확장했다.

```powershell
python -m media.server --port 8000
```

같은 서버의 `http://127.0.0.1:8000/prototype/agent.html`에서 기존 mock 동화를 진행할 수 있다. 이 화면은 아직 미디어 API를 호출하거나 영상을 재생하지 않는다. 플레이어 연결은 `ui_mvp`의 별도 작업이다. 현재 CLI는 `.env`를 읽지 않으며 실제 모델 모드를 활성화하지 않는다. 실제 Spark 검증이 필요하면 기존 동화 서버를 사용한다.

## 클라이언트 연결 순서

1. 기존 `POST /api/sessions`와 `POST /api/answer`로 동화를 진행한다.
2. 응답의 decision이 accept/complete이고 mediaPlan이 존재하면 아래 작업 생성 API를 호출한다. mediaPlan 자체는 보내지 않는다.
3. 응답의 sessionId/sceneId/version이 앱의 현재 상태와 모두 같고 apply=true일 때 image를 표시한다. image=null이면 마지막 검증 이미지를 유지하고 미지원 장면임을 안내한다. 이전 이미지를 새 재료의 생성 결과로 표시하지 않는다.
4. queued/running 동안 이미지를 유지하면서 상태를 조회한다. 준비된 결과에 video가 있어야만 재생한다. fallback/failed는 영상 재생 없이 이미지를 유지하는 정상 복구 경로다.
5. 언어 변경과 동화 답변으로 새 version이 오면 이전 결과를 바로 적용하지 않는다. 현재 바인딩으로 다시 요청한다. 같은 공개 로컬 콘텐츠는 진행 중 작업 또는 완료 결과를 재사용한다.
6. 페이지 이탈·이전 페이지·녹음 시작·재시작 때 재생을 멈추고 기존 jobId를 취소한다. 재시작은 새 sessionId를 사용한다. 서버는 서로 다른 탭·세션 중 어느 것이 현재 사용자 화면인지 알 수 없으므로 이 취소 호출과 클라이언트의 현재 토큰 검사가 필요하다.

## 생성·조회·취소

| 메서드 | 경로 | 입력 |
| --- | --- | --- |
| POST | `/api/media/jobs` | `{sessionId, sceneId, version}` |
| GET | `/api/media/jobs/<jobId>?sessionId=<sessionId>` | 해당 작업의 세션 |
| POST | `/api/media/cancel` | `{sessionId, jobId}` |

현재 세션의 권위 있는 snapshot에서 MediaSpec을 만든다. 클라이언트가 전송한 mediaPlan·상태·자산 URL은 허용하지 않는다. 오래된 scene/version은 HTTP 409, 다른 세션의 작업 조회는 404, 서버 인스턴스의 작업 한도는 429다. 기존 localhost Host/Origin 검사를 재사용한다. 세션 ID는 로컬 개발용 접근 구분이며 운영 로그인/가족 권한이 아니다.

응답 예시(종이집을 선택한 뒤, 로컬 처리가 완료된 경우):

```json
{
  "jobId": "<job-id>",
  "sessionId": "<session-id>",
  "sceneId": "house1_predict",
  "version": 1,
  "status": "fallback",
  "reason": "clip_unavailable",
  "apply": true,
  "image": {
    "url": "/prototype/img/paper_house.jpg",
    "sha256": "<file-hash>",
    "cast": ["pig1"]
  },
  "video": null,
  "fallback": {
    "keepCurrentImage": false,
    "message": "Continue with the picture while video is unavailable."
  },
  "source": "local_assets",
  "generated": false,
  "spec": {"action": "build", "outcome": "blown_away"}
}
```

예시의 spec은 핵심 두 항목만 발췌했다. 실제 응답은 정규화한 story_id/house_id/target_house_id/material 등도 포함한다.

상태는 queued/running/ready/fallback/failed/cancelled다. ready는 레지스트리에 등록되고 reviewed=true인 로컬 MP4가 있을 때만 반환한다. clarify/redirect/service_error 등 새 미디어 계획이 없으면 `{status: "no_new_media", jobId: null, apply: false}`를 반환한다. `generated=false`는 기존 로컬 자산을 사용한다는 뜻이며 실제 생성 성공을 뜻하지 않는다.

## 자산과 캐시

- `scene_registry.json`은 집·재료·action을 정확히 매핑한다. 첫째 종이/짚, 둘째 나무, 셋째 벽돌과 집별 빈 터·결말 이미지가 등록돼 있다. 다른 조합은 미지원이며 엉뚱한 재료·배역 자산으로 치환하지 않는다.
- `build`는 아직 사건 전이다. `outcome`에 예정된 사건이 있어도 사건 클립을 선택하지 않는다. `move_to_next_house`는 scene의 목적지 집으로 이동한다.
- clips는 현재 비어 있다. 실제 검수된 MP4를 `prototype/video/`에 두고 해당 asset_key에 `{file, reviewed: true, cast}`를 등록하면 로컬 클립 경로로 연결할 수 있다. 테스트의 MP4 바이트는 HTTP 전달용 fixture이며 재생 가능한 생성 결과가 아니다.
- 미검수/누락/허용 경로 밖 자산은 선택하지 않는다. video 경로는 레지스트리에 등록된 검수 파일만 video/mp4로 제공한다.
- 동일 session/scene/version은 같은 jobId를 반환한다. 같은 정적 자산 키·레지스트리 버전·파일 해시·배역은 언어와 무관하게 같은 콘텐츠 작업을 사용한다. 개인화된 이미지·영상은 이 공개 캐시에 연결하지 않는다. 이후 가족별 접근 경계·캐시 키가 먼저 필요하다.

## 작업 한계와 후속 연결

동시 로컬 작업자는 2개, 작업 바인딩은 서버 인스턴스당 최대 256개, 기본 제한시간은 대기 시간을 포함해 15초다. 작업·중복 방지·캐시는 메모리에만 존재한다. 서버 재시작 시 모두 사라진다. 이 한도에 도달하면 새 로컬 서버 인스턴스로 시험을 다시 시작한다.

취소와 timeout은 늦게 도착한 결과의 적용을 막는다. 작업 제공자는 취소 Event를 협조적으로 확인해야 한다. 이미 무효화된 화면 바인딩의 공유 콘텐츠 작업은 제한시간 안에서 끝날 수 있지만 그 결과를 옛 화면에는 적용하지 않는다. 같은 로컬 작업의 실패·취소를 재요청해도 자동 재시도하지 않는다.

외부 유료 제출·task ID 저장·제출 여부 불명확 처리·needs_review 승인 흐름·운영 영속 저장은 3단계 이후다. 현재 LocalProvider에 외부 유료 호출을 추가하지 않는다. 향후 Runway 어댑터는 별도의 영속 제출 기록과 과금 중복 방지 규약을 갖춰야 한다.

검증 명령:

```powershell
python -m unittest discover -s tests -p test_media.py -v
python -m unittest discover -s tests -v
```

Z Fold8의 재생·접기/펼치기·회전 검증은 UI 플레이어가 연결된 뒤 실제 기기에서 진행한다.
