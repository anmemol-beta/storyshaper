"""The public app must start its voice dependency without touching an existing service."""
import tempfile
import unittest
from unittest.mock import patch

from narration.runtime import managed_narration


class NarrationRuntimeTests(unittest.TestCase):
    def test_existing_service_is_reused_and_never_stopped(self):
        with patch('narration.runtime.urllib.request.urlopen') as probe, \
                patch('narration.runtime.subprocess.Popen') as launch:
            with managed_narration():
                pass
        probe.assert_called_once()
        launch.assert_not_called()

    def test_available_environment_starts_voice_service_and_stops_only_its_child(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch('narration.runtime.urllib.request.urlopen', side_effect=ConnectionRefusedError), \
                patch('narration.runtime.PYTHON') as python, \
                patch('narration.runtime.tempfile.gettempdir', return_value=tmp), \
                patch('narration.runtime.subprocess.Popen') as launch:
            python.is_file.return_value = True
            with managed_narration():
                launch.assert_called_once()
                self.assertEqual(launch.call_args.args[0][-2:], ['-m', 'narration.server'])
                launch.return_value.terminate.assert_not_called()
            launch.return_value.terminate.assert_called_once()
            launch.return_value.wait.assert_called_once_with(timeout=5)

    def test_no_voice_environment_keeps_story_app_available(self):
        with patch('narration.runtime.urllib.request.urlopen', side_effect=ConnectionRefusedError), \
                patch('narration.runtime.PYTHON') as python, \
                patch('narration.runtime.subprocess.Popen') as launch:
            python.is_file.return_value = False
            with managed_narration():
                pass
            launch.assert_not_called()

    def test_app_error_also_stops_its_voice_child(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch('narration.runtime.urllib.request.urlopen', side_effect=ConnectionRefusedError), \
                patch('narration.runtime.PYTHON') as python, \
                patch('narration.runtime.tempfile.gettempdir', return_value=tmp), \
                patch('narration.runtime.subprocess.Popen') as launch:
            python.is_file.return_value = True
            with self.assertRaises(RuntimeError):
                with managed_narration():
                    raise RuntimeError('app stopped')
            launch.return_value.terminate.assert_called_once()
