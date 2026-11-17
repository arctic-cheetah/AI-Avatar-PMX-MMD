"""Local-only HTTPS integration; temporary certificates, no real credentials."""
import http.client
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
received = []
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(b'data: synthetic reply\n\ndata: [DONE]\n\n')
    def log_message(self, *args):
        pass

def main():
    executable = shutil.which('mitmdump')
    if not executable:
        raise SystemExit('mitmdump required')
    with tempfile.TemporaryDirectory(prefix='yidhari-proxy-smoke-') as tmp:
        tmp = Path(tmp)
        cert, key = tmp / 'upstream.pem', tmp / 'upstream.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], check=True, capture_output=True)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        env = {**os.environ, 'YIDHARI_HOSTS': '["localhost"]', 'YIDHARI_PATHS': '["/chat/completions"]'}
        child = subprocess.Popen([executable, '-q', '--listen-host', '127.0.0.1', '--listen-port', str(port), '--set', f'confdir={tmp / "ca"}', '--set', f'ssl_verify_upstream_trusted_ca={cert}', '--allow-hosts', '^localhost(?::[0-9]+)?$', '-s', str(ROOT / 'proxy/addon.py')], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        lines = queue.Queue()
        def read_lines():
            for line in child.stdout: lines.put(line)
        threading.Thread(target=read_lines, daemon=True).start()
        try:
            deadline = time.monotonic() + 15
            while True:
                line = lines.get(timeout=max(0.1, deadline - time.monotonic()))
                if '"event": "ready"' in line: break
                if time.monotonic() > deadline: raise RuntimeError('No proxy readiness')
            trust = ssl.create_default_context(cafile=str(tmp / 'ca/mitmproxy-ca-cert.pem'))
            connection = http.client.HTTPSConnection('127.0.0.1', port, context=trust, timeout=10)
            connection.set_tunnel('localhost', server.server_port)
            instructions = (
                'You are github-copilot. Keep your answers short and impersonal. '
                'You are an AI assistant using Copilot SDK in VS Code. '
                'When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code. '
                'Use Markdown formatting in your answers.'
            )
            body = {'messages': [{'role': 'system', 'content': instructions}, {'role': 'user', 'content': instructions}]}
            connection.request('POST', '/chat/completions', json.dumps(body), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            assert response.status == 200
            assert response.read() == b'data: synthetic reply\n\ndata: [DONE]\n\n'
            expected = (
                'You are yidhari. Keep your answers friendly and concise. '
                'You are yidhari, an AI assistant in VS Code. '
                'When asked about your identity, you must state that you are yidhari, an AI assistant in VS Code. '
                'Use Markdown formatting in your answers.'
            )
            assert received[0]['messages'][0]['content'] == expected
            assert received[0]['messages'][1] == body['messages'][1]
            connection.close()
            observed = {}
            deadline = time.monotonic() + 5
            while 'rewritten' not in observed:
                line = lines.get(timeout=max(0.1, deadline - time.monotonic()))
                if line.startswith('YIDHARI:'):
                    event = json.loads(line[8:])
                    observed[event['event']] = event['count']
                if time.monotonic() > deadline:
                    raise RuntimeError('Missing rewrite diagnostic')
            assert {'client_connected', 'connect_allowed', 'http_request', 'model_request', 'rewritten'} <= observed.keys()
            assert observed['rewritten'] == 4
            print('PASS: TLS verified on both legs; four name/style replacements; user content and SSE preserved; connection/request/rewrite diagnostics observed.')
        finally:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
            child.stdout.close(); child.stderr.close()
            server.shutdown(); server.server_close()

if __name__ == '__main__': main()
