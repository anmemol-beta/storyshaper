"""Korean picture-book lines and the character error rate shared by the Korean narration experiments."""
import re

LINES = [  # from the Korean picture book (prototype/story.js)
    "옛날 옛적에 엄마 돼지와 아기돼지 삼형제가 살았어요.",
    "첫째 돼지는 햇살이 따뜻한 풀밭을 찾았어요.",
    "무엇으로 집을 지었을까?",
    "종이구나! 첫째 돼지는 종이를 접고 또 접었어요.",
    "첫째 돼지는 동생의 집으로 달려갔어요.",
]


def cer(expected, heard):
    """Character error rate (edit distance / length) on Hangul and letters only."""
    a, b = (re.sub(r"[^가-힣a-z0-9]", "", s.lower()) for s in (expected, heard or ""))
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1] / max(1, len(a))
