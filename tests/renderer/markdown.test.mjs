// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, plainText } from "../../renderer/markdown.js";
import { createDocument, serialize } from "./fake-dom.mjs";

function render(source) {
  const target = createDocument().createElement("div");
  renderMarkdown(target, source);
  return target;
}

const html = (source) => render(source).innerHTML;

test("headings, paragraphs and inline styles become elements", () => {
  assert.equal(html("# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code`."),
    "<h1>Title</h1><p>Some <strong>bold</strong>, <em>italic</em>, <del>gone</del> and <code>code</code>.</p>");
  assert.equal(html("###### Small\n__strong__ _em_ ***both***"),
    "<h6>Small</h6><p><strong>strong</strong> <em>em</em> <strong><em>both</em></strong></p>");
  assert.equal(html("Title\n=====\n\nSub\n---"), "<h1>Title</h1><h2>Sub</h2>");
});

test("single newlines inside a paragraph stay visible as line breaks", () => {
  assert.equal(html("line one\nline two\n\nnext"), "<p>line one<br>line two</p><p>next</p>");
});

test("plain text, Japanese and emoji stay readable and untouched", () => {
  const text = "おはよう、ダーリン 🌸 今日もよろしくね ❤️";
  assert.equal(html(text), `<p>${text}</p>`);
  assert.equal(html("snake_case_name and 2*3*4 stay literal"), "<p>snake_case_name and 2*3*4 stay literal</p>");
  assert.equal(html("a \\*not em\\* b"), "<p>a *not em* b</p>");
});

test("ordered, unordered and nested lists", () => {
  assert.equal(html("- one\n- two\n  - sub\n- three"),
    "<ul><li>one</li><li>two<ul><li>sub</li></ul></li><li>three</li></ul>");
  assert.equal(html("3. third\n4. fourth"), '<ol start="3"><li>third</li><li>fourth</li></ol>');
  assert.equal(html("1. **bold** item\n2. `code` item"),
    "<ol><li><strong>bold</strong> item</li><li><code>code</code> item</li></ol>");
  assert.equal(html("* star\n+ plus"), "<ul><li>star</li></ul><ul><li>plus</li></ul>");
});

test("blockquotes hold their own Markdown", () => {
  assert.equal(html("> quoted *text*\n> - item"), "<blockquote><p>quoted <em>text</em></p><ul><li>item</li></ul></blockquote>");
});

test("fenced code keeps its text verbatim with the language as a class", () => {
  assert.equal(html("```js\nconst a = **b** < c;\n  <b>x</b>\n```"),
    '<pre><code class="language-js">const a = **b** &lt; c;\n  &lt;b&gt;x&lt;/b&gt;</code></pre>');
  assert.equal(html("~~~\nplain\n~~~\nafter"), "<pre><code>plain</code></pre><p>after</p>");
  assert.equal(html("````\n```\ninner\n```\n````"), "<pre><code>```\ninner\n```</code></pre>");
});

test("horizontal rules separate blocks", () => {
  assert.equal(html("above\n\n---\n\nbelow"), "<p>above</p><hr><p>below</p>");
});

test("tables keep alignment and sit in a horizontally scrolling wrapper", () => {
  assert.equal(html("| Name | Score |\n| :--- | ---: |\n| A \\| B | `1|2` |\n| C | 3 |"),
    '<div class="md-table"><table><thead><tr><th class="md-align-left">Name</th><th class="md-align-right">Score</th></tr></thead>' +
    '<tbody><tr><td class="md-align-left">A | B</td><td class="md-align-right"><code>1|2</code></td></tr>' +
    '<tr><td class="md-align-left">C</td><td class="md-align-right">3</td></tr></tbody></table></div>');
});

