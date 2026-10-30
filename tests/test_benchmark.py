"""Bounded benchmark plumbing tests; these do not measure model latency or quality."""
import io
import json
import unittest
from unittest.mock import patch

from story_agent.benchmark import RecordingProvider, main, run_benchmark
from story_agent.engine import MockProvider
from story_agent.provider import ProviderError


class MeasuredMock(MockProvider):
    def complete_with_metrics(self, instructions, payload):
        return super().complete(instructions, payload), {
            "durationMs": 12, "inputTokens": 20, "cachedInputTokens": 0,
            "private": "secret-answer", "outputTokens": 5}


class BenchmarkTests(unittest.TestCase):
    def test_adaptive_turns_review_new_material_but_skip_two_known_material_reviews(self):
        report = run_benchmark(MeasuredMock())
        self.assertEqual(report["modelCalls"], 4)
        self.assertEqual(report["pipeline"], "adaptive")
        self.assertTrue(report["allAccepted"])
        self.assertTrue(report["automatedChecksPassed"])
        self.assertFalse(report["liveLatencyEvidence"])
        self.assertTrue(report["manualQualityReviewRequired"])
        for scenario, phases in zip(report["scenarios"], (
                ["interpret_compose", "review"], ["interpret_compose"], ["interpret_compose"])):
            self.assertEqual([call["phase"] for call in scenario["calls"]],
                             phases)
            self.assertEqual(scenario["calls"][0]["cachedInputTokens"], 0)
        encoded = json.dumps(report, ensure_ascii=False)
        for private in ("secret-answer", "더 커질 거 같아!", '"lines"', '"storyState"'):
            self.assertNotIn(private, encoded)

    def test_reviewed_baseline_retains_six_calls_and_reports_review_policy(self):
        report = run_benchmark(MeasuredMock(), pipeline="two_call")
        self.assertEqual(report["modelCalls"], 6)
        self.assertTrue(report["automatedChecksPassed"])
        self.assertTrue(all(row["independentReview"] for row in report["scenarios"]))

    def test_failed_choice_skips_prediction_and_captures_failure_metrics(self):
        class Broken(MeasuredMock):
            def complete_with_metrics(self, instructions, payload):
                error = ProviderError("model_unavailable")
                error.metrics = {"durationMs": 30, "inputTokens": None, "private": "secret"}
                raise error
        report = run_benchmark(Broken())
        self.assertFalse(report["allAccepted"])
        self.assertFalse(report["automatedChecksPassed"])
        self.assertEqual(report["modelCalls"], 2)
        self.assertTrue(report["scenarios"][-1]["skipped"])
        for row in report["scenarios"][:-1]:
            self.assertEqual(row["failureCode"], "model_unavailable")
            self.assertEqual(row["calls"][0]["durationMs"], 30)
            self.assertFalse(row["calls"][0]["ok"])
        self.assertNotIn("secret", json.dumps(report))

    def test_call_bound_is_enforced_without_provider_retry(self):
        recorder = RecordingProvider(MeasuredMock(), limit=1)
        payload = {"phase": "review"}
        recorder.complete("policy", payload)
        with self.assertRaises(ProviderError):
            recorder.complete("policy", payload)
        self.assertEqual(len(recorder.calls), 1)

    def test_repeat_limit_and_default_cli_stays_offline(self):
        for repeat in (0, 4, True):
            with self.assertRaises(ValueError):
                run_benchmark(MockProvider(), repeats=repeat)
        report = run_benchmark(MockProvider(), repeats=2)
        self.assertEqual(report["modelCalls"], 8)
        with patch("story_agent.benchmark.MetaProvider") as live, patch("sys.stdout", new=io.StringIO()) as output:
            self.assertEqual(main([]), 0)
        live.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())["mode"], "mock")


if __name__ == "__main__":
    unittest.main()
