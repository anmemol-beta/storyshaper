"""Bounded, memory-only local jobs. Paid submission is intentionally not implemented."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import asdict
import threading
import uuid

from .assets import AssetRegistry, LocalProvider
from .contracts import normalize


class JobError(ValueError):
    pass


class MediaJobs:
    def __init__(self, registry=None, provider=None, timeout=15, capacity=256):
        self.registry = registry or AssetRegistry()
        self.provider = provider or LocalProvider(self.registry)
        self.timeout, self.capacity = timeout, capacity
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='local-media')
        self.jobs, self.requests, self.current, self.works = {}, {}, {}, {}
        self.closed = False

    def activate(self, snapshot):
        token = (snapshot['sessionId'], snapshot['sceneId'], snapshot['version'])
        with self.lock:
            prior = self.current.get(token[0])
            if prior and prior[2] > token[2]:
                return
            self.current[token[0]] = token
            for job in self.jobs.values():
                if job['spec'].session_id == token[0] and job['spec'].token != token:
                    # Presentation invalidation does not duplicate shared local work.
                    job['cancelled'] = job['cancelled'] or 'superseded'

    def request(self, snapshot):
        spec = normalize(snapshot)
        self.activate(snapshot)
        if spec is None:
            return {'status': 'no_new_media', 'jobId': None, 'apply': False}
        with self.lock:
            if self.closed:
                raise JobError('closed')
            if self.current.get(spec.session_id) != spec.token:
                raise JobError('stale_snapshot')
            if spec.token in self.requests:
                return self._view(self.jobs[self.requests[spec.token]])
            # Keep dedup tombstones rather than evict then resubmit the same turn.
            if len(self.jobs) >= self.capacity:
                raise JobError('job_limit')
            key = self.registry.content_key(spec)
            job_id = uuid.uuid4().hex
            reused = key in self.works
            job = {'id': job_id, 'spec': spec, 'key': key,
                   'image': self.registry.image(spec), 'cancelled': None, 'reused': reused}
            self.jobs[job_id] = job
            self.requests[spec.token] = job_id
            if not reused:
                work = {'spec': spec, 'status': 'queued', 'video': None, 'reason': None,
                        'event': threading.Event(), 'timer': None}
                self.works[key] = work
                timer = threading.Timer(self.timeout, self._expire, args=(key,))
                timer.daemon = True
                work['timer'] = timer
                timer.start()
                self.pool.submit(self._run, key)
            return self._view(job)

    def _run(self, key):
        with self.lock:
            work = self.works[key]
            if work['status'] != 'queued':
                return
            work['status'] = 'running'
        try:
            clip = self.provider.resolve(work['spec'], work['event'])
            # Only registered, reviewed local assets can become ready in this release.
            if clip is not None and clip != self.registry.clip(work['spec']):
                raise JobError('unreviewed_provider_output')
            with self.lock:
                if work['status'] != 'running' or work['event'].is_set():
                    return
                work['video'] = deepcopy(clip)
                work['status'] = 'ready' if clip else 'fallback'
                work['reason'] = 'reviewed_local_clip' if clip else 'clip_unavailable'
        except Exception:
            with self.lock:
                if work['status'] == 'running':
                    work['status'], work['reason'] = 'failed', 'provider_error'
        finally:
            with self.lock:
                work['timer'].cancel()

    def _expire(self, key):
        with self.lock:
            work = self.works[key]
            if work['status'] in {'queued', 'running'}:
                work['status'], work['reason'] = 'failed', 'timeout'
                work['event'].set()

    def get(self, job_id, session_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job['spec'].session_id != session_id:
                raise JobError('job_not_found')
            return self._view(job)

    def cancel(self, job_id, session_id):
        with self.lock:
            self.get(job_id, session_id)
            job = self.jobs[job_id]
            job['cancelled'] = 'user_cancelled'
            # One client cannot cancel another session's binding to public local content.
            if not any(other['key'] == job['key'] and not other['cancelled']
                       for other in self.jobs.values()):
                work = self.works[job['key']]
                if work['status'] in {'queued', 'running'}:
                    work['event'].set()
                    work['timer'].cancel()
                    work['status'], work['reason'] = 'cancelled', 'user_cancelled'
            return self._view(job)

    def _view(self, job):
        spec, work = job['spec'], self.works[job['key']]
        current = self.current.get(spec.session_id) == spec.token
        status = 'cancelled' if job['cancelled'] else work['status']
        applicable = current and status != 'cancelled'
        reason = job['cancelled'] or work['reason']
        if status == 'ready' and job['reused']:
            reason = 'cached_reviewed_clip'
        elif status == 'fallback' and not job['image']:
            reason = 'scene_asset_unavailable'
        return {'jobId': job['id'], 'sessionId': spec.session_id,
                'sceneId': spec.scene_id, 'version': spec.version,
                'status': status, 'reason': reason, 'apply': applicable,
                'image': deepcopy(job['image']) if applicable else None,
                'video': deepcopy(work['video']) if applicable and status == 'ready' else None,
                'fallback': {'keepCurrentImage': job['image'] is None,
                             'message': 'Continue with the picture while video is unavailable.'},
                'source': 'local_assets', 'generated': False, 'spec': asdict(spec)}

    def close(self):
        with self.lock:
            self.closed = True
            for job in self.jobs.values():
                job['cancelled'] = job['cancelled'] or 'shutdown'
            for work in self.works.values():
                work['event'].set()
                work['timer'].cancel()
        self.pool.shutdown(wait=True, cancel_futures=True)
