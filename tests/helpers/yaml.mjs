// Minimal YAML subset parser — zero dependencies.
//
// WHY THIS EXISTS: `yq` is not installed and CLAUDE.md forbids shelling out to
// it; the repo is zero-runtime-dep by policy and CI has no `npm install` step,
// so pulling in the `yaml` package would break `node --test` on a fresh clone.
//
// SCOPE: exactly the constructs used by `spec/openapi.yaml` and the spec
// fixtures in `tests/fixtures/spec/`:
//   block mappings, block sequences, plain / single- / double-quoted scalars,
//   multi-line plain-scalar continuations, folded (`>`) and literal (`|`) block
//   scalars with `-`/`+` chomping, single-line flow collections (`[]`, `{}`,
//   `[a, b]`, `{a: b}`), and `#` comments.
//
// SAFETY: anything outside that scope (anchors, aliases, tags, merge keys,
// multi-document streams, multi-line flow collections, complex keys) THROWS a
// `YamlError`. A parser that silently mis-reads a pricing block is worse than
// one that refuses, so this one refuses loudly.

export class YamlError extends Error {
  constructor (message, line) {
    super(line == null ? message : `${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line ?? null;
  }
}

const UNSUPPORTED = [
  [/^---\s*$/, 'multi-document streams are not supported'],
  [/^\.\.\.\s*$/, 'document end markers are not supported'],
  [/^\?\s/, 'complex mapping keys are not supported'],
  [/^<<\s*:/, 'merge keys are not supported']
];

function scan (text) {
  const src = String(text).replace(/\r\n/g, '\n').replace(/^﻿/, '');
  const out = [];
  const lines = src.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (raw.includes('\t')) {
      const before = raw.slice(0, raw.indexOf('\t'));
      // Tabs are legal inside a scalar but never as indentation.
      if (!before.trim()) throw new YamlError('tab character used as indentation', idx + 1);
    }
    const trimmedStart = raw.length - raw.replace(/^ +/, '').length;
    const content = raw.slice(trimmedStart).replace(/\s+$/, '');
    out.push({ n: idx + 1, indent: trimmedStart, text: content, raw });
  }
  return out;
}

/**
 * Parse a YAML subset document into plain JS values.
 * @param {string} text
 * @returns {any}
 */
export function parseYaml (text) {
  const lines = scan(text);
  const st = { lines, i: 0 };

  // Reject unsupported constructs up front so failures name the real cause.
  for (const l of lines) {
    if (!l.text || l.text.startsWith('#')) continue;
    for (const [re, msg] of UNSUPPORTED) {
      if (re.test(l.text)) throw new YamlError(msg, l.n);
    }
  }

  skipIgnorable(st);
  if (st.i >= lines.length) return null;
  const value = parseNode(st, lines[st.i].indent);
  skipIgnorable(st);
  if (st.i < lines.length) {
    throw new YamlError(`unexpected content after end of document: ${lines[st.i].text}`, lines[st.i].n);
  }
  return value;
}

/** Parse a YAML file from disk. */
export async function parseYamlFile (filePath) {
  const { readFile } = await import('node:fs/promises');
  return parseYaml(await readFile(filePath, 'utf8'));
}

function skipIgnorable (st) {
  while (st.i < st.lines.length) {
    const l = st.lines[st.i];
    if (l.text === '' || l.text.startsWith('#')) st.i++;
    else break;
  }
}

function parseNode (st, indent) {
  skipIgnorable(st);
  if (st.i >= st.lines.length) return null;
  const l = st.lines[st.i];
  if (l.indent < indent) return null;
  if (isSeqItem(l.text)) return parseSeq(st, l.indent);
  return parseMap(st, l.indent);
}

function isSeqItem (text) {
  return text === '-' || /^-\s/.test(text);
}

function parseMap (st, indent) {
  const obj = {};
  for (;;) {
    skipIgnorable(st);
    if (st.i >= st.lines.length) break;
    const l = st.lines[st.i];
    if (l.indent < indent) break;
    if (l.indent > indent) {
      throw new YamlError(`unexpected indentation (expected ${indent}, got ${l.indent})`, l.n);
    }
    if (isSeqItem(l.text)) break;
    const { key, rest } = splitKey(l.text, l.n);
    st.i++;
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new YamlError(`duplicate mapping key "${key}"`, l.n);
    }
    obj[key] = parseValue(st, rest, indent, l.n);
  }
  return obj;
}

function parseSeq (st, indent) {
  const arr = [];
  for (;;) {
    skipIgnorable(st);
    if (st.i >= st.lines.length) break;
    const l = st.lines[st.i];
    if (l.indent < indent) break;
    if (l.indent > indent) {
      throw new YamlError(`unexpected indentation in sequence (expected ${indent}, got ${l.indent})`, l.n);
    }
    if (!isSeqItem(l.text)) break;

    if (l.text === '-') {
      st.i++;
      arr.push(parseNode(st, indent + 1));
      continue;
    }
    const gap = l.text.match(/^-(\s+)/)[1];
    const rest = l.text.slice(1 + gap.length);
    const innerIndent = indent + 1 + gap.length;
    st.i++;
    if (looksLikeMappingEntry(rest)) {
      // Re-present the inline entry as a normal mapping line, then let
      // parseMap absorb any sibling lines at the same inner indent.
      st.lines[st.i - 1] = { n: l.n, indent: innerIndent, text: rest, raw: l.raw };
      st.i--;
      arr.push(parseMap(st, innerIndent));
    } else if (isSeqItem(rest)) {
      throw new YamlError('nested inline sequences are not supported', l.n);
    } else {
      st.lines[st.i - 1] = { n: l.n, indent: innerIndent, text: rest, raw: l.raw };
      st.i--;
      const line = st.lines[st.i];
      st.i++;
      arr.push(parseValue(st, line.text, innerIndent - 1, l.n));
    }
  }
  return arr;
}

function looksLikeMappingEntry (rest) {
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const end = findQuoteEnd(rest);
    if (end < 0) return false;
    const after = rest.slice(end + 1);
    return after === ':' || after.startsWith(': ');
  }
  if (rest.startsWith('[') || rest.startsWith('{')) return false;
  const idx = rest.indexOf(': ');
  if (idx > 0) return true;
  return rest.endsWith(':') && rest.length > 1;
}

function findQuoteEnd (s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

function splitKey (text, n) {
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new YamlError('anchors, aliases and tags are not supported', n);
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = findQuoteEnd(text);
    if (end < 0) throw new YamlError('unterminated quoted mapping key', n);
    const key = unquote(text.slice(0, end + 1), n);
    const after = text.slice(end + 1);
    if (after === ':') return { key, rest: '' };
    if (after.startsWith(': ')) return { key, rest: after.slice(2) };
    throw new YamlError('expected ":" after quoted mapping key', n);
  }
  const idx = text.indexOf(': ');
  if (idx > 0) return { key: text.slice(0, idx), rest: text.slice(idx + 2) };
  if (text.endsWith(':') && text.length > 1) return { key: text.slice(0, -1), rest: '' };
  throw new YamlError(`expected a mapping key, got: ${text}`, n);
}

function parseValue (st, rest, parentIndent, n) {
  const head = rest.trim();

  if (head === '' || head.startsWith('#')) {
    const child = parseNode(st, parentIndent + 1);
    return child === null ? null : child;
  }
  if (/^[|>][-+]?$/.test(head)) return parseBlockScalar(st, head, parentIndent);
  if (/^[|>][-+]?\d/.test(head)) throw new YamlError('explicit block-scalar indentation indicators are not supported', n);

  if (head.startsWith('&') || head.startsWith('*') || head.startsWith('!')) {
    throw new YamlError('anchors, aliases and tags are not supported', n);
  }

  if (head.startsWith('[') || head.startsWith('{')) {
    return parseFlow(head, n);
  }

  if (head.startsWith('"') || head.startsWith("'")) {
    // A quoted scalar may fold across deeper-indented following lines.
    let buf = head;
    while (findQuoteEnd(buf) < 0) {
      if (st.i >= st.lines.length) throw new YamlError('unterminated quoted scalar', n);
      const l = st.lines[st.i];
      if (l.indent <= parentIndent || l.text === '') throw new YamlError('unterminated quoted scalar', n);
      buf += ' ' + l.text;
      st.i++;
    }
    const end = findQuoteEnd(buf);
    const tail = buf.slice(end + 1).trim();
    if (tail && !tail.startsWith('#')) throw new YamlError(`unexpected text after quoted scalar: ${tail}`, n);
    return unquote(buf.slice(0, end + 1), n);
  }

  // Plain scalar, possibly continued on deeper-indented following lines.
  const parts = [stripComment(head)];
  while (st.i < st.lines.length) {
    const l = st.lines[st.i];
    if (l.text === '') break;
    if (l.text.startsWith('#')) break;
    if (l.indent <= parentIndent) break;
    parts.push(stripComment(l.text));
    st.i++;
  }
  return coerce(parts.join(' ').trim());
}

function stripComment (s) {
  const m = s.match(/\s#/);
  if (!m) return s;
  return s.slice(0, m.index).replace(/\s+$/, '');
}

function parseBlockScalar (st, header, parentIndent) {
  const style = header[0];
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
  const collected = [];
  let baseIndent = null;
  while (st.i < st.lines.length) {
    const l = st.lines[st.i];
    if (l.text === '') { collected.push(null); st.i++; continue; }
    if (l.indent <= parentIndent) break;
    if (baseIndent === null) baseIndent = l.indent;
    collected.push(l.raw.slice(Math.min(baseIndent, l.indent)));
    st.i++;
  }
  while (collected.length && collected[collected.length - 1] === null) collected.pop();
  if (baseIndent === null) return '';

  const rows = collected.map(v => (v === null ? '' : v));
  let body;
  if (style === '|') {
    body = rows.join('\n');
  } else {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const moreIndented = /^\s/.test(row) && row.trim() !== '';
      if (row === '') { out.push('\n'); continue; }
      if (moreIndented) { out.push((out.length && !out[out.length - 1].endsWith('\n') ? '\n' : '') + row + '\n'); continue; }
      if (out.length && !out[out.length - 1].endsWith('\n')) out.push(' ');
      out.push(row);
    }
    body = out.join('').replace(/\n(?!\n)/g, '\n');
  }
  if (chomp === 'strip') return body.replace(/\n+$/, '');
  if (chomp === 'keep') return body + '\n';
  return body.replace(/\n+$/, '') + '\n';
}

function parseFlow (text, n) {
  const s = text.trim();
  let pos = 0;

  function ws () { while (pos < s.length && /\s/.test(s[pos])) pos++; }
  function value () {
    ws();
    if (s[pos] === '[') return seq();
    if (s[pos] === '{') return map();
    return scalar();
  }
  function seq () {
    pos++; ws();
    const out = [];
    if (s[pos] === ']') { pos++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (s[pos] === ',') { pos++; continue; }
      if (s[pos] === ']') { pos++; return out; }
      throw new YamlError('malformed flow sequence (multi-line flow collections are not supported)', n);
    }
  }
  function map () {
    pos++; ws();
    const out = {};
    if (s[pos] === '}') { pos++; return out; }
    for (;;) {
      ws();
      const k = scalarUntil(/[:]/);
      ws();
      if (s[pos] !== ':') throw new YamlError('malformed flow mapping', n);
      pos++;
      out[String(k)] = value();
      ws();
      if (s[pos] === ',') { pos++; continue; }
      if (s[pos] === '}') { pos++; return out; }
      throw new YamlError('malformed flow mapping (multi-line flow collections are not supported)', n);
    }
  }
  function scalarUntil (stop) {
    ws();
    if (s[pos] === '"' || s[pos] === "'") return quoted();
    let start = pos;
    while (pos < s.length && !stop.test(s[pos]) && s[pos] !== ',' && s[pos] !== ']' && s[pos] !== '}') pos++;
    return coerce(s.slice(start, pos).trim());
  }
  function scalar () {
    if (s[pos] === '"' || s[pos] === "'") return quoted();
    return scalarUntil(/[ ]/);
  }
  function quoted () {
    const sub = s.slice(pos);
    const end = findQuoteEnd(sub);
    if (end < 0) throw new YamlError('unterminated quoted scalar in flow collection', n);
    const out = unquote(sub.slice(0, end + 1), n);
    pos += end + 1;
    return out;
  }

  const out = value();
  ws();
  if (pos < s.length && !s.slice(pos).trim().startsWith('#')) {
    throw new YamlError(`unexpected text after flow collection: ${s.slice(pos)}`, n);
  }
  return out;
}

function unquote (tok, n) {
  const q = tok[0];
  const body = tok.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '\\': return '\\';
      case '"': return '"';
      case '/': return '/';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: throw new YamlError(`unsupported escape sequence \\${esc}`, n);
    }
  });
}

const INT_RE = /^-?(0|[1-9]\d*)$/;
const FLOAT_RE = /^-?(0|[1-9]\d*)?\.\d+$/;
const EXP_RE = /^-?(0|[1-9]\d*)(\.\d+)?[eE][-+]?\d+$/;

function coerce (raw) {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
  if (INT_RE.test(raw) || FLOAT_RE.test(raw) || EXP_RE.test(raw)) return Number(raw);
  return raw;
}

export default { parseYaml, parseYamlFile, YamlError };
