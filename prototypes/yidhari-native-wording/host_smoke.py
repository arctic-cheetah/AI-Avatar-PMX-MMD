"""Isolated installed-core integration; fake upstream, no real auth or models."""
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import yaml

ROOT = Path(__file__).resolve().parent
CORE = Path('/home/lyrebird/EasyCLIProxyAPI-v0.3.22-Linux-amd64/cpa-core/cli-proxy-api')
seen = []
class Upstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        seen.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        body = json.dumps({'id': 'synthetic', 'object': 'chat.completion', 'model': 'synthetic', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'synthetic reply'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

def main():
    with tempfile.TemporaryDirectory(prefix='yidhari-native-host-') as tmp:
        tmp = Path(tmp)
        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        plugins = tmp / 'plugins/linux/amd64'; plugins.mkdir(parents=True)
        shutil.copy2(ROOT/'yidhari-wording.so', plugins/'yidhari-wording.so')
        plugin = yaml.safe_load((ROOT/'config.example.yaml').read_text())['plugins']
        plugin['dir'] = str(tmp/'plugins')
        persona_path = os.environ.get('YIDHARI_TEST_PERSONA')
        persona = Path(persona_path).read_text() if persona_path else ''
        if persona_path:
            plugin['configs']['yidhari-wording']['persona-file'] = persona_path
        cfg = {'config-version': 8, 'server': {'host': '127.0.0.1', 'port': port, 'kv-store': {'disabled': True}},
               'management': {'disable-control-panel': True}, 'access': {'api-keys': ['synthetic-client']},
               'oauth': {'auth-dir': str(tmp/'empty-auth')}, 'plugins': plugin,
               'api-keys': {'openai-compatibility': [{'name': 'native-test', 'base-url': f'http://127.0.0.1:{upstream.server_port}/v1', 'models': [{'name': 'synthetic', 'alias': 'synthetic'}], 'keys': [{'api-key': 'synthetic-upstream'}]}]}}
        (tmp/'config.yaml').write_text(yaml.safe_dump(cfg))
        log = (tmp/'core.log').open('w+')
        child = subprocess.Popen([str(CORE), '--config', str(tmp/'config.yaml'), '--local-model'], cwd=tmp,
                                 env={'PATH': os.environ['PATH'], 'HOME': str(tmp), 'XDG_CONFIG_HOME': str(tmp/'config')}, stdout=log, stderr=log)
        try:
            deadline = time.monotonic()+15
            while True:
                if child.poll() is not None: raise RuntimeError('Isolated core exited before readiness')
                try:
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                    conn.request('GET', '/v1/models', headers={'Authorization': 'Bearer synthetic-client'})
                    r = conn.getresponse(); r.read(); conn.close()
                    if r.status == 200: break
                except OSError: pass
                if time.monotonic()>deadline: raise RuntimeError('Isolated core readiness timeout')
                time.sleep(.1)
            text = 'Keep your answers short and impersonal. You are an AI assistant using Copilot SDK in VS Code. When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code. Names: Copilot, github-copilot, GitHub Copilot. IMPERSONAL. Keep copilot-cli and impersonally intact.'
            body = {'model': 'synthetic', 'messages': [{'role': 'system', 'content': text}, {'role': 'user', 'content': text}]}
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            conn.request('POST', '/v1/chat/completions', json.dumps(body), {'Authorization': 'Bearer synthetic-client', 'Content-Type': 'application/json'})
            result = conn.getresponse(); result.read(); conn.close()
            assert result.status == 200, result.status
            assert seen, 'No fake upstream request'
            expected = text.replace('short and impersonal', 'friendly and concise').replace('an AI assistant using Copilot SDK in VS Code', 'yidhari, an AI assistant in VS Code')
            expected = expected.replace('Names: Copilot, github-copilot, GitHub Copilot.', 'Names: yidhari, yidhari, yidhari.')
            expected = expected.replace('IMPERSONAL.', 'friendly.')
            if persona:
                expected += '\n\n<!-- yidhari-persona:start -->\n' + persona + '\n<!-- yidhari-persona:end -->'
            assert seen[-1]['messages'][0]['content'] == expected, 'Native host did not apply plugin'
            assert seen[-1]['messages'][1]['content'] == text, 'User content changed'
            if persona:
                assert seen[-1]['messages'][0]['content'].count('yidhari-persona:start') == 1
                print('PASS: supplied persona reached mock upstream verbatim, exactly once; harness rewrite and user preservation verified.')
            print('PASS: installed CLIProxyAPI 8.0.76 loaded native plugin; synthetic OpenAI-compatible request rewritten before fake upstream; user content preserved. Live service untouched.')
        except Exception:
            log.flush(); log.seek(0)
            print(log.read()[-3500:])  # Isolated synthetic config/auth only.
            raise
        finally:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
            log.close(); upstream.shutdown(); upstream.server_close()
if __name__ == '__main__': main()
