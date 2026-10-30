"""Keep the optional local voice service with the app that started it."""
from contextlib import contextmanager
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
PYTHON = ROOT / "voice" / ".venv-chatterbox" / "bin" / "python"


@contextmanager
def managed_narration():
    """Reuse an existing voice service; clean up only a child started here."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8100/api/voice/config", timeout=1):
            running = True
    except (OSError, urllib.error.URLError):
        running = False
    if running or not PYTHON.is_file():
        if not running:
            print("Parent voice setup needs voice/.venv-chatterbox; see narration/README.md.", flush=True)
        yield
        return

    logs = Path(tempfile.gettempdir()) / "storyshaper"
    logs.mkdir(exist_ok=True)
    with (logs / "narration.log").open("a", encoding="utf-8") as log:
        process = subprocess.Popen([str(PYTHON), "-m", "narration.server"], cwd=ROOT,
                                   stdout=log, stderr=subprocess.STDOUT)
        print(f"Starting parent voice service on 8100. Log: {logs / 'narration.log'}", flush=True)
        try:
            yield
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
