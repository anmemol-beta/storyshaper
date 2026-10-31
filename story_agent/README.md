# 동화 대본 데이터

현재 독서 화면의 오프라인·AI 버전은 모두 이 폴더의 대본을 사용한다.

- [`story.ko.json`](story.ko.json): 한국어 대본.
- [`story.json`](story.json): 영어 대본. 언어가 달라도 인물·재료·사건 식별자는 같다.
- [`story.schema.json`](story.schema.json): `schemaVersion: "2.0"`의 인물·발화 형식.
- [`performance.json`](performance.json)·[`performance.py`](performance.py): 성격·말투·감정을 이미지 표정·몸짓과 지원되는 음성 합성 제어값, 실제 연기 녹음 지시로 연결한다.
- [`scripts/three-little-pigs.ko.json`](scripts/three-little-pigs.ko.json), [`scripts/three-little-pigs.en.json`](scripts/three-little-pigs.en.json): 내레이션·질문까지 모든 멘트가 구조화되고 재료명이 치환된 모델 입력용 완성본. 언어별 28개 대체 장면을 담는다.
- [사람이 읽는 한국어 대본](../docs/internal/story-script.md): 짚 → 나무 → 벽돌 경로의 장면별 대사와 다른 재료의 분기 안내.

`prototype/story.js`와 `prototype/audio/lines*.json`은 이전 고정 그림책용 자료다. 현재 기본 화면의 대본 원본은 이 폴더의 JSON이다.

## 인물과 문장

`fixedCharacters`의 ID를 `characters`의 프로필과 각 문장의 `speakerId`에 동일하게 사용한다. 이야기꾼, 첫째·둘째·막내 돼지, 늑대가 구분되며, 등장인물의 직접대사는 `kind: "dialogue"`다. 이야기꾼은 `kind: "narration"`이다.

각 프로필은 표시 이름(`name`), 고정 역할(`role`), 성격(`personality`), 말하는 방식(`speechStyle`), 기본 말투·감정(`defaultTone`, `defaultEmotion`), 그림 표현 참고사항(`imageNotes`)을 갖는다. 문장의 감정은 사건에 따라 변하므로 성격과 별도로 기록한다.

```json
{
  "speakerId": "pig1",
  "text": "나는 짚 재료로 집을 지을 거야!",
  "kind": "dialogue",
  "tone": "lively",
  "emotion": "excited"
}
```

`text`에는 실제로 읽을 말만 넣는다. 이름표·따옴표·`[신나게]` 같은 연기 지시는 UI와 메타데이터가 담당한다. 원본의 `build`·`process`·`event` 문자열은 `narrationDelivery`의 이야기꾼 메타데이터를 따른다. 질문은 기존 `question` 필드에 별도로 저장되며 `questionDelivery`를 따라 궁금한 말투로 읽는다. 모델 입력용 완성본에서는 질문도 `questionLine`에 완전한 발화 객체로 제공한다.

| 말투 코드 | 의미 |
| --- | --- |
| `warm` | 다정하게 |
| `lively` | 활기차게 |
| `thoughtful` | 차분히 생각하며 |
| `playful` | 익살스럽게 |
| `gentle` | 부드럽게 |
| `curious` | 궁금해하며 |
| `reassuring` | 안심시키며 |

감정 코드는 `calm`(차분함), `excited`(들뜸), `curious`(궁금함), `confident`(자신감), `surprised`(놀람), `worried`(걱정), `relieved`(안도), `happy`(기쁨), `determined`(의욕), `disappointed`(아쉬움)이다. 코드는 한·영에서 동일하다.

## 장면 조립 순서

집마다 재료 선택 → 결과 예상 → 사건의 이유 생각하기를 유지하며 총 9번 참여한다. `{material}`은 서버가 승인한 현재 언어의 재료명으로 치환한다. 원본 템플릿을 그대로 음성 모델에 읽히지 않는다.

1. **재료 선택:** 도입 내레이션 + 해당 집의 `introLines` + `question`.
2. **결과 예상:** 집짓기 안내 + 해당 돼지의 `buildLines` + 재료의 `build` 설명 + `setupLines` + `predict` 질문. 이때 결과를 미리 말하지 않는다.
3. **이유 생각하기:** 재료의 `process`를 순서대로 설명 → `event` 결과 → `eventLines` → 해당 돼지의 `reactionLines` → `reflect` 질문. AI 버전은 아이의 예상을 짧게 받아준 다음 같은 순서를 따른다.
4. **집 이동·결말:** 다음 집의 도입으로 옮기거나 `endingLines`를 읽는다. 결말에서는 네 등장인물이 모두 직접 말한다.

