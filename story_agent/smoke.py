"""Check a real text-only story turn without printing credentials.

Run: python3 -m story_agent.smoke --language ko
Use --mock to check the local flow without sending a model request.
"""
import argparse
import json
import os
from pathlib import Path

from .engine import MockProvider, StoryEngine
from .provider import MetaProvider, load_env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', choices=('en', 'ko'), default='ko')
    parser.add_argument('--mock', action='store_true')
    args = parser.parse_args()
    load_env(Path(__file__).resolve().parent.parent / '.env')
    key = os.environ.get('MODEL_API_KEY', '')
    if not args.mock and not key:
        print(json.dumps({'ok': False, 'code': 'missing_api_key'}))
        return 2
    provider = MockProvider() if args.mock else MetaProvider(
        key, os.environ.get('STORY_AGENT_MODEL', 'muse-spark-1.3'))
    engine = StoryEngine(provider, args.language)
    initial = engine.start('local-smoke-test')
    answer = '과자로 집을 만들래요' if args.language == 'ko' else 'Build with cookies'
    result = engine.answer(initial, answer)
    verified = (result['decision'] == 'accept'
                and result['diagnostics'].get('phase') == 'review'
                and result['diagnostics'].get('authoredFallback') is False)
    print(json.dumps({
        'ok': verified, 'mode': result['providerMode'],
        'liveVerified': verified and not args.mock,
        'decision': result['decision'], 'reason': result['reason'],
        'diagnostics': result['diagnostics'], 'lines': result['lines'],
        'question': result['question']['text'] if result['question'] else None,
    }, ensure_ascii=False, indent=2))
    return 0 if verified else 1


if __name__ == '__main__':
    raise SystemExit(main())
