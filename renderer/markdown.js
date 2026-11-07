/**
 * Safe Markdown for the chat log (#89).
 *
 * Text is parsed into a small tree of allowlisted elements, then built with
 * createElement and text nodes; no string is ever parsed as HTML. Raw HTML stays
 * text, only http(s) and mailto links get an href, and images are never loaded.
 * Unfinished Markdown (a streamed reply) renders as far as it can and becomes
 * correct once the rest arrives. See docs/chat-markdown.md.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ATTRS = new Set(['href', 'target', 'rel', 'title', 'class', 'start']);
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'li', 'blockquote', 'tr', 'hr']);

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-{2,})[ \t]*$/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const LANGUAGE = /^[\w#+.-]{1,32}$/;
const PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[A-Za-z0-9]/;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
const BARE_URL = /https?:\/\/[^\s<]+/iy;

const element = (tag, attrs = {}, children = []) => ({ tag, attrs, children });
const text = (value) => ({ text: value });

const isBlank = (line) => /^[ \t]*$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;
const isSpace = (char) => char === undefined || /\s/.test(char);
const isPunct = (char) => char !== undefined && PUNCT.test(char);

/** A link target the browser may follow, normalised, or null. Relative URLs are refused. */
function safeHref(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

function link(href, children, title) {
  const attrs = { href, target: '_blank', rel: 'noopener noreferrer' };
  if (title) attrs.title = title;
  return element('a', attrs, children);
}

// ---------------------------------------------------------------- inline

function runLength(src, i, char) {
  let end = i;
  while (src[end] === char) end += 1;
  return end - i;
}

/**
 * Per-string scan memo, so unclosed markers cost one scan each instead of one per
 * opener (an unclosed `*` or `[` repeated thousands of times stays linear).
 */
function scanner(src) {
  return { src, spans: new Map(), brackets: null, failed: new Set() };
}

/** A code span starting at i, or null when its backtick run is never closed. */
function codeSpan(scan, i) {
  if (!scan.spans.has(i)) scan.spans.set(i, findCodeSpan(scan.src, i));
  return scan.spans.get(i);
}

function findCodeSpan(src, i) {
  const n = runLength(src, i, '`');
  for (let j = src.indexOf('`', i + n); j !== -1; j = src.indexOf('`', j)) {
    const m = runLength(src, j, '`');
    if (m === n) {
      let content = src.slice(i + n, j).replace(/\n/g, ' ');
      if (/^ .*[^ ].* $/.test(content) || /^ [^ ] $/.test(content)) content = content.slice(1, -1);
      return { node: element('code', {}, [text(content)]), end: j + n };
    }
    j += m;
  }
  return null;
}

/** Index of the ] that closes the [ at i, skipping escapes and code spans; -1 if none. */
function closingBracket(scan, i) {
  if (!scan.brackets) {
    // One pass pairs every bracket, as counting depth from each [ would.
    const { src } = scan;
    const open = [];
    scan.brackets = new Map();
    for (let k = 0; k < src.length; k += 1) {
      const char = src[k];
      if (char === '\\') k += 1;
      else if (char === '`') {
        const span = codeSpan(scan, k);
        k = (span ? span.end : k + runLength(src, k, '`')) - 1;
      } else if (char === '[') open.push(k);
      else if (char === ']' && open.length) scan.brackets.set(open.pop(), k);
    }
  }
  return scan.brackets.get(i) ?? -1;
}

/** Parse `(destination "title")` at i; returns { href, title, end } or null. */
function linkTail(src, i) {
  if (src[i] !== '(') return null;
  let k = i + 1;
  const skipSpace = () => { while (src[k] === ' ' || src[k] === '\t' || src[k] === '\n') k += 1; };
  skipSpace();
  let href = '';
  if (src[k] === '<') {
    const close = src.slice(k + 1).search(/[<>\n]/);
    if (close === -1 || src[k + 1 + close] !== '>') return null;
    href = src.slice(k + 1, k + 1 + close);
    k += close + 2;
  } else {
    let depth = 0;
    for (; k < src.length; k += 1) {
      const char = src[k];
      if (char === '\\' && isPunct(src[k + 1])) { href += src[k + 1]; k += 1; continue; }
      if (/[\s\x00-\x1f\x7f]/.test(char)) break;
      if (char === '(') depth += 1;
      if (char === ')' && depth-- === 0) break;
      href += char;
    }
  }
  const beforeTitle = k;
  skipSpace();
  let title = '';
  const open = src[k];
  if (k > beforeTitle && (open === '"' || open === "'" || open === '(')) {
    const close = open === '(' ? ')' : open;
    k += 1;
    for (; k < src.length && src[k] !== close; k += 1) {
      if (src[k] === '\\' && isPunct(src[k + 1])) k += 1;
      title += src[k];
    }
    if (src[k] !== close) return null;
    k += 1;
    skipSpace();
  }
  if (src[k] !== ')') return null;
  return { href, title, end: k + 1 };
}

/** [text](url) or, with image, ![alt](url) at the [ in i. */
function bracketLink(scan, i, image, inLink) {
  const { src } = scan;
  const close = closingBracket(scan, i);
  if (close === -1) return null;
  const tail = linkTail(src, close + 1);
  if (!tail) return null;
  const label = parseInline(src.slice(i + 1, close), true);
  const href = safeHref(tail.href);
  if (image) {
    const alt = textOf(label) || 'image';
    const node = href && !inLink ? { ...link(href, [text(`🖼️ ${alt}`)], tail.title), image: true } : text(alt);
    return { nodes: [node], end: tail.end };
  }
  if (inLink || !href) return { nodes: label, end: tail.end };
  return { nodes: [link(href, label, tail.title)], end: tail.end };
}

function autolink(src, i) {
  for (const pattern of [AUTOLINK, EMAIL]) {
    pattern.lastIndex = i;
    const match = pattern.exec(src);
    if (!match) continue;
    const href = safeHref(pattern === EMAIL ? `mailto:${match[1]}` : match[1]);
    if (!href) return null;
    return { node: link(href, [text(match[1])]), end: i + match[0].length };
  }
  return null;
}

function bareUrl(src, i) {
  const before = src[i - 1];
  if (i > 0 && !/[\s*_~(]/.test(before)) return null;
  // `](https://…` is a [text](url) still streaming in, not a bare link.
  if (before === '(' && src[i - 2] === ']') return null;
  BARE_URL.lastIndex = i;
  const match = BARE_URL.exec(src);
  if (!match) return null;
  let url = match[0];
  for (;;) {
    const last = url.at(-1);
    if (/[?!.,:;*_~'"]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
    else break;
  }
  const href = /^https?:\/\/[^/?#]/i.test(url) ? safeHref(url) : null;
  return href ? { node: link(href, [text(url)]), end: i + url.length } : null;
}

/** *em*, **strong**, ***both***, ~~del~~ (and the _ forms) at i, or null. */
function emphasis(scan, i, inLink) {
  const { src } = scan;
  const char = src[i];
  const n = runLength(src, i, char);
  if (char === '~' ? n !== 2 : n > 3) return null;
  // A closer only has to lie after the opener, so once none is left, later openers find none either.
  const key = char.repeat(n);
  if (scan.failed.has(key)) return null;
  const before = src[i - 1];
  const after = src[i + n];
  const leftFlanking = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  if (!leftFlanking || (before !== undefined && ALNUM.test(before))) return null;
  for (let j = i + n; j < src.length; j += 1) {
    const at = src[j];
    if (at === '\\') { j += 1; continue; }
    if (at === '`') {
      const span = codeSpan(scan, j);
      j = (span ? span.end : j + runLength(src, j, '`')) - 1;
      continue;
    }
    if (at !== char) continue;
    const m = runLength(src, j, char);
    const prev = src[j - 1];
    const next = src[j + m];
    const rightFlanking = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next));
    if (m === n && j > i + n && rightFlanking && !(next !== undefined && ALNUM.test(next))) {
      const inner = parseInline(src.slice(i + n, j), inLink);
      let node;
      if (char === '~') node = element('del', {}, inner);
      else if (n === 1) node = element('em', {}, inner);
      else if (n === 2) node = element('strong', {}, inner);
      else node = element('strong', {}, [element('em', {}, inner)]);
      return { node, end: j + m };
    }
    j += m - 1;
  }
  scan.failed.add(key);
  return null;
}

/** Inline Markdown to nodes. Newlines become line breaks; raw HTML stays text. */
function parseInline(src, inLink = false) {
  const scan = scanner(src);
  const out = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push(text(buffer));
    buffer = '';
  };
  const emit = (nodes, end) => {
    flush();
    out.push(...nodes);
    return end;
  };
  let i = 0;
  while (i < src.length) {
    const char = src[i];
    let found = null;
    if (char === '\\' && isPunct(src[i + 1])) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }
    if (char === '\n') {
      i = emit([element('br')], i + 1);
      continue;
    }
    if (char === '`') {
      found = codeSpan(scan, i);
      if (found) { i = emit([found.node], found.end); continue; }
      const n = runLength(src, i, '`');
      buffer += src.slice(i, i + n);
      i += n;
      continue;
    }
    if (char === '!' && src[i + 1] === '[') {
      found = bracketLink(scan, i + 1, true, inLink);
      if (found) { i = emit(found.nodes, found.end); continue; }
    }
    if (char === '[') {
      found = bracketLink(scan, i, false, inLink);
      if (found) { i = emit(found.nodes, found.end); continue; }
    }
    if (char === '<' && !inLink) {
      found = autolink(src, i);
      if (found) { i = emit([found.node], found.end); continue; }
    }
    if ((char === 'h' || char === 'H') && !inLink) {
      found = bareUrl(src, i);
      if (found) { i = emit([found.node], found.end); continue; }
    }
    if (char === '*' || char === '_' || char === '~') {
      found = emphasis(scan, i, inLink);
      if (found) { i = emit([found.node], found.end); continue; }
      const n = runLength(src, i, char);
      buffer += src.slice(i, i + n);
      i += n;
      continue;
    }
    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- blocks

function listMarker(line) {
  const match = LIST.exec(line);
  if (!match) return null;
  const [, indent, marker, gap, rest] = match;
  const ordered = /\d/.test(marker[0]);
  const spaces = gap.replace(/\t/g, '    ').length;
  const width = indent.length + marker.length + (rest === '' || spaces > 4 ? 1 : spaces);
  return {
    ordered,
    kind: ordered ? marker.at(-1) : marker,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    width,
    first: spaces > 4 ? ' '.repeat(spaces - 1) + rest : rest,
    empty: rest === '',
  };
}

/** Split a table row on unescaped pipes outside code spans; `\|` becomes `|`. */
function tableCells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  const scan = scanner(row);
  const cells = [];
  let cell = '';
  for (let k = 0; k < row.length; k += 1) {
    const char = row[k];
    if (char === '\\' && row[k + 1] === '|') { cell += '|'; k += 1; continue; }
    if (char === '`') {
      const span = codeSpan(scan, k);
      const end = span ? span.end : k + runLength(row, k, '`');
      cell += row.slice(k, end);
      k = end - 1;
      continue;
    }
    if (char === '|') { cells.push(cell); cell = ''; continue; }
    cell += char;
  }
  if (cell.trim() !== '' || !row.endsWith('|')) cells.push(cell);
  return cells.map((value) => value.trim());
}

function isTableStart(line, next) {
  if (next === undefined || !line.includes('|') || !next.includes('|') || !DELIMITER_ROW.test(next)) return false;
  return tableCells(line).length === tableCells(next).length;
}

/** True when line starts a block that ends a paragraph. */
function interrupts(line, next) {
  if (FENCE.test(line) && !(/^ {0,3}`/.test(line) && FENCE.exec(line)[3].includes('`'))) return true;
  if (ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const marker = listMarker(line);
  if (marker && !marker.empty && (!marker.ordered || marker.start === 1)) return true;
  return isTableStart(line, next);
}

function parseFence(lines, i, match) {
  const [, indent, fence, info] = match;
  const char = fence[0];
  if (char === '`' && info.includes('`')) return null;
  const language = info.trim().split(/\s+/)[0];
  const body = [];
  let k = i + 1;
  for (; k < lines.length; k += 1) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[k]);
    if (close && close[1][0] === char && close[1].length >= fence.length) { k += 1; break; }
    body.push(lines[k].replace(new RegExp(`^ {0,${indent.length}}`), ''));
  }
  const attrs = LANGUAGE.test(language) ? { class: `language-${language}` } : {};
  return { node: element('pre', {}, [element('code', attrs, [text(body.join('\n'))])]), end: k };
}

function parseList(lines, i) {
  const first = listMarker(lines[i]);
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const marker = listMarker(lines[i]);
    if (!marker || marker.ordered !== first.ordered || marker.kind !== first.kind || HR.test(lines[i])) break;
    const body = [marker.first];
    let sawBlank = false;
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { body.push(''); sawBlank = true; i += 1; continue; }
      if (indentOf(line) >= marker.width) { body.push(line.slice(marker.width)); sawBlank = false; i += 1; continue; }
      if (sawBlank || listMarker(line) || interrupts(line, lines[i + 1])) break;
      body.push(line.trimStart());
      i += 1;
    }
    let trailing = false;
    while (body.length > 1 && body.at(-1) === '') { body.pop(); trailing = true; }
    if (body.includes('')) loose = true;
    items.push(body);
    if (trailing && i < lines.length && listMarker(lines[i])?.kind === first.kind) loose = true;
  }
  const children = items.map((body) => {
    const blocks = parseBlocks(body);
    const content = loose ? blocks : blocks.flatMap((block) => (block.tag === 'p' ? block.children : [block]));
    return element('li', {}, content);
  });
  const attrs = first.ordered && first.start !== 1 ? { start: String(first.start) } : {};
  return { node: element(first.ordered ? 'ol' : 'ul', attrs, children), end: i };
}

function parseTable(lines, i) {
  const header = tableCells(lines[i]);
  const aligns = tableCells(lines[i + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : null;
  });
  const row = (cells, tag) => element('tr', {}, header.map((_, column) => {
    const attrs = aligns[column] ? { class: `md-align-${aligns[column]}` } : {};
    return element(tag, attrs, parseInline(cells[column] ?? ''));
  }));
  const body = [];
  let k = i + 2;
  for (; k < lines.length && !isBlank(lines[k]) && lines[k].includes('|'); k += 1) body.push(row(tableCells(lines[k]), 'td'));
  const sections = [element('thead', {}, [row(header, 'th')])];
  if (body.length) sections.push(element('tbody', {}, body));
  return { node: element('div', { class: 'md-table' }, [element('table', {}, sections)]), end: k };
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    let match = FENCE.exec(line);
    const fence = match && parseFence(lines, i, match);
    if (fence) { out.push(fence.node); i = fence.end; continue; }
    if ((match = ATX.exec(line))) {
      out.push(element(`h${match[1].length}`, {}, parseInline(match[2] ?? '')));
      i += 1;
      continue;
    }
    if (HR.test(line)) { out.push(element('hr')); i += 1; continue; }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !interrupts(lines[i], lines[i + 1]))) {
        quoted.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      out.push(element('blockquote', {}, parseBlocks(quoted)));
      continue;
    }
    if (listMarker(line)) {
      const list = parseList(lines, i);
      out.push(list.node);
      i = list.end;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const table = parseTable(lines, i);
      out.push(table.node);
      i = table.end;
      continue;
    }
    const paragraph = [line.trim()];
    let heading = null;
    for (i += 1; i < lines.length; i += 1) {
      const next = lines[i];
      const setext = SETEXT.exec(next);
      if (setext) { heading = setext[1][0] === '=' ? 'h1' : 'h2'; i += 1; break; }
      if (isBlank(next) || interrupts(next, lines[i + 1])) break;
      paragraph.push(next.trim());
    }
    out.push(element(heading ?? 'p', {}, parseInline(paragraph.join(heading ? ' ' : '\n'))));
  }
  return out;
}

