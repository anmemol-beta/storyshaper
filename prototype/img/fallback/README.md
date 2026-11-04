# 재료에 종속되지 않는 백업 이미지

2026-11-04 사용자 요청에 따라 메인 장면(`house1_choose`)을 제외한 **9장 전부를 Muse API로 다시 생성**했다. 기존 Muse 장면의 수채화 화풍과 SAM 3.1 캐릭터 영역을 함께 참조했다. 요청에서 중복된 3번 두 항목은 각각 `house1_reflect`와 `house2_choose`로 보존했다.

[전체 미리보기](index.html) · [9장 모아 보기](preview.jpg) · [전체 프롬프트·참조·원본·검수 기록](manifest.json)

| 요청 번호 | 현재 엔진의 장면 ID | 이미지 |
| --- | --- | --- |
| 2 | `house1_predict` | [삽을 든 첫째와 다가오는 늑대](house1_predict.jpg) |
| 3 (첫 번째) | `house1_reflect` | [우는 첫째와 웃는 늑대](house1_reflect.jpg) |
| 3 (두 번째) | `house2_choose` | [궁금해하는 둘째와 달려오는 첫째](house2_choose.jpg) |
| 4 | `house2_predict` | [망치를 든 둘째와 다가오는 늑대](house2_predict.jpg) |
| 5 | `house2_reflect` | [손잡고 달아나는 형제와 거들먹거리는 늑대](house2_reflect.jpg) |
| 6 | `house3_choose` | [삽·망치를 든 형제들과 고민하는 막내](house3_choose.jpg) |
| 7 | `house3_predict` | [왼쪽 늑대와 오른쪽의 자신만만한 삼형제](house3_predict.jpg) |
| 8 | `house3_reflect` | [좌절한 늑대와 어깨동무하는 삼형제](house3_reflect.jpg) |
| 9 | `ending` | [실내 식탁에서 대화하는 삼형제](ending.jpg) |

## 제작과 확인

