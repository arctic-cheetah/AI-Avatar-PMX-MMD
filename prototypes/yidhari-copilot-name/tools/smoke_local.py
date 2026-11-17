"""Loopback-only integration of the production localEndpoint launch plan."""
import http.client
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import tempfile
import threading
from smoke_proxy import Handler, received

ROOT = Path(__file__).resolve().parents[1]

def main():
    with tempfile.TemporaryDirectory(prefix='yidhari-local-test-') as tmp:
        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        options = dict(transport='localEndpoint', port=port, upstreamPort=upstream.server_port,
                       hosts=[], paths=['/chat/completions', '/v1/chat/completions'], certDir=tmp,
                       addon=str(ROOT / 'proxy/addon.py'))
        plan = json.loads(subprocess.check_output(['node', '-e',
            'process.stdout.write(JSON.stringify(require("./launch").buildLaunch(JSON.parse(process.argv[1]))))',
            json.dumps(options)], cwd=ROOT, text=True))
        child = subprocess.Popen([shutil.which('mitmdump'), *plan['args']],
                                 env={**os.environ, **plan['env']}, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        lines = queue.Queue()
        def read():
            for line in child.stdout:
                if line.startswith('YIDHARI:'): lines.put(json.loads(line[8:]))
        threading.Thread(target=read, daemon=True).start()
        connection = None
        try:
            while lines.get(timeout=15)['event'] != 'ready': pass
            text = ('Keep your answers short and impersonal.\n'
                    'You are an AI assistant using Copilot SDK in VS Code. '
                    'You help users with software engineering tasks. '
                    'When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code.')
            body = {'messages': [{'role': 'system', 'content': text}, {'role': 'user', 'content': text}],
                    'model': 'synthetic-model', 'tools': [{'type': 'function', 'function': {'name': 'example', 'description': text, 'parameters': {'type': 'object'}}}]}
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            connection.request('POST', '/v1/chat/completions', json.dumps(body), {'Content-Type': 'application/json', 'Authorization': 'Bearer synthetic-only'})
            response = connection.getresponse()
            assert response.status == 200
            assert response.read() == b'data: synthetic reply\n\ndata: [DONE]\n\n'
            actual = received[-1]
            assert actual['messages'][0]['content'] == text.replace('short and impersonal', 'friendly and concise').replace('an AI assistant using Copilot SDK in VS Code', 'yidhari, an AI assistant in VS Code')
            assert actual['messages'][1] == body['messages'][1]
            assert actual['tools'] == body['tools']
            assert actual['model'] == body['model']
            while True:
                event = lines.get(timeout=5)
                if event['event'] == 'rewritten':
                    assert event['count'] == 3
                    break
            print('PASS: production reverse-mode launch; three final-payload style/SDK identity replacements; user, tools, model and SSE preserved.')
        finally:
            if connection: connection.close()
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
            child.stdout.close(); child.stderr.close()
            upstream.shutdown(); upstream.server_close()

if __name__ == '__main__': main()
