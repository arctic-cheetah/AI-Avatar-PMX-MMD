# Markdown in the chat log (#89)

Yidhari's replies and a coding agent's `say`, `ask` and `report` text are
shown as Markdown in the chat log. Your own messages and tool status notices
stay exactly as typed.

The renderer is [renderer/markdown.js](../renderer/markdown.js). It is small,
has no dependencies and builds the DOM with `createElement` and text nodes. It
never parses a string as HTML.

## Supported Markdown

| Element           | Written as                                                    |
| ----------------- | ------------------------------------------------------------- |
| Headings          | `# H1` … `###### H6`, or a line underlined with `===` / `---` |
| Paragraphs        | Blank lines between them. A single newline stays a line break |
| Bold / italic     | `**bold**`, `__bold__`, `*italic*`, `_italic_`, `***both***`  |
| Strikethrough     | `~~gone~~`                                                    |
| Inline code       | `` `code` ``                                                  |
| Fenced code       | ` ``` ` or `~~~` fences, with an optional language            |
| Lists             | `-`, `*`, `+` or `1.` / `1)`; indent to nest                  |
| Blockquotes       | `> quoted`, which may hold other Markdown                     |
| Links             | `[text](https://…)`, `<https://…>` or a bare `https://…`      |
| Tables            | GitHub pipe tables with `:---`, `:---:`, `---:` alignment     |
| Horizontal rules  | `---`, `***` or `___` on their own line                       |

Intraword underscores and asterisks (`snake_case_name`, `2*3*4`) stay literal,
and a backslash escapes punctuation (`\*`). Reference-style links, footnotes,
task-list checkboxes and raw HTML are not rendered.

Yidhari's own replies pass through the bridge's mood-tag parser first. That
parser reserves square brackets for `[mood]` tags and drops unknown ones, so a
`[text](url)` link written by the local LLM loses its `[text]` before it
reaches the chat log
(see [architecture-v2.md](architecture-v2.md)). Bare `https://…` links and
agent text are not affected.

## Safe rendering

All message text is untrusted.

- **No raw HTML.** `<script>`, `<img onerror=…>`, `<iframe>` and other tags are
  shown as text. Only a fixed set of elements is created, and the only
  attributes set are `href`, `target`, `rel`, `title`, `class` and `start`.
- **Links:** only `http:`, `https:` and `mailto:` URLs become links, checked
  after the browser's own URL parsing. `javascript:`, `vbscript:`, `data:`,
  `file:` and relative URLs stay plain text. Links open in a new tab with
  `rel="noopener noreferrer"`, so the new page gets no opener and no referrer.
- **No remote content.** Images (`![alt](url)`) are never loaded. With a safe
  URL they become a `🖼️ alt` link that you can choose to open.
- **Speech stays plain.** The bridge's `say` chunks reach speech unchanged.
  The chat bubble keeps its own Markdown source and renders from it, so HTML
  never feeds speech and speech text never becomes HTML.

## Streaming

A streamed reply keeps its Markdown source as plain text. Each chunk is
appended to the source, and the whole bubble is rendered again from it. An
unfinished part therefore shows as follows, and is correct once it completes:

- An unclosed code fence shows the code received so far as a code block.
- Unclosed `**bold` or `[text](url` shows the raw characters.
- A table appears once its header and `| --- |` delimiter row have arrived.

Text is never duplicated or lost between chunks. A selection inside the
message that is still streaming is cleared on each chunk; finished messages are
not re-rendered.

## Reports

A report bubble stays collapsed by default. Its summary line is plain text:
the first line with its Markdown removed, cut at 80 characters. Opening it
shows the full report rendered as Markdown, in a box that scrolls after 40% of
the window height.

## Layout

Code blocks and tables scroll sideways inside the bubble instead of widening
the chat panel, including in the narrow docked panel and the floating chat
box. Long words and URLs in prose wrap.

## Tests

`node --test tests/renderer/*.test.mjs` runs
[markdown.test.mjs](../tests/renderer/markdown.test.mjs) and
[bridge-client.test.mjs](../tests/renderer/bridge-client.test.mjs). They use
[fake-dom.mjs](../tests/renderer/fake-dom.mjs), whose `innerHTML` setter
throws, so a test fails if the code ever parses a string as HTML. They cover
each element, every streamed prefix of a mixed message, unsafe HTML and link
schemes, images, report summaries and user messages.
