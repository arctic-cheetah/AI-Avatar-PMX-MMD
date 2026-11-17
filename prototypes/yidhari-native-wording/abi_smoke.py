"""Exercise the actual shared library via public C ABI, with synthetic bodies."""
import base64
import ctypes as C
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent
class Buffer(C.Structure):
    _fields_ = [('ptr', C.c_void_p), ('length', C.c_size_t)]
class Host(C.Structure):
    _fields_ = [('version', C.c_uint32), ('context', C.c_void_p), ('call', C.c_void_p), ('free', C.c_void_p)]
class API(C.Structure):
    _fields_ = [('version', C.c_uint32), ('call', C.c_void_p), ('free', C.c_void_p), ('shutdown', C.c_void_p)]
lib = C.CDLL(str(ROOT / 'yidhari-wording.so'))
lib.cliproxy_plugin_init.argtypes = [C.POINTER(Host), C.POINTER(API)]
lib.cliproxy_plugin_init.restype = C.c_int
api = API()
assert lib.cliproxy_plugin_init(C.byref(Host(1)), C.byref(api)) == 0 and api.version == 1
call_fn = C.CFUNCTYPE(C.c_int, C.c_char_p, C.c_void_p, C.c_size_t, C.POINTER(Buffer))(api.call)
free_fn = C.CFUNCTYPE(None, C.c_void_p, C.c_size_t)(api.free)
shutdown_fn = C.CFUNCTYPE(None)(api.shutdown)
def call(method, request):
    raw = json.dumps(request).encode()
    memory = C.create_string_buffer(raw)
    output = Buffer()
    status = call_fn(method.encode(), memory, len(raw), C.byref(output))
    try:
        envelope = json.loads(C.string_at(output.ptr, output.length))
    finally:
        free_fn(output.ptr, output.length)
    assert status == 0 and envelope['ok'], envelope
    return envelope['result']

cfg = yaml.safe_load((ROOT / 'config.example.yaml').read_text())['plugins']['configs']['yidhari-wording']
registration = call('plugin.register', {'config_yaml': base64.b64encode(yaml.safe_dump(cfg).encode()).decode()})
assert registration['schema_version'] == 10
assert registration['metadata']['Version'] == '0.2.0'
assert all(registration['metadata'].get(k) for k in ['Name', 'Version', 'Author', 'GitHubRepository'])
assert registration['capabilities'] == {'request_interceptor': True}
text = ('Keep your answers short and impersonal. You are an AI assistant using Copilot SDK in VS Code. '
        'When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code. '
        'Names: Copilot, github-copilot, GitHub Copilot. Keep copilot-cli and my_copilot intact.')
expected = text.replace('short and impersonal', 'friendly and concise').replace('an AI assistant using Copilot SDK in VS Code', 'yidhari, an AI assistant in VS Code')
expected = expected.replace('Names: Copilot, github-copilot, GitHub Copilot.', 'Names: yidhari, yidhari, yidhari.')
vectors = [
 ('openai', {'messages': [{'role': 'system', 'content': text}, {'role': 'user', 'content': text}]}),
 ('responses', {'instructions': text, 'input': [{'role': 'user', 'content': text}]}),
 ('claude', {'system': [{'type': 'text', 'text': text}], 'messages': [{'role': 'user', 'content': text}]}),
 ('gemini', {'systemInstruction': {'parts': [{'text': text}]}, 'contents': [{'role': 'user', 'parts': [{'text': text}]}]}),
]
for provider in ['devin', 'antigravity', 'codex', 'claude', 'gemini', 'openai-compatibility', 'xai', 'meta']:
    for source, body in vectors:
        encoded = json.dumps(body).encode()
        request = {'SourceFormat': source, 'Model': 'synthetic-model', 'Body': base64.b64encode(encoded).decode(), 'Metadata': {'provider': provider}}
        response = call('request.intercept_before', request)
        updated = json.loads(base64.b64decode(response['Body']))
        if source == 'openai':
            assert updated['messages'][0]['content'] == expected
            assert updated['messages'][1] == body['messages'][1]
        elif source == 'responses':
            assert updated['instructions'] == expected
            assert updated['input'] == body['input']
        elif source == 'claude':
            assert updated['system'][0]['text'] == expected
            assert updated['messages'] == body['messages']
        else:
            assert updated['systemInstruction']['parts'][0]['text'] == expected
            assert updated['contents'] == body['contents']
        # After-auth sees either already-edited or original data; both are valid.
        assert call('request.intercept_after', {**request, 'Body': response['Body']}) == {}
        assert 'Body' in call('request.intercept_after', request)
call('plugin.reconfigure', {'config_yaml': base64.b64encode(b'sensitive-words-replace: {}').decode()})
assert call('request.intercept_before', {'Body': base64.b64encode(json.dumps(vectors[0][1]).encode()).decode()}) == {}
shutdown_fn()
print('PASS: actual shared-library ABI registration/reconfiguration; 32 provider-label/protocol combinations; before/after hooks; user data preserved. No upstream model called.')