function parse(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  if (lines.at(-1) === '') lines.pop();
  return parseBlocks(lines);
}

// ---------------------------------------------------------------- output

function textOf(nodes) {
  return nodes.map((node) => node.text ?? textOf(node.children)).join('');
}

function build(node, document) {
  if (node.text !== undefined) return document.createTextNode(node.text);
  if (!TAGS.has(node.tag)) throw new Error(`Unexpected Markdown element ${node.tag}`);
  const out = document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) if (ATTRS.has(name)) out.setAttribute(name, value);
  if (node.image) out.setAttribute('class', 'md-image');
  out.append(...node.children.map((child) => build(child, document)));
  return out;
}

/** Replace target's content with source rendered as Markdown. */
export function renderMarkdown(target, source) {
  const document = target.ownerDocument;
  target.replaceChildren(...parse(source).map((node) => build(node, document)));
}

/** The readable text of source with Markdown markers removed, for one-line summaries. */
export function plainText(source) {
  const walk = (nodes) => nodes.map((node) => {
    if (node.text !== undefined) return node.text;
    if (node.tag === 'br') return '\n';
    const inner = walk(node.children);
    if (node.tag === 'th' || node.tag === 'td') return `${inner} `;
    return BLOCKS.has(node.tag) ? `${inner}\n` : inner;
  }).join('');
  return walk(parse(source)).replace(/[ \t]*\n+[ \t]*/g, '\n').trim();
}
