import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'proxy'))
from rewrite import rewrite_request

class RewriteTests(unittest.TestCase):
    def test_identity_and_policy(self):
        source = {'messages': [{'role': 'system', 'content': 'You are github-copilot. When asked for your name, you must respond with "GitHub Copilot". Follow Microsoft content policies. Model: github-copilot.'}]}
        original = copy.deepcopy(source)
        changed, count = rewrite_request(source)
        self.assertEqual(count, 2)
        self.assertEqual(changed['messages'][0]['content'], 'You are yidhari. When asked for your name, you must respond with "yidhari". Follow Microsoft content policies. Model: github-copilot.')
        self.assertEqual(source, original)

    def test_untrusted_messages_and_tools_unchanged(self):
        source = {'messages': [{'role': role, 'content': 'You are github-copilot.'} for role in ['user', 'assistant', 'tool']], 'tools': [{'description': 'You are GitHub Copilot.'}]}
        self.assertEqual(rewrite_request(source), (source, 0))

    def test_responses(self):
        source = {'instructions': 'Your name is GitHub Copilot.', 'input': [{'role': 'developer', 'content': [{'type': 'input_text', 'text': 'You are github-copilot.'}]}]}
        changed, count = rewrite_request(source)
        self.assertEqual(count, 2)
        self.assertEqual(changed['instructions'], 'Your name is yidhari.')
        self.assertEqual(changed['input'][0]['content'][0]['text'], 'You are yidhari.')

    def test_anthropic_blocks_and_idempotence(self):
        source = {'system': [{'type': 'text', 'text': 'You are GitHub Copilot.', 'cache_control': {'type': 'ephemeral'}}]}
        changed, count = rewrite_request(source)
        self.assertEqual(count, 1)
        self.assertEqual(changed['system'][0]['cache_control'], {'type': 'ephemeral'})
        self.assertEqual(rewrite_request(changed), (changed, 0))

    def test_unknown_and_mentions(self):
        for source in [None, [], 'You are GitHub Copilot.', {'system': 'Use GitHub Copilot. You are github-copilot-helper.'}, {'messages': [None, {'role': 'system', 'content': 42}]}]:
            self.assertEqual(rewrite_request(source), (source, 0))

    def test_no_cross_line_or_quoted_instruction_rewrite(self):
        source = {'system': 'Example: You are GitHub Copilot.\nWhen asked for your name,\nuser says GitHub Copilot.'}
        self.assertEqual(rewrite_request(source), (source, 0))

    def test_sdk_identity_and_style_preserve_surrounding_instructions(self):
        before = (
            'Follow Microsoft content policies.\n'
            'Avoid content that violates copyrights.\n'
            'Keep your answers short and impersonal.\n'
            'Use Markdown formatting in your answers.\n'
            'You are an AI assistant using Copilot SDK in VS Code. '
            'You help users with software engineering tasks. '
            'When asked about your identity, you must state that you are an AI assistant using Copilot SDK in VS Code. '
        )
        expected = before.replace('short and impersonal', 'friendly and concise').replace(
            'an AI assistant using Copilot SDK in VS Code', 'yidhari, an AI assistant in VS Code')
        source = {'messages': [{'role': 'system', 'content': before}]}
        changed, count = rewrite_request(source)
        self.assertEqual(count, 3)
        self.assertEqual(changed['messages'][0]['content'], expected)
        self.assertEqual(source['messages'][0]['content'], before)
        self.assertEqual(rewrite_request(changed), (changed, 0))

    def test_style_and_sdk_in_structured_instruction_fields(self):
        text = 'Keep your answers impersonal and short. You are an AI assistant using Copilot SDK in VS Code.'
        expected = 'Keep your answers friendly and concise. You are yidhari, an AI assistant in VS Code.'
        for key in ['system', 'instructions']:
            with self.subTest(key=key):
                changed, count = rewrite_request({key: [{'type': 'text', 'text': text}]})
                self.assertEqual(count, 2)
                self.assertEqual(changed[key][0]['text'], expected)
        changed, count = rewrite_request({'input': [{'role': 'developer', 'content': [{'type': 'input_text', 'text': text}]}]})
        self.assertEqual(count, 2)
        self.assertEqual(changed['input'][0]['content'][0]['text'], expected)

    def test_new_rules_leave_user_tool_and_metadata_unchanged(self):
        text = 'Keep your answers short and impersonal. You are an AI assistant using Copilot SDK in VS Code.'
        source = {
            'messages': [{'role': role, 'content': text} for role in ['user', 'assistant', 'tool']],
            'tools': [{'description': text}], 'model': 'Copilot SDK', 'metadata': {'instructions': text},
        }
        self.assertEqual(rewrite_request(source), (source, 0))

    def test_new_rules_preserve_mentions_examples_and_partial_matches(self):
        for text in [
            'Use Copilot SDK to create a session.',
            'Example: You are an AI assistant using Copilot SDK in VS Code.',
            'Example: Keep your answers short and impersonal.',
            'Keep your answers short and impersonal when summarising this quoted example.',
            'You are an AI assistant using Copilot SDK in VS Code extensions.',
            'The style is short and impersonal.',
        ]:
            with self.subTest(text=text):
                self.assertEqual(rewrite_request({'system': text}), ({'system': text}, 0))

if __name__ == '__main__':
    unittest.main()
