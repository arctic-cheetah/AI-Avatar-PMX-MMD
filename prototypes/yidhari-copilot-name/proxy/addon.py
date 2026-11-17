"""mitmdump adapter. Emits only fixed status codes and numeric counts."""
import json
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rewrite import rewrite_request

MAX_BYTES = 4 * 1024 * 1024

def emit(event, count=0):
    print('YIDHARI:' + json.dumps({'event': event, 'count': count}), flush=True)

class NameRewrite:
    def __init__(self):
        self.hosts = set(json.loads(os.environ.get('YIDHARI_HOSTS', '[]')))
        self.paths = set(json.loads(os.environ.get('YIDHARI_PATHS', '[]')))
        self.local_port = int(os.environ.get('YIDHARI_LOCAL_PORT') or 0)

    def allowed(self, request):
        if self.local_port:
            return request.scheme == 'http' and request.host == '127.0.0.1' and request.port == self.local_port
        return request.scheme == 'https' and request.host in self.hosts

    def running(self):
        emit('ready')

    def client_connected(self, client):
        emit('client_connected')

    def http_connect(self, flow):
        emit('connect_allowed' if flow.request.host in self.hosts else 'connect_tunneled')

    def tls_failed_client(self, data):
        emit('tls_client_failed')

    def tls_failed_server(self, data):
        emit('tls_server_failed')

    def error(self, flow):
        emit('request_error')

    def requestheaders(self, flow):
        emit('http_request')
        # Avoid buffering unknown, compressed or oversized requests.
        request = flow.request
        length = request.headers.get('content-length', '')
        if (not self.allowed(request) or request.path.split('?')[0] not in self.paths
                or request.headers.get('content-encoding', 'identity') != 'identity'
                or (length.isdigit() and int(length) > MAX_BYTES)):
            request.stream = True

    def request(self, flow):
        r = flow.request
        if not self.allowed(r):
            return
        if r.method != 'POST' or r.path.split('?')[0] not in self.paths:
            emit('skipped_route')
            return
        emit('model_request')
        if r.stream or r.headers.get('content-encoding', 'identity') != 'identity':
            emit('skipped_encoding_or_size')
            return
        if r.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
            emit('skipped_format')
            return
        raw = r.raw_content
        if not raw or len(raw) > MAX_BYTES:
            emit('skipped_encoding_or_size')
            return
        try:
            body = json.loads(raw)
            changed, count = rewrite_request(body)
        except (ValueError, UnicodeError, RecursionError):
            emit('skipped_format')
            return
        if count:
            # mitmproxy updates Content-Length via this setter.
            r.content = json.dumps(changed, ensure_ascii=False).encode('utf-8')
            emit('rewritten', count)
        else:
            emit('no_matching_instruction')

    def responseheaders(self, flow):
        flow.response.stream = True

    def websocket_message(self, flow):
        if flow.request.host in self.hosts:
            emit('unsupported_websocket')

addons = [NameRewrite()]