- **생성 모델·API:** `muse-image-1.0`, `POST https://api.meta.ai/v1/images/edits`, `reasoning_strength: high`. [공식 다중 이미지 편집 규격](https://dev.meta.ai/docs/image-generation)에 따라 기존 이미지와 캐릭터 영역을 실제 요청의 `images` 배열로 전달했다. 내장 이미지 생성 도구는 이번 재생성에 사용하지 않았다.
- **세그먼트 활용:** [기존 SAM 영역 목록](../motion/regions.json)의 `straw_house.pig.webp`(첫째), `pig2_empty.pig.webp`(둘째), `pig3_empty.pig.webp`(셋째), `wolf_paper.wolf.webp`(늑대)를 해당 배역이 있는 모든 생성에 참조 이미지로 넣었다. 이는 SAM 바운딩 박스의 가장자리를 부드럽게 처리한 크롭이며 정밀 전경 마스크가 아니다. 주변 픽셀의 집·소품은 복사하지 않도록 지시했다. 원본 Muse 전체 장면은 색감·붓질·종이 질감 참조로 따로 전달했다.
- **구도 연결:** `house2_predict`에는 새 Muse 삽 장면 원본도 함께 넣어 배경·늑대·확대 구도를 유지하고, 첫째→둘째와 삽→망치만 바꾸도록 했다.
- **저장 형식:** Muse 응답 그대로의 **1920 × 1280 PNG**와 서비스용 **1536 × 1024 JPEG**(품질 90, Lanczos 축소)를 모두 저장했다. 서비스용 JPEG 9장 합계는 약 **4.50 MiB**, 원본 PNG는 약 **34.50 MiB**다.
- **캐릭터:** 첫째는 장식 없음, 둘째는 파란 털모자, 셋째는 빨간 스카프. 늑대는 기존 회색 캐릭터를 따른다.
- 집·울타리·건축 재료 더미·잔해를 빼고, 요청한 도구·표정·물음표·손잡기·어깨동무로 장면을 구분했다. 결말은 요청에 따른 실내 예외이며 외관·노출된 건축 재료·벽 무늬 없이 식탁·의자·식기로 표현했다.
- **검수:** 최종 9장을 직접 확인했고 별도 `muse-spark-1.3` 호출로 원본·캐릭터 영역과 대조했다. 화풍·캐릭터·배역 수·장면 동작·재료 독립성·신체 표현·물음표·어린이 적합성 8개 기준을 전부 통과했다. 첫 둘째 질문 시안의 창틀·벽과 첫째 울음 시안의 귀 모양을 수정했다. 성공 응답 11장 중 9장을 채택했으며 제외한 시안은 서비스에 연결하지 않았다. 사전 제작 자산의 검수이며 실제 외부 모델 장애나 실기기 통합 시험을 의미하지 않는다.
- 각 원본 옆 `.json`에는 프롬프트·설정·참조 경로·SAM 영역 좌표·SHA-256·API 사용량·소요 시간이, `.review.json`에는 독립 검수 결과가 있다. 비밀 키와 요청의 base64 본문은 저장하지 않았다.
- **파일·연결 검증(11/4):** 최종 JPEG 9개와 원본 PNG 9개의 FFmpeg 디코딩·크기·SHA-256, 12개 참조 파일의 해시, 9개 장면·배역의 레지스트리 일치, 미리보기의 로컬 링크 49개를 확인했다. `tests.test_media`·`tests.test_live_images` **75개**가 통과했다.

생성 재현은 저장소 루트에서 아래 명령을 사용한다. `--dry-run`은 API를 호출하지 않는다. 실제 생성은 `.env` 또는 환경변수의 `MODEL_API_KEY`가 필요하며 새 후보를 저장한다. 런타임 JPEG 교체는 직접 확인 후 별도로 한다.

```bash
python3 experiments/gen_fallback_images.py --dry-run
python3 experiments/gen_fallback_images.py --only house1_predict house2_choose
python3 experiments/gen_fallback_images.py --review --only house1_predict house2_choose
```

## 이미지 원본 위치

- **현재 Muse 원본 PNG:** 이 폴더의 [`sources/muse-20261104/`](sources/muse-20261104/)에 있다. 최종 9장과 요청·검수 JSON을 저장소 안에 보존하므로 이후 커밋·push 시 함께 반영할 수 있다.
- **프로젝트용 JPEG:** 이 폴더의 기존 장면 이름 9개 `.jpg`다. 기존 두 번 실패·답변 전 다음 이동 경로가 이 새 파일을 사용한다. 레지스트리 리비전은 4로 갱신했다.
- 각 JPEG의 원본은 `manifest.json`의 `images[].sourceImageFile`, 프롬프트는 `images[].prompt`, 실제 참조 목록·좌표·해시는 `images[].referenceDetails`에서 찾을 수 있다.
- **11/2 이전판 보존:** 내장 도구로 만들었던 이전판의 프롬프트·원본 대응표는 [`sources/imagegen-20261102.manifest.json`](sources/imagegen-20261102.manifest.json)에 남겼다. 당시 원본은 Mac의 `~/.codex/generated_images/01a19c95-5d4c-7430-8c9b-98801ba7e28b/`에 있고 새 Muse 원본과 구분한다. 이전 JPEG는 Git 이력에 남아 있다.

## 자동 대체 동작 — 2026-11-03 연결

사용자가 정한 후속 동작은 **첫 이미지 변환 실패 → 한 번 더 호출 → 두 번째 실패 시 현재 장면의 백업 이미지 자동 표시**다. 총 생성 시도는 2회다.

**답하기 전에 다음(▶)으로 넘기는 경우에도 백업을 즉시 표시한다.** 서버의 기본 안전 선택으로 한 단계 진행하고, 해당 장면의 백업을 생성·검수 호출이나 작업 큐 없이 불러온다. AI·오프라인 모드 모두 적용하며, 이 경로의 생성 시도는 0회다. 백업이 디코딩되면 낭독 준비가 끝나기 전에도 그림을 먼저 보여 주고, 답 입력은 장면 준비가 끝난 뒤 연다.

수동 다음 검증은 Python 143개·전체 JavaScript 221개 통과. 격리 Chrome에서 한·영, AI·오프라인 각각 9개 장면씩 총 36장면을 답변 없이 완주했고 생성 호출은 0회였다. 낭독을 준비 중인 상태에서도 백업을 가리지 않고 먼저 표시하는지 확인했다.

`media/scene_registry.json`의 `backups`에 이야기·장면별로 등록했다. `manifest.json`은 생성 프롬프트·원본·연결 상태를 기록하는 제작 자료이며 런타임 자산 선택은 레지스트리를 사용한다.

- 서버가 승인한 장면 사실당 자동 생성·독립 검수는 최대 2회다. 타임아웃도 실패로 처리하고 첫 실패에는 자동 재호출한다. 두 번째 실패에는 같은 작업에서 이 폴더의 해당 장면 그림을 반환한다.
- 생성 실패의 백업은 `source:scene_backup`, `generated:false`, `generationRequested:true`, `generationAttempts:2`다. 수동 다음 이동의 백업은 `reason:manual_navigation`, `generationRequested:false`, `generationAttempts:0`으로 구분한다. 11/3 사용자 요청에 따라 백업 그림 위 안내 문구는 표시하지 않으며 집 붕괴 효과나 이전 그림 덮개도 적용하지 않는다.
- 같은 요청·수동 재로딩·언어 전환·미리 그리기는 총 2회 한도를 초기화하지 않는다. 백업 다운로드 실패는 같은 백업을 다시 불러오며 추가 생성하지 않는다. 취소·장면 이동 뒤 늦은 생성 결과와 타임아웃은 새 시도·백업·현재 화면을 덮어쓰지 못한다.
- 일반 답변의 객관식·오프라인 그림은 기존대로 사용하고, 수동 다음 이동은 별도의 장면 백업을 사용한다. 메인 장면은 이번 백업에서 제외한다. 백업이 삭제되거나 검수·재료 독립성 표시가 없으면 다른 장면으로 치환하지 않고 명시적 실패로 남긴다.

외부 모델을 호출하지 않는 실패 모형으로 두 번 실패하는 9개 장면을 영어 PC(1280×900)·한국어 모바일(390×844) Chrome에서 각각 완주했다. 각 장면의 생성 시도는 2회, 그림 요청은 장면당 1회였으며 백업 JPEG의 실제 로드·입력 해제·앞뒤 재방문을 확인했다. 유료 Muse 장애와 실제 기기·부모 음성의 전체 연결은 별도 검증 대상이다.

관련 Python 126개·전체 JavaScript 208개 회귀 테스트를 통과했다. 첫 실패 뒤 성공, 두 번 실패·타임아웃, 중복·언어 전환·미리 그리기, 늦은 생성과 취소, 누락·미검수 백업, 백업 디코딩·재로딩과 장면 음성 준비 순서를 포함한다.

요구사항과 후속 완료 기준은 [개발 로드맵 §6](../../../docs/internal/development-roadmap.md)에 기록했다.
