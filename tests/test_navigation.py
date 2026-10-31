"""Manual page turns supersede slow work without depending on a model or image."""
from copy import deepcopy
import threading
import unittest
from unittest.mock import patch

from story_agent.server import APIError, Playground


def navigation(state, request="next-1"):
    return {"sessionId": state["sessionId"], "version": state["version"], "requestId": request}


class NavigationTests(unittest.TestCase):
    def test_next_uses_authored_default_once_without_any_model(self):
        app = Playground()
        start = app.create("mock")
        with patch.object(app.sessions[start["sessionId"]].engine.provider, "complete",
                          side_effect=AssertionError("No model needed for manual next")):
            next_page = app.advance(navigation(start))
            self.assertEqual(app.advance(navigation(start)), next_page)
        self.assertEqual(next_page["sceneId"], "house1_predict")
        self.assertEqual(next_page["selection"]["choiceId"], start["question"]["choices"][0]["id"])
        self.assertTrue(next_page["diagnostics"]["manualNavigation"]["skippedQuestion"])
        self.assertEqual(app.sessions[start["sessionId"]].turns, 1)

    def test_next_during_a_slow_answer_does_not_wait_or_accept_its_late_result(self):
        app = Playground()
        start = app.create("mock")
        old_session = app.sessions[start["sessionId"]]
        original = old_session.engine.answer
        entered, release = threading.Event(), threading.Event()
        errors = []

        def slow(*args, **kwargs):
            result = original(*args, **kwargs)
            entered.set()
            release.wait(5)
            return result

        def submit():
            try:
                app.answer({**navigation(start, "slow-answer"), "questionId": start["question"]["id"],
                            "answer": "paper", "choiceId": start["question"]["choices"][0]["id"]})
            except APIError as error:
                errors.append(error.code)

        with patch.object(old_session.engine, "answer", side_effect=slow):
            thread = threading.Thread(target=submit)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                first = app.advance(navigation(start))
                second = app.advance(navigation(first, "next-2"))
                self.assertEqual(second["sceneId"], "house1_reflect")
            finally:
                release.set()
                thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ["turn_cancelled"])
        self.assertEqual(app.sessions[start["sessionId"]].snapshot, second)

    def test_late_next_recovers_the_already_approved_page_instead_of_skipping_two(self):
        app = Playground()
        start = app.create("mock")
        first = app.advance(navigation(start))
        recovered = app.advance(navigation(start, "late-next"))
        self.assertEqual(recovered["version"], first["version"])
        self.assertEqual(recovered["sceneId"], first["sceneId"])
        self.assertFalse(recovered["diagnostics"]["manualNavigation"]["skippedQuestion"])
        before = deepcopy(app.sessions[start["sessionId"]].snapshot)
        for bad in ({}, {**navigation(first), "version": True}, {**navigation(first), "version": 999}):
            with self.subTest(bad=bad), self.assertRaises(APIError):
                app.advance(bad)
        self.assertEqual(app.sessions[start["sessionId"]].snapshot, before)
