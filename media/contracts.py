"""Normalize server-issued story snapshots without interpreting a child's answer."""
from copy import deepcopy
from dataclasses import dataclass
from story_agent.engine import STORY, StoryEngine
from story_agent.materials import BEHAVIORS, CUSTOM_MATERIAL, material_meta


class InvalidPlan(ValueError):
    pass


@dataclass(frozen=True)
class MediaSpec:
    session_id: str
    scene_id: str
    version: int
    story_id: str
    house_id: str
    target_house_id: str
    material: str
    action: str
    outcome: str
    material_id: str | None = None
    material_spec: dict | None = None

    @property
    def token(self):
        return self.session_id, self.scene_id, self.version

    @property
    def asset_key(self):
        if self.action == 'move_to_next_house':
            return f'{self.target_house_id}/choose'
        if self.action == 'safe_ending':
            return 'ending'
        return f'{self.house_id}/{self.material_id or self.material}/{self.action}'


def normalize(snapshot):
    """Call only with a snapshot retrieved from the story server, never client JSON."""
    try:
        plan = snapshot.get('mediaPlan')
        if snapshot['decision'] not in {'accept', 'complete'}:
            if plan is not None:
                raise InvalidPlan('nonaccepted_plan')
            return None
        try:
            StoryEngine._validate_snapshot(snapshot)
        except ValueError as exc:
            raise InvalidPlan('invalid_snapshot') from exc
        state = snapshot['storyState']
        index, stage = state['houseIndex'], state['stage']
        if (type(index) is not int or not 1 <= index <= 3
                or stage not in {'choose', 'predict', 'reflect', 'complete'}
                or type(snapshot['version']) is not int or snapshot['version'] < 1
                or not isinstance(snapshot['sessionId'], str) or not snapshot['sessionId']
                or snapshot['diagnostics']['validated'] is not True
                or state['storyId'] != STORY['storyId']
                or plan['storyId'] != STORY['storyId']
                or snapshot['language'] != state['language']
                or plan['language'] != state['language']
                or state['language'] not in {'en', 'ko'}):
            raise InvalidPlan('invalid_snapshot')
        scene = 'ending' if stage == 'complete' else f'house{index}_{stage}'
        if (snapshot['sceneId'] != scene or plan['sceneId'] != scene
                or plan['version'] != snapshot['version'] or type(plan['version']) is not int
                or plan['sessionId'] != snapshot['sessionId']
                or plan['status'] != 'validated_plan_only'
                or plan['allPigsSafe'] is not True
                or plan['characters'] != STORY['fixedCharacters'][1:]
                or plan['houses'] != state['houses']
                or plan['narration'] != snapshot['lines']):
            raise InvalidPlan('inconsistent_plan')
        source_index = index - 1 if stage == 'choose' else index
        if source_index < 1 or (stage == 'complete' and index != 3):
            raise InvalidPlan('invalid_transition')
        material = plan['material']
        house_id = f'house{source_index}'
        houses = state['houses']
        material_id = material_spec = None
        if material == CUSTOM_MATERIAL:
            selected = houses[-1]
            material_spec = selected['materialSpec']
            material_id = selected['materialId']
            meta = material_meta(material_spec, state['language'])
            outcome = BEHAVIORS[material_spec['behavior']]
            if (plan.get('materialSpec') != material_spec
                    or plan.get('materialId') != material_id
                    or plan.get('materialLabel') != meta['label']
                    or plan.get('construction') != meta['build']
                    or (outcome == 'stood') != (source_index == 3)):
                raise InvalidPlan('invalid_custom_material')
        else:
            if material not in STORY['houses'][source_index - 1]['allowedMaterials']:
                raise InvalidPlan('invalid_material')
            if 'materialSpec' in plan or 'materialId' in plan:
                raise InvalidPlan('invalid_material')
            outcome = STORY['materials'][material]['outcome']
        action = {'choose': 'move_to_next_house', 'predict': 'build',
                  'reflect': outcome, 'complete': 'safe_ending'}[stage]
        if (len(houses) != source_index or houses[-1]['houseId'] != house_id
                or houses[-1]['material'] != material or houses[-1]['outcome'] != outcome
                or houses[-1]['resolved'] is not (stage != 'predict')
                or plan['houseId'] != house_id or plan['action'] != action
                or plan['outcome'] != outcome
                or (snapshot['decision'] == 'complete') != (stage == 'complete')):
            raise InvalidPlan('inconsistent_action')
        return MediaSpec(snapshot['sessionId'], scene, snapshot['version'], STORY['storyId'],
                         house_id, f'house{index}', material, action, outcome,
                         material_id, deepcopy(material_spec))
    except (KeyError, TypeError, IndexError, AttributeError) as exc:
        raise InvalidPlan('malformed_plan') from exc
