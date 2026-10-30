"""Run the integrated StoryShaper app: python3 -m src.server."""

import signal

from vision.server import main


def stop(*_):
    """Let the app's context managers stop owned services on shell shutdown too."""
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    main()
