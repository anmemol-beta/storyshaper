"""Bounded, reviewed media jobs with idempotent, explicit image retries."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
import threading
import uuid

from .assets import AssetRegistry, LocalProvider
from .contracts import normalize
from .image_provider import MAX_IMAGE, ImageError, scene_facts

MAX_IMAGE_RETRIES = 2


class JobError(ValueError):
    pass


class MediaJobs:
    def __init__(self, registry=None, provider=None, timeout=15, capacity=256,
                 image_provider=None, image_timeout=120):
        self.registry = registry or AssetRegistry()
        self.provider = provider or LocalProvider(self.registry)
        self.timeout, self.capacity = timeout, capacity
        self.image_provider, self.image_timeout = image_provider, image_timeout
        self.images, self.last_images = {}, {}
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

    def request(self, snapshot, *, retry_of=None):
        spec = normalize(snapshot)
        self.activate(snapshot)
        if spec is None:
            return {'status': 'no_new_media', 'jobId': None, 'apply': False}
        with self.lock:
            if self.closed:
                raise JobError('closed')
            if self.current.get(spec.session_id) != spec.token:
                raise JobError('stale_snapshot')
            previous = self.jobs.get(self.requests.get(spec.token))
            retry_attempt = 0
            if retry_of is not None:
                original = self.jobs.get(retry_of)
                if original is None or original['spec'].session_id != spec.session_id:
                    raise JobError('job_not_found')
                if original['spec'].token != spec.token or previous is None:
                    raise JobError('retry_not_allowed')
                # A repeated click, lost response or old retry token attaches to
                # the latest replacement instead of starting another paid call.
                if previous['id'] != retry_of:
                    return self._view(previous)
                work = previous['work']
                if previous['cancelled'] or work['status'] == 'cancelled':
                    raise JobError('retry_not_allowed')
                if work['status'] != 'failed' or not work['live_image']:
                    return self._view(previous)
                retry_attempt = work['retry_attempt'] + 1
                if retry_attempt > MAX_IMAGE_RETRIES:
                    raise JobError('image_retry_limit')
            elif previous is not None:
                return self._view(previous)
            # Keep dedup tombstones rather than evict then resubmit the same turn.
            if len(self.jobs) >= self.capacity:
                raise JobError('job_limit')
            # Touch answers are authored and server-validated. Use the same exact
            # scene art as offline mode, without waiting for a worker or model.
            prepared_image = self.registry.image(spec)
            prepared_choice = spec.selection is not None and prepared_image is not None
            live_image = (not prepared_choice and self.image_provider is not None
                          and snapshot.get('providerMode') == 'live')
            plan = snapshot['mediaPlan']
            # No cross-session reuse of generated content. A language-only version
            # change reuses this same accepted scene, including an in-flight request.
            key = (hashlib.sha256(json.dumps([spec.session_id, scene_facts(spec, plan)],
                                            sort_keys=True).encode()).hexdigest() if live_image
                   else self.registry.content_key(spec))
            if prepared_choice:
                # A local video fallback for a free answer must not mask a ready
                # touch image, even when both refer to the same static asset.
                key = ('prepared_choice', key)
            job_id = uuid.uuid4().hex
            # Local work may restart for a new binding. Paid image work retains
            # its cancellation tombstone even across language-only versions.
            reused = retry_of is None and key in self.works and (live_image or self.works[key]['status'] != 'cancelled')
            if not reused:
                if retry_of is not None:
                    old_work = previous['work']
                    old_work['event'].set()
                    old_work['timer'].cancel()
                    for old_job in self.jobs.values():
                        if old_job['work'] is old_work:
                            old_job['cancelled'] = old_job['cancelled'] or 'retried'
                self.works[key] = {'spec': spec, 'status': 'queued', 'video': None,
                                   'reason': None, 'event': threading.Event(), 'timer': None,
                                   'live_image': live_image, 'prepared_choice': prepared_choice,
                                   'plan': deepcopy(plan), 'image': None,
                                   'retry_attempt': retry_attempt}
            work = self.works[key]
            job = {'id': job_id, 'spec': spec, 'key': key,
                   'image': prepared_image, 'cancelled': None, 'reused': reused,
                   'work': work}
            self.jobs[job_id] = job
            self.requests[spec.token] = job_id
            if prepared_choice:
                work['status'], work['reason'] = 'ready', 'prepared_choice_image'
            elif not reused:
                # Workers and timers hold this exact work instance. A late callback
                # from a cancelled generation must never resolve the replacement.
                timer = threading.Timer(self.image_timeout if live_image else self.timeout,
                                        self._expire, args=(work,))
                timer.daemon = True
                work['timer'] = timer
                timer.start()
                self.pool.submit(self._run, work)
            return self._view(job)

    def _run(self, work):
        with self.lock:
            if work['status'] != 'queued':
                return
            work['status'] = 'running'
        try:
            if work['live_image']:
                self._generate_image(work)
                return
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
        except Exception as exc:
            with self.lock:
                if work['status'] == 'running':
                    work['status'], work['reason'] = 'failed', str(exc) if isinstance(exc, ImageError) else 'provider_error'
        finally:
            with self.lock:
                work['timer'].cancel()

    def _generate_image(self, work):
        spec = work['spec']
        with self.lock:
            prior = self.last_images.get((spec.session_id, spec.house_id))
        if prior and spec.action not in {'build', 'move_to_next_house'}:
            source = prior[1]
        else:
            images = self.registry.data['images']
            if spec.action == 'move_to_next_house':
                key = f'{spec.target_house_id}/choose'
            elif spec.action == 'safe_ending':
                key = 'ending'
            elif spec.action == 'build':
                key = f'{spec.house_id}/choose'
            else:
                key = f'{spec.house_id}/{spec.material}/build'
                if key not in images:
                    key = f'{spec.house_id}/choose'
            asset = self.registry._asset(images.get(key), 'image')
            if asset is None:
                raise JobError('reference_unavailable')
            source = (self.registry.root / asset['url'].lstrip('/')).read_bytes()
        references = [source]
        if spec.action in {'blown_away', 'collapsed', 'eaten', 'stood'}:
            references.append((self.registry.root / 'prototype/img/wolf_paper.jpg').read_bytes())
        image = self.image_provider.generate(spec, work['plan'], references, work['event'])
        # The provider decodes and independently reviews pixels before this point.
        if not isinstance(image, bytes) or not image.startswith(b'\xff\xd8') or len(image) > MAX_IMAGE:
            raise JobError('invalid_generated_image')
        with self.lock:
            if work['status'] != 'running' or work['event'].is_set():
                return
            image_id = uuid.uuid4().hex
            self.images[image_id] = (spec.session_id, image)
            work['image'] = {'url': f'/api/media/images/{image_id}?sessionId={spec.session_id}',
                             'sha256': hashlib.sha256(image).hexdigest(),
                             'cast': scene_facts(spec, work['plan'])['cast'], 'reviewed': True}
            previous = self.last_images.get((spec.session_id, spec.house_id))
            if previous is None or previous[0] < spec.version:
                self.last_images[(spec.session_id, spec.house_id)] = (spec.version, image)
            work['status'], work['reason'] = 'ready', 'generated_image_reviewed'

    def image(self, image_id, session_id):
        with self.lock:
            record = self.images.get(image_id)
            if record is None or record[0] != session_id:
                raise JobError('image_not_found')
            return record[1]

    def _expire(self, work):
        with self.lock:
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
            work = job['work']
            # One client cannot cancel another session's binding to public local content.
            if not any(other['work'] is work and not other['cancelled']
                       for other in self.jobs.values()):
                if work['status'] in {'queued', 'running'}:
                    work['event'].set()
                    work['timer'].cancel()
                    work['status'], work['reason'] = 'cancelled', 'user_cancelled'
            return self._view(job)

    def _view(self, job):
        spec, work = job['spec'], job['work']
        current = self.current.get(spec.session_id) == spec.token
        status = 'cancelled' if job['cancelled'] else work['status']
        applicable = current and status != 'cancelled'
        reason = job['cancelled'] or work['reason']
        generated = applicable and work['image'] is not None
        image = work['image'] if generated else job['image']
        if status == 'ready' and job['reused'] and not work['live_image'] and not work['prepared_choice']:
            reason = 'cached_reviewed_clip'
        elif status == 'fallback' and not job['image']:
            reason = 'scene_asset_unavailable'
        message = ('A picture for this material is not available. Keep reading with the reference picture.'
                   if image is None else 'Continue with the picture while video is unavailable.')
        if work['live_image']:
            message = ('Continue with the new picture.' if generated else
                       'The new picture is unavailable. Keep reading with the previous or prepared picture.')
        elif work['prepared_choice']:
            message = 'Continue with the prepared picture for this choice.'
        return {'jobId': job['id'], 'sessionId': spec.session_id,
                'sceneId': spec.scene_id, 'version': spec.version,
                'status': status, 'reason': reason, 'apply': applicable,
                'image': deepcopy(image) if applicable else None,
                'video': deepcopy(work['video']) if applicable and status == 'ready' else None,
                'fallback': {'keepCurrentImage': image is None, 'message': message},
                'source': 'muse_image' if generated else 'prepared_choice' if work['prepared_choice'] else 'local_assets',
                'generated': generated,
                'generationRequested': work['live_image'],
                'generationRetryAvailable': applicable and work['live_image'] and status == 'failed'
                    and work['retry_attempt'] < MAX_IMAGE_RETRIES,
                'retriesRemaining': max(0, MAX_IMAGE_RETRIES - work['retry_attempt']) if work['live_image'] else 0,
                'spec': asdict(spec)}

    def close(self):
        with self.lock:
            self.closed = True
            for job in self.jobs.values():
                job['cancelled'] = job['cancelled'] or 'shutdown'
            for work in self.works.values():
                work['event'].set()
                if work['timer'] is not None:
                    work['timer'].cancel()
        self.pool.shutdown(wait=True, cancel_futures=True)
