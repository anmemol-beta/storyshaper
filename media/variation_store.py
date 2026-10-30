"""Per-story, versioned media intents; NEVER a replacement for the paid Runway ledger.

Temporary story media is scoped to one story run. Shared template art remains
in scene_registry.json; generated variants are NOT automatically published.
"""
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

_SAFE = re.compile(r"^[A-Za-z0-9_./-]{1,128}$")
DEFAULT_STORY_TTL = 7 * 24 * 60 * 60


class VariationStore:
    def __init__(self, filename=".tmp/story-media.sqlite3", clock=None):
        self.path = Path(filename)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), timeout=15)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.clock = clock or time.time
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS story_runs (
            id TEXT PRIMARY KEY, story_id TEXT NOT NULL,
            created_at REAL NOT NULL, expires_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS variants (
            id TEXT PRIMARY KEY,
            story_run_id TEXT NOT NULL REFERENCES story_runs(id),
            scene_key TEXT NOT NULL, story_version INTEGER NOT NULL,
            media_revision INTEGER NOT NULL,
            input_sha TEXT NOT NULL, prompt_sha TEXT NOT NULL,
            request_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL DEFAULT 'requested',
            file_path TEXT, selected INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            UNIQUE(story_run_id,scene_key,media_revision));
        CREATE INDEX IF NOT EXISTS variant_lookup
            ON variants(story_run_id,scene_key,story_version,media_revision);
        """)
        if os.name == "posix":
            os.chmod(self.path, 0o600)

    def start_story(self, story_id, ttl_seconds=DEFAULT_STORY_TTL):
        if not isinstance(story_id, str) or not _SAFE.fullmatch(story_id):
            raise ValueError("invalid_story_id")
        if not 60 <= ttl_seconds <= 365 * 24 * 3600:
            raise ValueError("invalid_retention")
        story_run_id = uuid.uuid4().hex
        now = self.clock()
        with self.db:
            self.db.execute("INSERT INTO story_runs VALUES (?,?,?,?)",
                            (story_run_id, story_id, now, now + ttl_seconds))
        return story_run_id

    @staticmethod
    def _row(row):
        if row is None:
            return None
        cols = ("id", "story_run_id", "scene_key", "story_version", "media_revision",
                "input_sha", "prompt_sha", "request_id", "state", "file_path", "selected")
        return dict(zip(cols, row))

    def get(self, variant_id):
        return self._row(self.db.execute("""SELECT id,story_run_id,scene_key,story_version,
            media_revision,input_sha,prompt_sha,request_id,state,file_path,selected
            FROM variants WHERE id=?""", (variant_id,)).fetchone())

    def request(self, story_run_id, scene_key, story_version, input_sha, prompt_sha,
                request_id, action="reuse"):
        """Same request_id is an HTTP retry; new request_id + regenerate is a new user intent."""
        if action not in ("reuse", "regenerate"):
            raise ValueError("invalid_action")
        if not isinstance(scene_key, str) or not _SAFE.fullmatch(scene_key) or ".." in scene_key:
            raise ValueError("invalid_scene_key")
        if type(story_version) is not int or story_version < 1:
            raise ValueError("invalid_story_version")
        if not all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v)
                   for v in (input_sha, prompt_sha)):
            raise ValueError("invalid_fingerprint")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", request_id):
            raise ValueError("invalid_request_id")
        now = self.clock()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            prior = self.db.execute("SELECT id FROM variants WHERE request_id=?", (request_id,)).fetchone()
            if prior:
                row = self.get(prior[0])
                if (row["story_run_id"],row["scene_key"],row["story_version"],
                    row["input_sha"],row["prompt_sha"]) != (
                        story_run_id,scene_key,story_version,input_sha,prompt_sha):
                    raise ValueError("request_id_conflict")
                self.db.commit()
                return row
            story = self.db.execute("SELECT expires_at FROM story_runs WHERE id=?",
                                    (story_run_id,)).fetchone()
            if not story or story[0] <= now:
                raise ValueError("story_expired_or_missing")
            if action == "reuse":
                row = self.db.execute("""SELECT id FROM variants WHERE
                    story_run_id=? AND scene_key=? AND story_version=?
                    AND input_sha=? AND prompt_sha=?
                    AND state IN ('requested','downloaded','reviewed')
                    ORDER BY media_revision DESC LIMIT 1""",
                    (story_run_id,scene_key,story_version,input_sha,prompt_sha)).fetchone()
                if row:
                    self.db.commit()
                    return self.get(row[0])
            revision = self.db.execute("""SELECT COALESCE(MAX(media_revision),0)+1
                FROM variants WHERE story_run_id=? AND scene_key=?""",
                (story_run_id,scene_key)).fetchone()[0]
            variant_id = uuid.uuid4().hex
            self.db.execute("""INSERT INTO variants(id,story_run_id,scene_key,story_version,
                media_revision,input_sha,prompt_sha,request_id,state,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)""", (variant_id,story_run_id,scene_key,
                story_version,revision,input_sha,prompt_sha,request_id,"requested",now))
            self.db.commit()
            return self.get(variant_id)
        except Exception:
            self.db.rollback()
            raise

    def review(self, variant_id, file_path, *, approve, ledger=None):
        """Human review. Requires downloaded Runway ledger match; never touches global registry."""
        variant = self.get(variant_id)
        if not variant or variant["state"] != "requested":
            raise ValueError("variant_not_reviewable")
        if not approve:
            with self.db:
                self.db.execute("UPDATE variants SET state='rejected' WHERE id=?", (variant_id,))
            return self.get(variant_id)
        if ledger is None:
            raise ValueError("ledger_required")
        run = ledger.get(variant_id)
        if run["state"] != "downloaded" or not run["file_path"] or \
                os.path.realpath(run["file_path"]) != os.path.realpath(file_path):
            raise ValueError("download_not_verified")
        from .runway_api import validate_mp4
        validate_mp4(Path(file_path))
        now = self.clock()
        with self.db:
            story = self.db.execute("SELECT expires_at FROM story_runs WHERE id=?",
                                    (variant["story_run_id"],)).fetchone()
            if not story or story[0] <= now:
                raise ValueError("story_expired_or_missing")
            newest = self.db.execute("""SELECT MAX(media_revision) FROM variants
                WHERE story_run_id=? AND scene_key=?""",
                (variant["story_run_id"],variant["scene_key"])).fetchone()[0]
            current = newest == variant["media_revision"]
            if current:
                self.db.execute("""UPDATE variants SET selected=0 WHERE
                    story_run_id=? AND scene_key=?""",
                    (variant["story_run_id"],variant["scene_key"]))
            self.db.execute("""UPDATE variants SET state='reviewed',file_path=?,selected=?
                WHERE id=?""", (str(Path(file_path).resolve()),int(current),variant_id))
        return self.get(variant_id)

    def selected(self, story_run_id, scene_key, story_version):
        now = self.clock()
        row = self.db.execute("""SELECT v.id FROM variants v JOIN story_runs s
            ON s.id=v.story_run_id WHERE v.story_run_id=? AND v.scene_key=?
            AND v.story_version=? AND v.selected=1 AND v.state='reviewed'
            AND s.expires_at>?""", (story_run_id,scene_key,story_version,now)).fetchone()
        return self.get(row[0]) if row else None

    def select(self, story_run_id, scene_key, story_version, variant_id):
        """Manually switch between previously reviewed versions within a story run."""
        entry = self.get(variant_id)
        if not entry or (entry["story_run_id"],entry["scene_key"],entry["story_version"]) != \
                (story_run_id,scene_key,story_version) or entry["state"] != "reviewed":
            raise ValueError("variant_not_owned_or_reviewed")
        with self.db:
            self.db.execute("UPDATE variants SET selected=0 WHERE story_run_id=? AND scene_key=?",
                            (story_run_id,scene_key))
            self.db.execute("UPDATE variants SET selected=1 WHERE id=?", (variant_id,))
        return self.get(variant_id)

    def close(self):
        self.db.close()
