"""Pure conservative request transformation; no networking or logging."""
import copy
import re

# Sentence/line boundaries prevent matching examples embedded in prose.
IDENTITY = re.compile(
    r'(?P<prefix>(?:^|(?<=[.!?]) |\n)[ \t]*(?:You are|Your name is|'
    r'When asked (?:for|about) your name, you (?:must|should) (?:respond with|say))'
    r'[ \t]+["\']?)(?:github-copilot|GitHub Copilot)(?![\w-])',
    re.IGNORECASE,
)

# Match whole known clauses, not every mention of the SDK or these adjectives.
CLAUSE_START = r'(?P<prefix>(?:^|(?<=[.!?]) |\n)[ \t]*)'
STYLE = re.compile(
    CLAUSE_START + r'Keep your answers (?:short and impersonal|impersonal and short)\.',
    re.IGNORECASE,
)
SDK_IDENTITY = re.compile(
    CLAUSE_START + r'(?P<intro>You are|When asked about your identity, you must state that you are) '
    r'an AI assistant using Copilot SDK in VS Code\.',
    re.IGNORECASE,
)

def rewrite_request(body):
    if not isinstance(body, dict):
        return body, 0
    result = copy.deepcopy(body)
    count = 0

    def text(value):
        nonlocal count
        if isinstance(value, str):
            value, n = IDENTITY.subn(lambda m: m['prefix'] + 'yidhari', value)
            count += n
            value, n = STYLE.subn(lambda m: m['prefix'] + 'Keep your answers friendly and concise.', value)
            count += n
            value, n = SDK_IDENTITY.subn(
                lambda m: m['prefix'] + m['intro'] + ' yidhari, an AI assistant in VS Code.', value)
            count += n
        return value

    def content(value):
        if isinstance(value, str):
            return text(value)
        if isinstance(value, list):
            for block in value:
                if isinstance(block, dict) and block.get('type') in ('text', 'input_text') and 'text' in block:
                    block['text'] = text(block['text'])
        return value

    for key in ('system', 'instructions'):
        if key in result:
            result[key] = content(result[key])
    for key in ('messages', 'input'):
        messages = result.get(key)
        if isinstance(messages, list):
            for message in messages:
                if isinstance(message, dict) and message.get('role') in ('system', 'developer') and 'content' in message:
                    message['content'] = content(message['content'])
    return (result, count) if count else (body, 0)
