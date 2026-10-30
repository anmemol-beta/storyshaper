"""Exercise the public CLI when another process already owns its requested port."""
import errno
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch

from vision.server import main


ROOT = Path(__file__).resolve().parent.parent


class StartupTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg'), 'The integrated app requires ffmpeg')
    def test_occupied_port_exits_with_actionable_message_without_traceback(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            result = subprocess.run(
                [sys.executable, '-m', 'src.server', '--port', str(port)],
                cwd=ROOT, env={**os.environ, 'MODEL_API_KEY': ''},
                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Traceback', result.stderr)
        self.assertIn(f'Port {port} is already in use', result.stderr)
        self.assertIn('python3 -m src.server', result.stderr)

    def test_unrelated_startup_errors_are_not_reported_as_port_conflicts(self):
        with patch.object(sys, 'argv', ['src.server']), \
                patch.dict(os.environ, {'MODEL_API_KEY': ''}), \
                patch('vision.server.load_env'), \
                patch('vision.server.shutil.which', return_value='ffmpeg'), \
                patch('vision.server.VisionServer', side_effect=PermissionError(errno.EACCES, 'denied')), \
                self.assertRaises(PermissionError) as caught:
            main()
        self.assertEqual(caught.exception.errno, errno.EACCES)


if __name__ == '__main__':
    unittest.main()
