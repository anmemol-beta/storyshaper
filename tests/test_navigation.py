"""Manual page turns supersede slow work without depending on a model or image."""
from copy import deepcopy
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from story_agent.server import APIError, Playground


def navigation(state, request="next-1"):
    return {"sessionId": state["sessionId"], "version": state["version"], "requestId": request}


def reanswer(head, earlier, answer='straw', request='answer-again'):
    return {'sessionId':head['sessionId'], 'version':head['version'],
            'revisitVersion':earlier['version'], 'questionId':earlier['question']['id'],
            'requestId':request, 'answer':answer}


class NavigationTests(unittest.TestCase):
    def test_a_revisited_question_can_replace_the_skipped_default_with_a_new_answer(self):
        app = Playground()
        start = app.create('mock')
        skipped = app.advance(navigation(start))
        result = app.answer({'sessionId':start['sessionId'], 'version':skipped['version'],
                             'revisitVersion':start['version'], 'questionId':start['question']['id'],
                             'requestId':'answer-again', 'answer':'straw'})
        self.assertEqual(result['sceneId'], 'house1_predict')
        self.assertEqual(result['storyState']['houses'][0]['material'], 'straw')
        self.assertGreater(result['version'], skipped['version'])

    def test_reanswer_from_the_ending_discards_later_houses_and_cannot_replay_the_old_branch(self):
        app = Playground()
        start = app.create('mock')
        current = start
        discarded = []
        for turn in range(9):
            current = app.advance(navigation(current, f'next-{turn}'))
            discarded.append(current)
        self.assertIsNone(current['question'])
        body = reanswer(current, start)
        changed = app.answer(body)
        self.assertEqual(app.answer(body), changed, 'A lost response cannot create another branch')
        self.assertEqual(len(changed['storyState']['houses']), 1)
        self.assertEqual(changed['storyState']['events'], [])
        self.assertEqual(changed['storyState']['houses'][0]['material'], 'straw')
        self.assertGreater(changed['version'], current['version'])
        self.assertNotIn(discarded[0]['version'], app.sessions[start['sessionId']].checkpoints)
        for invalid in (reanswer(changed, discarded[0], request='discarded'),
                        {**body, 'requestId':'stale'},
                        {**body, 'requestId':'answer-again', 'answer':'wood'}):
            with self.subTest(invalid=invalid['requestId']), self.assertRaises(APIError):
                app.answer(invalid)
        with self.assertRaisesRegex(APIError, 'stale_question'):
            app.advance(navigation(start, 'next-0'))
        self.assertEqual(app.sessions[start['sessionId']].snapshot, changed)

    def test_reanswer_validates_the_saved_question_and_resets_only_the_new_attempts_choice_lock(self):
        app = Playground()
        start = app.create('mock')
        failed = app.answer({**navigation(start, 'unclear'), 'questionId':start['question']['id'], 'answer':'unknown answer'})
        self.assertTrue(failed['choiceMode'])
        skipped = app.advance(navigation(failed))
        before = deepcopy(app.sessions[start['sessionId']].snapshot)
        for changes in ({'revisitVersion':True}, {'revisitVersion':-1}, {'revisitVersion':skipped['version']},
                        {'questionId':'invented_question'}, {'choiceId':'invented_choice'}):
            with self.subTest(changes=changes), self.assertRaises(APIError):
                app.answer({**reanswer(skipped, failed), **changes})
        self.assertEqual(app.sessions[start['sessionId']].snapshot, before)
        changed = app.answer(reanswer(skipped, failed))
        self.assertFalse(changed['choiceMode'])
        self.assertEqual(changed['storyState']['houses'][0]['material'], 'straw')
        again = app.answer({**navigation(changed, 'new-failure'), 'questionId':changed['question']['id'], 'answer':''})
        self.assertTrue(again['choiceMode'], 'A first failure in the new branch still requires touch choices')

    def test_saved_checkpoints_allow_reanswering_after_restart_and_preserve_language(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'STORY_SESSION_DIR':folder}):
            app = Playground()
            start = app.create('mock', 'ko')
            first = app.advance(navigation(start))
            changed = Playground().answer(reanswer(first, start, '짚'))
            self.assertEqual(changed['language'], 'ko')
            localized = Playground().change_language({'sessionId':changed['sessionId'], 'version':changed['version'], 'language':'en'})
            self.assertEqual(localized['branchId'], changed['branchId'])
            again = Playground().answer(reanswer(localized, start, '나무', 'again'))
            self.assertEqual(again['language'], 'ko')
            self.assertEqual(again['storyState']['houses'][0]['material'], 'wood')
            self.assertNotEqual(again['branchId'], changed['branchId'])

    def test_checkpoint_limit_retains_the_latest_question_for_each_earlier_scene(self):
        app = Playground()
        start = app.create('mock')
        current = app.advance(navigation(start))
        with patch('story_agent.server.MAX_CHECKPOINTS', 4):
            for index in range(10):
                current = app.change_language({'sessionId':current['sessionId'], 'version':current['version'],
                                               'language':'ko' if index % 2 == 0 else 'en'})
            self.assertLessEqual(len(app.sessions[start['sessionId']].checkpoints), 4)
            self.assertIn(start['version'], app.sessions[start['sessionId']].checkpoints)
            changed = app.answer(reanswer(current, start))
        self.assertEqual(changed['storyState']['houses'][0]['material'], 'straw')

    def test_reanswer_interrupts_a_slow_old_answer_and_its_late_result_cannot_commit(self):
        app = Playground()
        start = app.create('mock')
        first = app.advance(navigation(start))
        old = app.sessions[start['sessionId']]
        original = old.engine.answer
        entered, release = threading.Event(), threading.Event()
        errors = []
        def slow(*args, **kwargs):
            result = original(*args, **kwargs)
            entered.set()
            release.wait(3)
            return result
        def submit():
            try:
                app.answer({**navigation(first, 'slow'), 'questionId':first['question']['id'], 'answer':'Let us watch carefully together.'})
            except APIError as error:
                errors.append(error.code)
        with patch.object(old.engine, 'answer', side_effect=slow):
            thread = threading.Thread(target=submit)
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                changed = app.answer(reanswer(first, start))
            finally:
                release.set()
                thread.join(2)
        self.assertEqual(errors, ['turn_cancelled'])
        self.assertEqual(app.sessions[start['sessionId']].snapshot, changed)

    def test_duplicate_reanswers_in_flight_do_not_start_another_branch_or_model_call(self):
        app = Playground()
        start = app.create('mock')
        first = app.advance(navigation(start))
        provider = app.sessions[start['sessionId']].engine.provider
        original = provider.complete
        entered, release = threading.Event(), threading.Event()
        replies = []
        def slow(*args, **kwargs):
            entered.set()
            release.wait(3)
            return original(*args, **kwargs)
        body = reanswer(first, start)
        with patch.object(provider, 'complete', side_effect=slow) as complete:
            thread = threading.Thread(target=lambda:replies.append(app.answer(body)))
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                with self.assertRaisesRegex(APIError, 'turn_in_progress'):
                    app.answer(body)
                self.assertEqual(complete.call_count, 1)
            finally:
                release.set()
                thread.join(2)
        self.assertEqual(app.answer(body), replies[0])
        self.assertEqual(app.sessions[start['sessionId']].turns, 2)

    def test_manual_next_can_interrupt_a_pending_reanswer_without_accepting_its_late_result(self):
        app = Playground()
        start = app.create('mock')
        first = app.advance(navigation(start))
        provider = app.sessions[start['sessionId']].engine.provider
        original = provider.complete
        entered, release = threading.Event(), threading.Event()
        errors = []
        def slow(*args, **kwargs):
            entered.set()
            release.wait(3)
            return original(*args, **kwargs)
        def submit():
            try:
                app.answer(reanswer(first, start))
            except APIError as error:
                errors.append(error.code)
        with patch.object(provider, 'complete', side_effect=slow):
            thread = threading.Thread(target=submit)
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                advanced = app.advance(navigation(first, 'interrupt'))
            finally:
                release.set()
                thread.join(2)
        self.assertEqual(errors, ['turn_cancelled'])
        self.assertEqual(advanced['sceneId'], 'house1_predict')
        self.assertEqual(app.sessions[start['sessionId']].snapshot, advanced)

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