test("links open in a new tab without an opener or referrer", () => {
  const root = render("See [the docs](https://example.com/docs \"Docs\") or <https://example.org/a>, or https://example.net/x.");
  const links = root.querySelectorAll("a");
  assert.deepEqual(links.map((link) => [link.textContent, link.getAttribute("href")]), [
    ["the docs", "https://example.com/docs"],
    ["https://example.org/a", "https://example.org/a"],
    ["https://example.net/x", "https://example.net/x"],
  ]);
  for (const link of links) {
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  }
  assert.equal(links[0].getAttribute("title"), "Docs");
  assert.match(root.textContent, /https:\/\/example\.net\/x\.$/);
  assert.equal(render("[mail](mailto:me@example.com)").querySelector("a").getAttribute("href"), "mailto:me@example.com");
});

test("raw HTML is shown as text and never becomes elements", () => {
  const source = '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> <b onclick="x()">hi</b>\n<iframe src="https://evil.example"></iframe>';
  const root = render(source);
  assert.deepEqual(root.descendants().map((element) => element.localName), ["p", "p", "br"]);
  assert.equal(root.textContent, source.replace(/\n+/g, ""));
});

test("unsafe link schemes never reach an href", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)",
    "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "/relative", "#top"]) {
    const root = render(`[click](${url}) and <${url}>`);
    assert.equal(root.querySelectorAll("a").length, 0, url);
    assert.ok(root.textContent.includes("click"), url);
  }
});

test("no element ever carries an event handler or inline style attribute", () => {
  const root = render('[x](https://a.example "t\\" onmouseover=\\"alert(1)") ![y](https://b.example/i.png "\\" onerror=alert(1)")\n\n' +
    "| <b onclick=1> |\n| - |\n| x |\n\n```\" onload=\"x\n```");
  for (const element of [root, ...root.descendants()]) {
    for (const name of element.attributes.keys()) {
      assert.ok(["href", "target", "rel", "title", "class", "start"].includes(name), `${element.localName}[${name}]`);
    }
  }
});

test("images are offered as links and never loaded automatically", () => {
  const root = render("![a cat](https://cdn.example/cat.png) ![bad](javascript:alert(1))");
  assert.equal(root.querySelectorAll("img").length, 0);
  const links = root.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://cdn.example/cat.png");
  assert.match(links[0].textContent, /a cat/);
  assert.match(root.textContent, /bad/);
});

const STREAMED = [
  "# Plan 🌸",
  "",
  "Here is **the fix** for `bridge.py`, see [the issue](https://example.com/issues/89).",
  "",
  "1. Read the *logs*",
  "2. Patch it:",
  "",
  "```python",
  "print('**not bold**')",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "> done ~~maybe~~",
].join("\n");

test("every streamed prefix renders, and the finished text matches a one-shot render", () => {
  const target = createDocument().createElement("div");
  for (let end = 1; end <= STREAMED.length; end += 1) renderMarkdown(target, STREAMED.slice(0, end));
  assert.equal(target.innerHTML, html(STREAMED));
  assert.equal(target.children.filter((child) => child.localName === "h1").length, 1);
});

test("unfinished fences, emphasis and links recover once the text completes", () => {
  assert.equal(html("```py\nprint(1)\nprint("), '<pre><code class="language-py">print(1)\nprint(</code></pre>');
  assert.equal(html("so **bol"), "<p>so **bol</p>");
  assert.equal(html("so **bold**"), "<p>so <strong>bold</strong></p>");
  assert.equal(html("[the docs](https://exa"), "<p>[the docs](https://exa</p>");
  assert.equal(html("[the docs](https://example.com/d)"),
    '<p><a href="https://example.com/d" target="_blank" rel="noopener noreferrer">the docs</a></p>');
});

test("rendering again replaces the previous content", () => {
  const target = render("first");
  renderMarkdown(target, "second");
  assert.equal(serialize(target), "<div><p>second</p></div>");
});

test("plainText drops Markdown markers for concise summaries", () => {
  assert.equal(plainText("## **Done**: fixed `bridge.py` in [#89](https://example.com/89) ~~today~~"),
    "Done: fixed bridge.py in #89 today");
  assert.equal(plainText("- [ ] <b>raw</b> stays text"), "[ ] <b>raw</b> stays text");
  assert.equal(plainText("> 1. quoted _item_"), "quoted item");
});
