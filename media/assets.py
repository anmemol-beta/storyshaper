"""Exact scene lookup. Missing art is a fallback, never an unrelated material."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class AssetRegistry:
    def __init__(self, data=None, root=ROOT):
        self.root = Path(root).resolve()
        self.data = data if data is not None else json.loads(
            Path(__file__).with_name('scene_registry.json').read_text(encoding='utf-8'))

    def _asset(self, entry, kind):
        if not entry:
            return None
        directory = 'img' if kind == 'image' else 'video'
        base = (self.root / 'prototype' / directory).resolve()
        path = (base / entry['file']).resolve()
        suffixes = {'.jpg', '.png', '.webp'} if kind == 'image' else {'.mp4'}
        if not path.is_relative_to(base) or path.suffix not in suffixes or not path.is_file():
            return None
        if kind == 'video' and entry.get('reviewed') is not True:
            return None
        return {'url': f'/prototype/{directory}/{path.relative_to(base).as_posix()}',
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'cast': list(entry.get('cast', []))}

    def image(self, spec):
        return self._asset(self.data['images'].get(spec.asset_key), 'image')

    def clip(self, spec):
        # Outcome is not a playback trigger: build/transition/ending never play a clip.
        if spec.action not in {'blown_away', 'collapsed', 'eaten', 'melted', 'stood'}:
            return None
        return self._asset(self.data.get('clips', {}).get(spec.asset_key), 'video')

    def content_key(self, spec):
        record = {'story': spec.story_id, 'sceneAsset': spec.asset_key,
                  'registry': self.data['revision'], 'provider': 'local-reviewed-v1',
                  'image': self.image(spec), 'clip': self.clip(spec)}
        return hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()


class LocalProvider:
    """No network calls. Only registry-listed reviewed clips can be returned."""
    def __init__(self, registry):
        self.registry = registry

    def resolve(self, spec, cancelled):
        if cancelled.is_set():
            return None
        return self.registry.clip(spec)
