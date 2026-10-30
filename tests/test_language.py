"""Language changes affect presentation, never the chosen story branch."""
from copy import deepcopy
from itertools import product
import unittest

from story_agent.engine import MockProvider, StoryEngine, STORIES


class RecordingProvider(MockProvider):
    story_pipeline = "legacy_three_call"  # Preserve old phase-specific adversarial fixtures.
    def __init__(self, alter=None):
        self.calls = []
        self.alter = alter

    def complete(self, instructions, payload):
        self.calls.append((instructions, deepcopy(payload)))
        result = super().complete(instructions, payload)
        if self.alter and payload['phase'] == 'compose':
            return self.alter(result)
        return result


class LanguageTests(unittest.TestCase):
    def assert_korean(self, snapshot):
        self.assertEqual(snapshot['language'], 'ko')
        self.assertEqual(snapshot['storyState']['language'], 'ko')
        texts = [line['text'] for line in snapshot['lines']]
        if snapshot['question']:
            texts.append(snapshot['question']['text'])
            for choice in snapshot['question']['choices']:
                texts.extend((choice['label'], choice['answer']))
        for text in texts:
            self.assertRegex(text, '[가-힣]')
            self.assertNotRegex(text, '[A-Za-z]')
        if snapshot['mediaPlan']:
            self.assertEqual(snapshot['mediaPlan']['language'], 'ko')
            self.assertEqual(snapshot['mediaPlan']['narration'], snapshot['lines'])

    def test_korean_metadata_keeps_language_independent_rules(self):
        self.assertEqual(STORIES['en']['storyId'], STORIES['ko']['storyId'])
        self.assertEqual(STORIES['en']['fixedCharacters'], STORIES['ko']['fixedCharacters'])
        self.assertEqual(STORIES['en']['fixedEvents'], STORIES['ko']['fixedEvents'])
        for english, korean in zip(STORIES['en']['houses'], STORIES['ko']['houses']):
            for key in ('id', 'pigId', 'allowedMaterials', 'defaultChoices'):
                self.assertEqual(english[key], korean[key])
        for material, english in STORIES['en']['materials'].items():
            self.assertEqual(english['outcome'], STORIES['ko']['materials'][material]['outcome'])

    def test_choices_use_three_short_keywords_and_keep_executable_full_answers(self):
        for language, material in product(('en', 'ko'), ('paper', 'straw', 'wood', 'cookie', 'icecream')):
            with self.subTest(language=language, material=material):
                engine = StoryEngine(MockProvider(), language)
                state = engine.start('keyword-choices')
                for turn in range(9):
                    choices = state['question']['choices']
                    self.assertEqual(len(choices), 3)
                    self.assertEqual(len({choice['label'] for choice in choices}), 3)
                    for choice in choices:
                        self.assertLessEqual(len(choice['label'].split()), 3)
                        self.assertNotRegex(choice['label'], r'[.!?。！？]')
                        self.assertNotEqual(choice['label'], choice['answer'])
                    if turn == 0:
                        state = engine.answer(state, material)
                    else:
                        state = engine.answer(state, '', choice_id=choices[0]['id'])
                    self.assertIn(state['decision'], ('accept', 'complete'), state)
                self.assertEqual(state['decision'], 'complete')

    def test_all_fifty_korean_paths_have_localized_narrative_questions_choices_and_ending(self):
        engine = StoryEngine(MockProvider(), 'ko')
        early = ('종이', '짚', '나무', '과자', '아이스크림')
        for materials in product(early, early, ('벽돌', '돌')):
            with self.subTest(materials=materials):
                state = engine.start('korean-path')
                self.assert_korean(state)
                for material in materials:
                    state = engine.answer(state, material)
                    self.assertEqual(state['decision'], 'accept', state)
                    self.assert_korean(state)
                    for _ in range(2):
                        # The default choices must be executable without a model.
                        choice = state['question']['choices'][0]
                        state = engine.answer(state, '', choice_id=choice['id'])
                        self.assertIn(state['decision'], ('accept', 'complete'), state)
                        self.assert_korean(state)
                self.assertEqual(state['decision'], 'complete')
                self.assertEqual(state['version'], 9)
                self.assertEqual(state['storyState']['events'][-1], 'wolf_leaves')

    def test_english_and_korean_answers_share_the_same_korean_output(self):
        for answer in ('cookie', '과자로 만들래요'):
            provider = RecordingProvider()
            engine = StoryEngine(provider, 'ko')
            result = engine.answer(engine.start('bilingual'), answer)
            self.assertEqual(result['decision'], 'accept')
            self.assertEqual(result['storyState']['houses'][0]['material'], 'cookie')
            self.assert_korean(result)
            self.assertEqual([payload['phase'] for _, payload in provider.calls], ['interpret', 'compose', 'review'])
            self.assertTrue(all(payload['language'] == 'ko' for _, payload in provider.calls))
            self.assertIn('Korean', provider.calls[1][0])
            self.assertIn('Korean', provider.calls[2][0])

    def test_korean_brick_is_not_mistaken_for_stone(self):
        engine = StoryEngine(MockProvider(), 'ko')
        state = engine.start('last-house')
        for material in ('종이', '나무'):
            for answer in (material, '집이 무너질 것 같아요', '벽이 튼튼해요'):
                state = engine.answer(state, answer)
        result = engine.answer(state, '벽돌로 지을래요')
        self.assertEqual(result['decision'], 'accept')
        self.assertEqual(result['storyState']['houses'][-1]['material'], 'brick')

    def test_korean_unusable_material_immediately_invites_touch(self):
        engine = StoryEngine(MockProvider(), 'ko')
        failed = engine.answer(engine.start('materials'), '마그네슘')
        self.assertEqual(failed['lines'][0]['text'],
                         '이 집을 지을 재료가 필요해요. 이번에는 그림을 보고 마음에 드는 것을 톡 눌러 줘요!')
        self.assertTrue(failed['choiceMode'])
        self.assert_korean(failed)
        self.assertEqual(engine.answer(engine.start('sticks'), '나뭇가지')['storyState']['houses'][0]['material'],
                         'wood')

    def test_korean_retry_and_service_errors_preserve_failure_counts(self):
        engine = StoryEngine(MockProvider(), 'ko')
        state = engine.start('retries')
        for answer in ('', '벽돌', '모르겠어요'):
            state = engine.answer(state, answer)
            self.assert_korean(state)
        self.assertEqual(state['attempts'], 3)
        self.assertTrue(state['choiceMode'])

        class Outage:
            mode = 'live'
            def complete(self, *_):
                raise TimeoutError('unavailable')
        failed = StoryEngine(Outage(), 'ko').answer(state, '과자')
        self.assertEqual(failed['decision'], 'service_error')
        self.assertEqual(failed['attempts'], 3)
        self.assertEqual(failed['version'], state['version'])
        self.assert_korean(failed)

    def test_switch_at_every_stage_preserves_progress_without_model_calls(self):
        provider = RecordingProvider()
        engine = StoryEngine(provider)
        state = engine.start('toggle')
        for turn in range(10):
            before = deepcopy(state)
            count = len(provider.calls)
            korean = engine.change_language(state, 'ko')
            self.assertEqual(len(provider.calls), count)
            self.assertEqual(state, before)
            self.assert_korean(korean)
            self.assertEqual(korean['version'], before['version'] + 1)
            self.assertEqual(korean['storyState']['houses'], before['storyState']['houses'])
            self.assertEqual(korean['storyState']['events'], before['storyState']['events'])
            self.assertEqual(korean['sceneId'], before['sceneId'])
            self.assertEqual(korean['attempts'], before['attempts'])
            self.assertTrue(korean['diagnostics']['languageChanged'])
            self.assertTrue(korean['diagnostics']['authoredFallback'])
            english = engine.change_language(korean, 'en')
            self.assertEqual(len(provider.calls), count)
            self.assertEqual(english['storyState'], before['storyState'])
            self.assertEqual(english['lines'], before['lines'])
            self.assertEqual(english['question'], before['question'])
            self.assertEqual(engine.change_language(english, 'en'), english)
            if not english['question']:
                self.assertEqual(turn, 9)
                break
            state = engine.answer(english, '', choice_id=english['question']['choices'][0]['id'])

    def test_toggle_preserves_retry_choices_and_authored_fallback_on_outage(self):
        engine = StoryEngine(MockProvider())
        state = engine.start('retry-toggle')
        for _ in range(3):
            state = engine.answer(state, '')
        localized = engine.change_language(state, 'ko')
        self.assertEqual(localized['attempts'], 3)
        self.assertTrue(localized['choiceMode'])
        self.assertEqual(localized['decision'], 'clarify')
        self.assert_korean(localized)
        accepted = engine.answer(localized, '', choice_id='cookie')
        self.assertEqual(accepted['decision'], 'accept')
        self.assert_korean(accepted)

    def test_invalid_generated_language_premise_cast_and_schema_are_rejected(self):
        def wrong_language(result):
            result['lines'][0]['text'] = 'The pig builds a cookie house.'
            return result
        def wrong_premise(result):
            result['question']['text'] = '과자집이 바람에 날아갔어요. 왜 날아갔을까요?'
            return result
        def missing_cause(result):
            result['question']['text'] = '과자집에 무슨 일이 생길까요?'
            return result
        def added_cast(result):
            result['lines'][0]['text'] = '개미가 과자집에 찾아왔어요.'
            return result
        def unsafe(result):
            result['lines'][0]['text'] = '늑대가 돼지를 먹고 과자집에 갔어요.'
            return result
        def bad_schema(_):
            return {'lines': '잘못된 형식', 'question': None}
        for change in (wrong_language, wrong_premise, missing_cause, added_cast, unsafe, bad_schema):
            with self.subTest(change=change.__name__):
                provider = RecordingProvider(change)
                engine = StoryEngine(provider, 'ko')
                start = engine.start('invalid')
                result = engine.answer(start, '과자')
                self.assertEqual(result['decision'], 'service_error', result)
                self.assertEqual(result['diagnostics']['phase'], 'compose')
                self.assertEqual(result['storyState'], start['storyState'])
                self.assertEqual(result['attempts'], 0)
                self.assertEqual(len(provider.calls), 2)
                self.assert_korean(result)

    def test_korean_required_event_must_match_the_active_material(self):
        def wrong_event(result):
            result['lines'] = [{'speakerId': 'narrator', 'text': '과자집은 튼튼하게 서 있었어요.'}]
            return result
        engine = StoryEngine(MockProvider(), 'ko')
        predict = engine.answer(engine.start('event'), '과자')
        result = StoryEngine(RecordingProvider(wrong_event), 'ko').answer(predict, '먹을 거예요')
        self.assertEqual(result['decision'], 'service_error')
        self.assertEqual(result['diagnostics']['phase'], 'compose')
        self.assertEqual(result['storyState'], predict['storyState'])

    def test_unsupported_language_is_explicit(self):
        for language in ('fr', None, ['ko']):
            with self.subTest(language=language), self.assertRaises(ValueError):
                StoryEngine(MockProvider(), language)
        engine = StoryEngine(MockProvider())
        with self.assertRaises(ValueError):
            engine.change_language(engine.start('invalid'), 'fr')


if __name__ == '__main__':
    unittest.main()
