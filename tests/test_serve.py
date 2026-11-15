"""renderer/serve.py start-up: ready URL, --no-bridge test pages and busy ports (#215)."""

from __future__ import annotations

from pathlib import Path
import re
import socket
import subprocess
import sys
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SERVE = ROOT / 'renderer' / 'serve.py'
URL = re.compile(r'Yidhari renderer: (http://127\.0\.0\.1:(\d+)/renderer/\S*)')


class ServeStartupTests(unittest.TestCase):
    def start(self, *args: str) -> tuple[subprocess.Popen, str]:
        process = subprocess.Popen(
            [sys.executable, '-u', str(SERVE), '--port', '0', *args],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(process.wait, 5)
        self.addCleanup(process.kill)
        for line in process.stdout:
            match = URL.search(line)
            if match:
                self.addCleanup(process.stdout.close)
                return process, match.group(1)
        self.fail(f'serve.py printed no ready URL (exit {process.wait(5)})')

    def test_no_bridge_prints_a_test_page_url_on_the_bound_port(self):
        _, url = self.start('--no-bridge')
        self.assertTrue(url.endswith('/renderer/?bridge=off'), url)
        port = int(URL.search(f'Yidhari renderer: {url}').group(2))
        self.assertNotEqual(port, 0)
        with urllib.request.urlopen(url, timeout=5) as response:
            self.assertEqual(response.status, 200)

    def test_default_url_keeps_the_bridge(self):
        _, url = self.start()
        self.assertNotIn('bridge=off', url)
        self.assertTrue(url.endswith('/renderer/'), url)

    def test_busy_port_exits_with_a_hint_instead_of_a_traceback(self):
        with socket.socket() as taken:
            taken.bind(('127.0.0.1', 0))
            taken.listen()
            port = taken.getsockname()[1]
            result = subprocess.run(
                [sys.executable, str(SERVE), '--port', str(port), '--no-bridge'],
                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'Port {port} is already in use', result.stderr)
        self.assertIn('--port', result.stderr)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
