import gzip
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'proxy'))
try:
    from mitmproxy import http
    from mitmproxy.test import tflow
    from addon import NameRewrite
    AVAILABLE = True
except ImportError:
    AVAILABLE = False

@unittest.skipUnless(AVAILABLE, 'Install mitmproxy for adapter tests')
class AddonTests(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, {'YIDHARI_HOSTS': '["api.githubcopilot.com"]', 'YIDHARI_PATHS': '["/chat/completions"]'}):
            self.addon = NameRewrite()

    def flow(self, url='https://api.githubcopilot.com/chat/completions'):
        f = tflow.tflow()
        f.request = http.Request.make('POST', url, json.dumps({'messages': [{'role': 'system', 'content': 'You are github-copilot.'}]}), {'content-type': 'application/json', 'authorization': 'Bearer synthetic-test-only'})
        return f

    def test_rewrite_preserves_auth_and_updates_length(self):
        f = self.flow()
        self.addon.request(f)
        self.assertIn('yidhari', f.request.text)
        self.assertEqual(f.request.headers['authorization'], 'Bearer synthetic-test-only')
        self.assertEqual(int(f.request.headers['content-length']), len(f.request.raw_content))

    def test_host_suffix_attack_and_wrong_path(self):
        for url in ['https://api.githubcopilot.com.attacker.test/chat/completions', 'https://api.githubcopilot.com/other', 'http://api.githubcopilot.com/chat/completions']:
            f = self.flow(url); before = f.request.raw_content
            self.addon.request(f)
            self.assertEqual(f.request.raw_content, before)

    def test_compressed_and_malformed_pass_through(self):
        f = self.flow(); f.request.encode('gzip'); before = f.request.raw_content
        self.addon.requestheaders(f); self.addon.request(f)
        self.assertEqual(f.request.raw_content, before)
        f = self.flow(); f.request.content = b'{bad json'
        self.addon.request(f); self.assertEqual(f.request.content, b'{bad json')

    def test_response_streaming(self):
        f = self.flow(); f.response = http.Response.make(200, b'data: hello\n\n')
        self.addon.responseheaders(f)
        self.assertTrue(f.response.stream)
        self.assertEqual(f.response.content, b'data: hello\n\n')

    def test_diagnostics_classify_connections_without_logging_sensitive_data(self):
        with patch('addon.emit') as emit:
            self.addon.client_connected(object())
            self.addon.http_connect(self.flow())
            self.addon.http_connect(self.flow('https://private.invalid/secret?token=do-not-log'))
            self.addon.tls_failed_client(object())
            self.addon.tls_failed_server(object())
            self.assertEqual([call.args for call in emit.call_args_list], [
                ('client_connected',), ('connect_allowed',), ('connect_tunneled',),
                ('tls_client_failed',), ('tls_server_failed',),
            ])

    def test_request_events_distinguish_receipt_from_eligibility(self):
        with patch('addon.emit') as emit:
            f = self.flow()
            self.addon.requestheaders(f)
            self.addon.request(f)
            names = [call.args[0] for call in emit.call_args_list]
            self.assertEqual(names, ['http_request', 'model_request', 'rewritten'])

    def test_local_forwarding_edits_final_payload(self):
        with patch.dict(os.environ, {'YIDHARI_LOCAL_PORT': '8317', 'YIDHARI_PATHS': '["/chat/completions"]'}):
            addon = NameRewrite()
        f = self.flow('http://127.0.0.1:8317/chat/completions')
        f.request.content = json.dumps({'messages': [{'role': 'system', 'content':
            'Keep your answers short and impersonal. You are an AI assistant using Copilot SDK in VS Code. '
            'When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code.'}]}).encode()
        addon.requestheaders(f)
        addon.request(f)
        self.assertIn('friendly and concise', f.request.text)
        self.assertNotIn('Copilot SDK', f.request.text)

    def test_local_mode_does_not_edit_other_ports_or_remote_hosts(self):
        with patch.dict(os.environ, {'YIDHARI_LOCAL_PORT': '8317', 'YIDHARI_PATHS': '["/chat/completions"]'}):
            addon = NameRewrite()
        for url in ['http://127.0.0.1:8318/chat/completions', 'http://remote.invalid:8317/chat/completions']:
            f = self.flow(url)
            before = f.request.raw_content
            addon.requestheaders(f)
            addon.request(f)
            self.assertEqual(f.request.raw_content, before)