종이·짚은 바람에 흩어지고, 느슨한 나무는 무너지며, 과자는 늑대가 먹고, 아이스크림은 햇볕에 녹는다. 벽돌·돌은 함께 단단히 붙여 버틴다. 아이스크림 장면에 늑대가 바람을 불어 녹였다고 말하지 않는다. 승인된 새 재료도 같은 물성의 장면 대사를 사용하고 아이가 고른 이름을 보존한다.

## 모델 입력으로 사용할 때

- **스토리 에이전트:** 현재 언어의 인물 프로필, 서버가 승인한 장면 사실, 조립한 `lines`, 질문을 전달한다. 성격·화자·선택한 재료와 원인·결과를 유지하며 짧게 표현한다. 내레이션만으로 바꿔 직접 발화자를 누락한 후보는 서버가 거절한다.
- **음성 합성·학습 준비:** 조립한 각 줄의 `text`를 전사문, `speakerId`를 화자, `tone`·`emotion`을 조건 레이블로 사용한다. 언어·장면 ID·순서도 함께 보존한다. **JSON만으로 음성 학습 데이터가 완성되지는 않는다.** 실제 학습에는 해당 문장과 일치하는 권한 있는 음성 및 구간 정렬이 별도로 필요하다.
- **이미지 생성:** 승인된 재료·행동·장면에 맞는 등장인물만 사용한다. 현재 `visual_performance()`가 그 행동에 해당하는 대본의 성격·감정을 표정·몸짓으로 변환해 실제 이미지 생성과 독립 검수에 전달한다. 기존 참조 외형과 사건을 우선하며 대사나 메타데이터를 그림 안 글자로 그리지 않는다. 원본 아이의 말이나 클라이언트 임의 프로필은 이미지 표현 지시로 사용하지 않는다.

현재 낭독은 기존 배역의 참조 음성을 유지하면서 `voice_direction()`의 인물·말투·감정별 표현 강도·CFG·속도를 실제 합성 설정에 적용한다. 완성본의 `voiceDirections`는 본문 줄 순서이며 질문이 있으면 마지막에 질문 지시가 있다. `visualPerformance`는 현재 그림에 실제로 등장하는 배역만 담는다. 연기 녹음 화면은 같은 원본의 성격·감정을 보여 주고, 확인된 실제 녹음만 학습 자료로 선별한다. 실제 가중치 학습 완료와 연기 프리셋 전달은 구분하며 음질·표현은 청취 검수가 필요하다. [실행법과 모델 한계](../docs/internal/model-performance.md)를 참고한다.

## 변경과 검증

대사는 한·영 JSON을 함께 수정한다. 직접대사는 말하는 인물의 `speakerId`를 사용하고, 내레이션의 관찰 과정과 고정 사건을 보존한다. 음성 예열(`python3 -m narration.warm`)도 현재 대본의 모든 준비 분기와 배역을 사용한다. 문장이 바뀌면 기존 문장의 음성 캐시가 새 문장에 잘못 붙지 않으며 새 음성이 준비될 때까지 기본 음성으로 읽는다.

```bash
python3 -m story_agent.script --language ko --output story_agent/scripts/three-little-pigs.ko.json
python3 -m story_agent.script --language en --output story_agent/scripts/three-little-pigs.en.json
python3 -m unittest discover -s tests -p 'test_story_dialogue.py' -v
node --test tests/narration.test.cjs tests/live-book.test.cjs
```

완성본의 `scenes`는 재료별 대체 장면을 모두 담은 목록이다. `sceneSelection`과 `priorHouses` 설명을 따르고, 현재 `sceneId`와 선택 재료에 맞는 한 장면만 고른다. 예시 앞부분의 기본 경로는 짚 → 나무 → 벽돌이며, 다른 경로에서는 실제 선택 상태를 별도로 전달한다. 새 재료는 세션에서 검증된 물성·이름으로 런타임에 조립하므로 정적 완성본의 등록 재료 목록에 포함되지 않는다.

실행 중인 앱에는 서버 재시작 후 새 세션으로 변경 대본을 적용한다. 메모리의 기존 세션을 도중에 다른 대본으로 덮어쓰지 않는다.
