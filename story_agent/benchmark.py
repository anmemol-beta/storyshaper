"""Bounded Korean latency comparison; defaults to mock and never retries calls.

Run ``python3 -m story_agent.benchmark --live --label low --output /tmp/low.json``.
Reports contain counts, timings and checks, never answers, generated text or credentials.
Automated checks are probes, not proof of natural language quality or child safety.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import time

from .engine import MockProvider, StoryEngine
from .provider import MetaProvider, ProviderError, load_env


class RecordingProvider:
    """Capture independent call metrics, including failures, without changing content."""

    def __init__(self, provider, limit=6):
        self.provider, self.limit = provider, limit
        self.mode = provider.mode
        self.calls = []

    def complete(self, instructions, payload):
        if len(self.calls) >= self.limit:
            raise ProviderError("benchmark_call_limit")
        started = time.perf_counter()
        metrics = {}
        ok = False
        try:
            measured = getattr(self.provider, "complete_with_metrics", None)
            if measured:
                result, metrics = measured(instructions, payload)
            else:
                result = self.provider.complete(instructions, payload)
            ok = True
            return result
        except ProviderError as exc:
            metrics = getattr(exc, "metrics", {}) or {}
            raise
        finally:
            # Explicit allowlist prevents response bodies or extra adapter data leaking.
            record = {key: metrics.get(key) for key in (
                "requestBytes", "instructionChars", "inputChars", "reasoningEffort",
                "inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens")}
            record.update(phase=payload["phase"], ok=ok,
                          durationMs=metrics.get("durationMs", round(
                              (time.perf_counter() - started) * 1000, 3)))
            self.calls.append(record)


def _accepted(result):
    diagnostics = result.get("diagnostics", {})
    return (result["decision"] == "accept" and diagnostics.get("validated") is True
            and diagnostics.get("authoredFallback") is False)


def _process_before_result(result):
    """Conservative lexical hint; None means wording requires manual inspection."""
    text = " ".join(line["text"] for line in result["lines"])
    def first(markers):
        positions = [text.find(word) for word in markers if word in text]
        return min(positions) if positions else None
    process = first(("물방울", "똑똑", "말랑", "주르르", "흘러", "얇아", "흐르"))
    outcome = first(("녹아", "녹았", "녹은", "물웅덩"))
    return None if process is None or outcome is None else process < outcome


def run_benchmark(provider, *, repeats=1, label="comparison", compose_effort="low", review_effort="low",
                  pipeline="adaptive"):
    if type(repeats) is not int or not 1 <= repeats <= 3:
        raise ValueError("repeats must be 1 to 3")
    recorder = RecordingProvider(provider, limit=6 * repeats)
    rows = []

    def turn(engine, state, answer, name, repeat):
        offset = len(recorder.calls)
        started = time.perf_counter()
        result = engine.answer(state, answer)
        row = {"scenario": name, "repeat": repeat, "decision": result["decision"],
               "reason": result["reason"], "accepted": _accepted(result),
               "durationMs": round((time.perf_counter() - started) * 1000, 3),
               "calls": deepcopy(recorder.calls[offset:]), "checks": {},
               "reviewReason": result.get("diagnostics", {}).get("reviewReason"),
               "independentReview": result.get("diagnostics", {}).get("independentReview", False)}
        failure = result.get("diagnostics", {}).get("failureCode")
        if failure:
            row["failureCode"] = failure
        rows.append(row)
        return result, row

    for repeat in range(1, repeats + 1):
        engine = StoryEngine(recorder, "ko", pipeline=pipeline)
        result, row = turn(engine, engine.start("benchmark-vinyl"),
                           "비닐로 짓고 싶어!", "vinyl_choose", repeat)
        house = next(iter(result["storyState"]["houses"]), {})
        spec = house.get("materialSpec", {})
        row["checks"]["materialIdentityPreserved"] = (
            row["accepted"] and house.get("material") == "custom"
            and spec.get("source") == "비닐" and spec.get("labels", {}).get("ko") == "비닐"
            and (result.get("mediaPlan") or {}).get("materialLabel") == "비닐")
        engine = StoryEngine(recorder, "ko", pipeline=pipeline)
        result, row = turn(engine, engine.start("benchmark-icecream"),
                           "아이스크림으로 집을 지을래!", "icecream_choose", repeat)
        houses = result["storyState"]["houses"]
        chosen = row["accepted"] and bool(houses) and houses[0]["material"] == "icecream"
        row["checks"]["materialIdentityPreserved"] = chosen
        if chosen:
            result, row = turn(engine, result, "더 커질 거 같아!", "icecream_predict", repeat)
            row["checks"].update(
                processBeforeResultHint=_process_before_result(result) if row["accepted"] else None,
                noExtraTurn=row["accepted"] and result["version"] == 2
                and result["sceneId"] == "house1_reflect")
        else:
            rows.append({"scenario": "icecream_predict", "repeat": repeat,
                         "skipped": True, "reason": "icecream_choice_not_accepted", "calls": []})
    all_accepted = all(row.get("accepted", False) for row in rows)
    checks_passed = all_accepted and all(
        value is True for row in rows for value in row.get("checks", {}).values())
    return {"label": label, "mode": provider.mode, "pipeline": pipeline,
            "composeEffort": compose_effort, "reviewEffort": review_effort,
            "repeats": repeats, "modelCalls": len(recorder.calls), "callLimit": 6 * repeats,
            "allAccepted": all_accepted, "automatedChecksPassed": checks_passed,
            "manualQualityReviewRequired": True, "liveLatencyEvidence": provider.mode == "live",
            "scenarios": rows}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="Send up to 6 model calls per repeat.")
    mode.add_argument("--mock", action="store_true", help="Offline fixtures (the default).")
    parser.add_argument("--compose-effort", choices=("default", "minimal", "low"), default="low")
    parser.add_argument("--review-effort", choices=("default", "minimal", "low"), default="low")
    parser.add_argument("--pipeline", choices=("adaptive", "two_call"), default="adaptive")
    parser.add_argument("--label", default="comparison")
    parser.add_argument("--repeat", type=int, choices=(1, 2, 3), default=1)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    provider = MockProvider()
    if args.live:
        load_env(Path(__file__).resolve().parent.parent / ".env")
        key = os.environ.get("MODEL_API_KEY", "")
        if not key:
            print(json.dumps({"ok": False, "code": "missing_api_key"}))
            return 2
        provider = MetaProvider(key, os.environ.get("STORY_AGENT_MODEL", "muse-spark-1.3"),
                                compose_reasoning_effort=None if args.compose_effort == "default" else args.compose_effort,
                                review_reasoning_effort=None if args.review_effort == "default" else args.review_effort)
    report = run_benchmark(provider, repeats=args.repeat, label=args.label,
                           compose_effort=args.compose_effort, review_effort=args.review_effort,
                           pipeline=args.pipeline)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0 if report["automatedChecksPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
