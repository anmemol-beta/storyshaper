"""Prepare an image-to-video request locally; never sends a request or reads keys."""
import argparse
import base64
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    scene = json.loads((root / 'media/paper-wind.json').read_text(encoding='utf-8'))
    source = root / scene['sourceImage']
    image = source.read_bytes()
    payload = {
        'model': 'gen4_turbo',
        'promptImage': 'data:image/jpeg;base64,' + base64.b64encode(image).decode('ascii'),
        'promptText': scene['prompt'],
        'ratio': '1280:720',
        'duration': 5,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents replacing a previous experiment's evidence.
    with (args.out / 'request.json').open('x', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
    evidence = {
        'status': 'prepared_not_submitted',
        'sourceImage': scene['sourceImage'],
        'sourceSha256': hashlib.sha256(image).hexdigest(),
        'sceneKey': scene['sceneKey'],
        'model': payload['model'],
        'durationSeconds': payload['duration'],
        'generationExecuted': False,
        'quality': 'unmeasured',
        'latencySeconds': None,
        'actualCostUsd': None,
        'proposedGenerationCostUsd': 0.25,
        'costBasis': '5 seconds x 5 credits/second x $0.01/credit; tax excluded',
    }
    with (args.out / 'evidence.json').open('x', encoding='utf-8') as stream:
        json.dump(evidence, stream, ensure_ascii=False, indent=2)
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
