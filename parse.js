// A quick, dependency-free stand-in for marked 18.1.3 (default settings:
// GFM enabled, hard breaks disabled, pedantic and async disabled).
// Hand-built one-pass renderer: block parsing walks the lines a single
// time, inline parsing runs in one sweep with a delimiter stack for
// emphasis, and HTML goes straight into an output array.
// parse() keeps no state between invocations.

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_TAG_SET = new Set(HTML_BLOCK_TAGS.split('|'));

// ASCII punctuation a backslash is allowed to escape.
function isAsciiPunct(char) {
  return (char >= '!' && char <= '/') || (char >= ':' && char <= '@') ||
    (char >= '[' && char <= '`') || (char >= '{' && char <= '~');
}
function isSpaceChar(char) { return char === ' ' || char === '\t' || char === '\n' || char === '\r'; }
function isDigitChar(char) { return char >= '0' && char <= '9'; }
function isAlphaNumeric(char) {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || isDigitChar(char);
}
// Case-insensitive prefix test at text[at], without building a
// lower-cased copy (used on the hot path in matchBareLink, probed at every
// word starting with h/f/w/m/x). Only ASCII letters fold; ':' '/' '.'
// are compared exactly.
function startsWithFolded(text, at, needle) {
  for (let k = 0; k < needle.length; k++) {
    const codeA = text.charCodeAt(at + k);
    const codeB = needle.charCodeAt(k);
    if (codeA === codeB) continue;
    if (codeB >= 97 && codeB <= 122 && codeA === codeB - 32) continue;
    return false;
  }
  return true;
}
function isBlankSpace(char) { return char === ' ' || char === '\t'; }

// Escape text for HTML output. When encode is off, an ampersand that
// begins something entity-like (&word; or &#123; or &#x1f;) is left
// untouched, exactly as marked leaves it; < > " ' are always escaped.
const ESCAPE_PATTERN = /&(?:#[0-9]+;|#[xX][0-9A-Fa-f]+;|[A-Za-z0-9_]+;)|[<>"'&]/g;
function escapeText(text) {
  if (text.indexOf('&') < 0 && text.indexOf('<') < 0 && text.indexOf('>') < 0 &&
      text.indexOf('"') < 0 && text.indexOf("'") < 0) return text;
  ESCAPE_PATTERN.lastIndex = 0;
  return text.replace(ESCAPE_PATTERN, (match) => {
    if (match === '&') return '&amp;';
    if (match === '<') return '&lt;';
    if (match === '>') return '&gt;';
    if (match === '"') return '&quot;';
    if (match === "'") return '&#39;';
    return match; // a plausible entity: leave it alone.
  });
}

// Escape where every & turns into &amp; (code spans, plus the href/title
// of autolinks).
function escapeFullText(text) {
  if (text.indexOf('&') < 0 && text.indexOf('<') < 0 && text.indexOf('>') < 0 &&
      text.indexOf('"') < 0 && text.indexOf("'") < 0) return text;
  let buf = '';
  for (let idx = 0; idx < text.length; idx++) {
    const ch = text[idx];
    if (ch === '&') buf += '&amp;';
    else if (ch === '<') buf += '&lt;';
    else if (ch === '>') buf += '&gt;';
    else if (ch === '"') buf += '&quot;';
    else if (ch === "'") buf += '&#39;';
    else buf += ch;
  }
  return buf;
}

// Decode a numeric character reference starting at text[at] === '&'.
// Returns {len, ch} or null when it is not a valid numeric reference.
function numericCharRef(text, at) {
  if (text[at + 1] !== '#') return null;
  let pos = at + 2;
  let code = 0;
  if (text[pos] === 'x' || text[pos] === 'X') {
    pos++;
    const start = pos;
    while (pos < text.length && pos < start + 6) {
      const ch = text[pos];
      let digit = -1;
      if (ch >= '0' && ch <= '9') digit = ch.charCodeAt(0) - 48;
      else if (ch >= 'a' && ch <= 'f') digit = ch.charCodeAt(0) - 87;
      else if (ch >= 'A' && ch <= 'F') digit = ch.charCodeAt(0) - 55;
      else break;
      code = code * 16 + digit;
      pos++;
    }
    if (pos === start || text[pos] !== ';') return null;
  } else {
    const start = pos;
    while (pos < text.length && pos < start + 7 && isDigitChar(text[pos])) { code = code * 10 + (text[pos].charCodeAt(0) - 48); pos++; }
    if (pos === start || text[pos] !== ';') return null;
  }
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return { len: pos + 1 - at, ch: '�' };
  return { len: pos + 1 - at, ch: String.fromCodePoint(code) };
}

// A link destination / title cleaned the way marked does it: encodeURI,
// with %25 folded back to %, then entity-aware escaping for the attribute.
function cleanLinkHref(raw) {
  let cleaned = raw;
  try { cleaned = encodeURI(cleaned).replace(/%25/g, '%'); } catch (err) { /* lone surrogate: keep as-is */ }
  return escapeText(cleaned);
}

// Normalise a link label: unescape backslash-escaped punctuation, collapse
// whitespace runs to one space, trim, lower-case.
// Does the label hold a `[` that is not backslash-escaped?
function hasRawBracket(text) {
  for (let idx = 0; idx < text.length; idx++) {
    if (text[idx] === '\\') { idx++; continue; }
    if (text[idx] === '[') return true;
  }
  return false;
}

function normalizeLinkLabel(text) {
  // Labels match after case folding + whitespace collapsing, WITHOUT
  // unescaping backslashes: `[foo\!]` does not match `[foo!]` (cm-545),
  // while `[Foo*bar\]]` matches itself (cm-194). Unicode case folding:
  // ß (U+00DF) and ẞ (U+1E9E) both fold to "ss" (cm-540).
  return text.replace(/ß|ẞ/g, 'ss').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Is the character at position i the start of a word character for the
// purposes of flanking checks? Punctuation = ASCII punctuation or any
// Unicode punctuation/symbol. Letters and numbers (any script, incl.
// Cyrillic) are NOT punctuation.
function isPunctuationChar(char) {
  if (!char) return false;
  if (isSpaceChar(char)) return false;
  const cp = char.codePointAt(0);
  if (cp < 128) return isAsciiPunct(char);
  return !/\p{L}|\p{N}/u.test(char);
}
function isUnicodePunctuation(char) {
  if (!char) return false;
  const cp = char.codePointAt(0);
  if (cp < 128) return isAsciiPunct(char);
  // Letters and numbers (incl. astral) are not punctuation; everything
  // else that is not whitespace counts as punctuation here.
  if (char === ' ' || char === '\t' || char === '\n') return false;
  return !/\p{L}|\p{N}/u.test(char);
}

// ---- inline helpers -------------------------------------------------------

// Skip spaces, tabs and single newlines (but never a blank line: two \n).
// Returns the new index, or -1 if a blank line is hit.
function skipInlineBlanks(text, at) {
  const len = text.length;
  while (at < len) {
    const ch = text[at];
    if (ch === ' ' || ch === '\t') { at++; continue; }
    if (ch === '\n') {
      if (text[at + 1] === '\n') return -1;
      at++; continue;
    }
    break;
  }
  return at;
}

// Parse a link destination starting at text[at] (after '(' or after the ': '
// of a reference definition, where leading space was already skipped).
// Returns {href, end} or null. Handles <...> and bare destinations.
function parseLinkDestination(text, at) {
  const len = text.length;
  if (at >= len) return null;
  if (text[at] === '<') {
    let pos = at + 1;
    let buf = '';
    while (pos < len) {
      const ch = text[pos];
      if (ch === '\n' || ch === '<') return null;
      if (ch === '>') return { href: buf, end: pos + 1 };
      if (ch === '\\' && pos + 1 < len && isAsciiPunct(text[pos + 1])) { buf += text[pos + 1]; pos += 2; continue; }
      buf += ch; pos++;
    }
    return null;
  }
  let pos = at;
  let buf = '';
  let depth = 0;
  while (pos < len) {
    const ch = text[pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    if (ch === '\\') {
      if (pos + 1 < len && isAsciiPunct(text[pos + 1])) { buf += text[pos + 1]; pos += 2; continue; }
      // Backslash before a non-punctuation char is a literal backslash.
      buf += '\\'; pos++; continue;
    }
    if (ch === '(') { depth++; buf += ch; pos++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; buf += ch; pos++; continue;
    }
    if (ch < ' ') return null;
    buf += ch; pos++;
  }
  if (pos === at) return null;
  return { href: buf, end: pos };
}

// Parse a link title starting at text[at] (the opening " ' or (). Returns
// {title, end} or null.
// Parse a link title that may span lines. lineAt(k) returns the k-th
// virtual line {text} or null. Returns {title, endVk, endIdx} or null.
// A title may contain single newlines but not a blank line.
function parseTitleText(lineAt, row, col) {
  const head = lineAt(row);
  if (!head) return null;
  const quote = head.text[col];
  if (quote !== '"' && quote !== "'" && quote !== '(') return null;
  const closer = quote === '(' ? ')' : quote;
  let lineIdx = row, charIdx = col + 1;
  let buf = '';
  for (;;) {
    const line = lineAt(lineIdx);
    if (!line) return null;
    const text = line.text;
    while (charIdx < text.length) {
      const ch = text[charIdx];
      if (ch === '\\' && charIdx + 1 < text.length) {
        const next = text[charIdx + 1];
        // Only a backslash before ASCII punctuation is an escape (the
        // backslash is dropped); before any other char it stays literal.
        if (isAsciiPunct(next)) { buf += next; charIdx += 2; continue; }
      }
      if (ch === closer) return { title: buf, endVk: lineIdx, endIdx: charIdx + 1 };
      buf += ch; charIdx++;
    }
    // End of line: a single newline is part of the title (unless the next
    // line is blank, which ends the definition).
    const following = lineAt(lineIdx + 1);
    if (!following || isBlankAtPos(following.text, 0)) return null;
    buf += '\n';
    lineIdx++; charIdx = 0;
  }
}

function parseLinkTitle(text, at) {
  const len = text.length;
  const quote = text[at];
  if (quote !== '"' && quote !== "'" && quote !== '(') return null;
  const closer = quote === '(' ? ')' : quote;
  let pos = at + 1;
  let buf = '';
  while (pos < len) {
    const ch = text[pos];
    if (ch === '\\' && pos + 1 < len) {
      const next = text[pos + 1];
      // Only a backslash before ASCII punctuation is an escape.
      if (isAsciiPunct(next)) { buf += next; pos += 2; continue; }
    }
    if (ch === closer) return { title: buf, end: pos + 1 };
    if (quote === "'" || quote === '(') {
      if (ch === '\n') {
        if (text[pos + 1] === '\n') return null;
        buf += ch; pos++; continue;
      }
    }
    buf += ch; pos++;
  }
  return null;
}

// Find the index just past the matching ']' for the '[' at text[from],
// skipping code spans and escaped brackets. Returns -1 if none.
// Does a link label (the raw text between `[` and `]`) contain an
// unclosed code span under marked's LENIENT label scan? A backtick run
// opens a span and the NEXT run (any length) closes it; a run of 2+
// backticks at the very end of the label is consumed by marked's
// `` ``+(?=\]) `` alternative and is not unclosed. An unclosed span
// swallows the `]`, so the link does not form (doc-16/18/20/22/23:
// `[at `` a ` b ``_]` and `[public updates `` a ` b `` in uses]`).
function labelHasOpenSpan(text) {
  let idx = 0;
  const len = text.length;
  let open = false;
  while (idx < len) {
    if (text[idx] === '`') {
      let end = idx;
      while (end < len && text[end] === '`') end++;
      if (!open) {
        if (end === len && end - idx >= 2) return false;
        open = true;
      } else {
        open = false;
      }
      idx = end;
    } else if (text[idx] === '\\' && idx + 1 < len) {
      idx += 2;
    } else {
      idx++;
    }
  }
  return open;
}

// Strict version: a backtick run opens a span that closes ONLY at a run
// of the SAME length (marked's code-span tokenizer is strict). A run of
// 2+ backticks at the very end of the label is consumed (alternative 4)
// and is not unclosed. Used by the code-span guard: `[run ``response`]` 
// has an unclosed `` `` `` (no run of length 2 follows), so the single
// backtick after `response` is free to open a code span that swallows
// the `]` (doc-35) — the link never forms there.
function labelHasOpenSpanStrict(text) {
  let idx = 0;
  const len = text.length;
  let openLen = 0;
  while (idx < len) {
    if (text[idx] === '`') {
      let end = idx;
      while (end < len && text[end] === '`') end++;
      const runLen = end - idx;
      if (openLen === 0) {
        if (end === len && runLen >= 2) return false;
        openLen = runLen;
      } else if (runLen === openLen) {
        openLen = 0;
      }
      idx = end;
    } else if (text[idx] === '\\' && idx + 1 < len) {
      idx += 2;
    } else {
      idx++;
    }
  }
  return openLen !== 0;
}

function findLabelClose(text, from) {
  // A label ends at the FIRST unescaped `]` (code spans aside). Nested
  // brackets do NOT extend it: `[ref[bar]]` has label `ref[bar`, so it
  // matches no definition (cm-547); `[[[foo]]]` likewise (cm-548).
  // A code span inside a label closes at the FIRST backtick run after
  // the opening, of ANY length (marked's label regex is lenient about
  // run lengths, and a `]` inside the span's content does not end the
  // label): `[not a `link](/foo`]` skips the span so the `]` inside
  // does not end it (cm-342); `[docs each ``url`]` closes the span at
  // the single backtick, so the `]` right after ends the label
  // (doc-09). If no closing run exists, the backticks are literal.
  const len = text.length;
  let idx = from;
  while (idx < len) {
    const ch = text[idx];
    if (ch === '`') {
      let end = idx;
      while (end < len && text[end] === '`') end++;
      // First backtick run after the opening (any length). A ']' in
      // between is span content, not a label end.
      let scan = end;
      let closePos = -1;
      while (scan < len) {
        if (text[scan] === '`') {
          let runEnd = scan;
          while (runEnd < len && text[runEnd] === '`') runEnd++;
          closePos = runEnd;
          break;
        }
        if (text[scan] === '\\' && scan + 1 < len) { scan += 2; continue; }
        scan++;
      }
      if (closePos < 0) {
        // No closing backtick run. Marked's label regex has one more
        // alternative: `` ``+(?=\]) `` — a run of 2+ backticks immediately
        // before `]` is consumed as a unit and the `]` ends the label
        // (doc-16 `[at `` a ` b ``]` forms a link). Otherwise the span is
        // unclosed and swallows the rest, so no `]` ends the label and
        // the link does not form (`[at `` a ` b ``_]` does not).
        if (end - idx >= 2 && text[end] === ']') return end + 1;
        return -1;
      }
      idx = closePos; continue;
    }
    if (ch === '\\' && idx + 1 < len) { idx += 2; continue; }
    if (ch === ']') return idx + 1;
    idx++;
  }
  return -1;
}

// Find the index just past the closing backtick run of length `len`
// starting at or after text[at]. Returns -1 if none.
function findCodeSpanClose(text, at, len) {
  const total = text.length;
  let pos = at;
  while (pos < total) {
    if (text[pos] === '`') {
      let end = pos;
      while (end < total && text[end] === '`') end++;
      if (end - pos === len) return end;
      pos = end;
    } else pos++;
  }
  return -1;
}

// Trim an extended autolink the way marked does: trailing punctuation
// (except a ) that closes an earlier () is dropped, an unmatched ( cuts
// the link off, and a trailing ; / & is dropped.
function trimUrlString(url) {
  let cut = url.length;
  // A trailing `&...;` (entity-like) is not part of the URL (gfm-627
  // `...&hl;` links only up to `commonmark`).
  const entity = /&[#A-Za-z0-9]+;$/.exec(url.slice(0, cut));
  if (entity) cut -= entity[0].length;
  // An unmatched '(' truncates the link at the '('.
  let depth = 0;
  let cutAt = -1;
  for (let idx = 0; idx < cut; idx++) {
    if (url[idx] === '(') depth++;
    else if (url[idx] === ')') { if (depth > 0) depth--; }
  }
  if (depth > 0) {
    // Find the first '(' that never closes.
    depth = 0;
    for (let idx = 0; idx < cut; idx++) {
      if (url[idx] === '(') { if (depth === 0) cutAt = idx; depth++; }
      else if (url[idx] === ')') { if (depth > 0) depth--; }
    }
    if (cutAt >= 0) cut = cutAt;
  }
  const TRAILING = '?!.,:;*_\'"~&(';
  while (cut > 0) {
    const ch = url[cut - 1];
    if (ch === ')') {
      // Keep a trailing ')' only when it closes an earlier '(' (depth
      // just before it is > 0). A ')' at depth 0 (no open paren) does
      // not make a LATER trailing ')' unmatched: in
      // `https://a.com)](https://b.com)` the final ')' closes the '('
      // before b.com and is kept, even though the ')' after a.com is
      // unmatched.
      let bal = 0;
      for (let idx = 0; idx < cut - 1; idx++) {
        if (url[idx] === '(') bal++;
        else if (url[idx] === ')') { if (bal > 0) bal--; }
      }
      if (bal <= 0) { cut--; continue; }
      break;
    }
    if (TRAILING.indexOf(ch) >= 0) { cut--; continue; }
    break;
  }
  return url.slice(0, cut);
}

// Try to match a strikethrough starting at text[at] (a run of 1-2 tildes).
// Returns {end, contentStart, contentEnd} or null. The opener and closer
// runs must be the same length; the content must end in a non-space,
// non-tilde character (or an escape pair); the closer must not be
// followed by another tilde.
function matchDelimiterRun(text, at) {
  const len = text.length;
  let runLen = 0;
  while (at + runLen < len && text[at + runLen] === '~') runLen++;
  if (runLen === 0 || runLen > 2) return null;
  const after = text[at + runLen];
  if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '~') return null;
  const contentAt = at + runLen;
  for (let scan = contentAt; scan < len; scan++) {
    if (text[scan] !== '~') continue;
    let run2 = 0;
    while (scan + run2 < len && text[scan + run2] === '~') run2++;
    if (run2 < runLen) continue;
    if (scan + runLen < len && text[scan + runLen] === '~') continue;
    // Content must be non-empty and end properly.
    const inner = text.slice(contentAt, scan);
    if (inner.length === 0) continue;
    let slashes = 0;
    for (let pos = inner.length - 1; pos >= 0 && inner[pos] === '\\'; pos--) slashes++;
    let valid;
    if (slashes % 2 === 1) valid = false;
    else if (slashes > 0) valid = true;
    else {
      const tail = inner[inner.length - 1];
      valid = tail !== ' ' && tail !== '\t' && tail !== '\n' && tail !== '~';
    }
    if (!valid) continue;
    return { end: scan + runLen, contentStart: contentAt, contentEnd: scan };
  }
  return null;
}

// Try to read an HTML tag / comment / processing instruction /
// declaration / CDATA starting at text[at] === '<'. Returns the index just
// past it, or -1. Attribute values may be quoted (either quote) or
// unquoted; a quoted value may contain '>'.
function scanHtmlTagToken(text, at) {
  const len = text.length;
  if (text[at] !== '<') return -1;
  let pos = at + 1;
  if (text[pos] === '!') {
    if (text.startsWith('<!--', pos - 1)) {
      // `<!-->` and `<!--->` are complete (abruptly closed) comments.
      if (text.startsWith('<!-->', pos - 1)) return pos + 4;
      if (text.startsWith('<!--->', pos - 1)) return pos + 6;
      const end = text.indexOf('-->', pos + 3);
      if (end < 0) return len;
      return end + 3;
    }
    if (text.startsWith('<![CDATA[', pos - 1)) {
      const end = text.indexOf(']]>', pos + 8);
      if (end < 0) return len;
      return end + 3;
    }
    // Declaration: <!A ...> up to the first '>'.
    const end = text.indexOf('>', pos);
    if (end < 0) return -1;
    return end + 1;
  }
  if (text[pos] === '?') {
    const end = text.indexOf('?>', pos + 1);
    if (end < 0) return len;
    return end + 2;
  }
  if (text[pos] === '/') pos++;
  const closing = text[at + 1] === '/';
  // Tag name (no `:`: `<m:abc>` is not a tag, cm-609).
  if (pos >= len || !((text[pos] >= 'a' && text[pos] <= 'z') || (text[pos] >= 'A' && text[pos] <= 'Z'))) return -1;
  pos++;
  while (pos < len) {
    const ch = text[pos];
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-') { pos++; continue; }
    break;
  }
  // A closing tag takes no attributes: only whitespace then `>`
  // (`</a href="foo">` is not a tag, cm-624).
  if (closing) {
    while (pos < len && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n')) pos++;
    if (text[pos] === '>') return pos + 1;
    return -1;
  }
  // Attributes / close. An attribute must be preceded by whitespace
  // (so `<m:abc>` is not a tag: `:` directly after the tag name, cm-609).
  let hadSpace = false;
  while (pos < len) {
    const ch = text[pos];
    if (ch === '>') return pos + 1;
    if (ch === '/' && text[pos + 1] === '>') return pos + 2;
    if (ch === ' ' || ch === '\t' || ch === '\n') { pos++; hadSpace = true; continue; }
    if (!hadSpace) return -1;
    // Attribute name.
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === ':')) return -1;
    hadSpace = false;
    pos++;
    while (pos < len) {
      const ch2 = text[pos];
      if ((ch2 >= 'a' && ch2 <= 'z') || (ch2 >= 'A' && ch2 <= 'Z') || (ch2 >= '0' && ch2 <= '9') || ch2 === '_' || ch2 === ':' || ch2 === '.' || ch2 === '-') { pos++; continue; }
      break;
    }
    while (pos < len && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n')) { pos++; hadSpace = true; }
    if (text[pos] === '=') {
      pos++;
      while (pos < len && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n')) pos++;
      if (text[pos] === '"' || text[pos] === "'") {
        const quote = text[pos];
        pos++;
        while (pos < len && text[pos] !== quote) pos++;
        if (pos >= len) return -1;
        pos++;
      } else {
        const valueStart = pos;
        while (pos < len) {
          const ch2 = text[pos];
          if (ch2 === ' ' || ch2 === '\t' || ch2 === '\n' || ch2 === '"' || ch2 === "'" || ch2 === '=' || ch2 === '<' || ch2 === '>' || ch2 === '`') break;
          pos++;
        }
        if (pos === valueStart) return -1;
      }
    }
  }
  return -1;
}

// ---- block parsing --------------------------------------------------------
// Split normalized source into lines (without \n). trailingNL tells whether
// the source ended with a line ending (so the last line had a trailing \n).
function splitSource(raw) {
  raw = raw.replace(/\r\n?/g, '\n');
  if (raw === '') return { lines: [], endsNL: false };
  const rows = raw.split('\n');
  let trailingNL = false;
  if (rows[rows.length - 1] === '') { rows.pop(); trailingNL = true; }
  return { lines: rows, endsNL: trailingNL, n: rows.length };
}

// Columns of leading whitespace from index at in line text (tabs to 4-col stops).
function indentSize(text, at, startCol) {
  let col = startCol;
  while (at < text.length) {
    const ch = text[at];
    if (ch === ' ') { col++; at++; }
    else if (ch === '\t') { col += 4 - (col % 4); at++; }
    else break;
  }
  return { col, idx: at };
}

// Advance count columns from (at, col) in line text. Returns {idx, col, pad}: pad is
// the number of spaces a partially-consumed tab contributes as content.
function advanceBy(text, at, col, count) {
  let pad = 0;
  while (count > 0 && at < text.length) {
    const ch = text[at];
    if (ch === ' ') { at++; col++; count--; }
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (width <= count) { at++; col += width; count -= width; }
      else { pad = width - count; col += count; count = 0; at++; }
    } else break;
  }
  return { idx: at, col, pad };
}

// Is line text blank from index at (only spaces/tabs)?
function isBlankAtPos(text, at) {
  while (at < text.length) {
    const ch = text[at];
    if (ch !== ' ' && ch !== '\t') return false;
    at++;
  }
  return true;
}

// Content of line text starting at absolute column `toCol`. text[0] sits at
// absolute column `fromCol`. A partially-consumed tab at the boundary
// expands to spaces.
// Content of string text from absolute column toCol (text starts at
// fromCol). Spaces advance one column; a tab advances to the next
// multiple of 4. When `eatWholeTab` is set, a tab that would overshoot the
// target is consumed ENTIRELY (no remainder spaces) — marked's fenced
// code dedent removes up to N leading whitespace CHARACTERS, so a tab
// counts as one unit (doc-13: a `\tindented` line in a ``` fence
// indented 2 loses the whole tab, not 2 of its 4 columns; `\t\t` in a
// fence indented 2 loses both tabs). Without it, the tab's overshoot
// becomes remainder spaces (indented code blocks).
function contentFromColumn(text, fromCol, toCol, eatWholeTab) {
  let col = fromCol, idx = 0;
  if (eatWholeTab) {
    // Character-count dedent: remove up to (toCol - fromCol)
    // leading whitespace characters (space or tab = 1 each).
    let left = toCol - fromCol;
    while (idx < text.length && left > 0 && (text[idx] === ' ' || text[idx] === '\t')) { idx++; left--; }
    return text.slice(idx);
  }
  while (idx < text.length && col < toCol) {
    const ch = text[idx];
    if (ch === ' ') { col++; idx++; }
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (col + width <= toCol) { col += width; idx++; }
      else return ' '.repeat(col + width - toCol) + text.slice(idx + 1);
    } else break;
  }
  return text.slice(idx);
}

// Advance to absolute column `toCol` from (pos, col, pad) in line text.
// Consumes pad spaces first, then line characters. A tab that would
// overshoot the target is partially consumed (its remainder becomes pad).
// Returns {pos, col, pad}.
function advanceToColumn(text, pos, col, pad, toCol) {
  while (pad > 0 && col < toCol) { pad--; col++; }
  while (col < toCol && pos < text.length) {
    const ch = text[pos];
    if (ch === ' ') { pos++; col++; }
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (col + width <= toCol) { pos++; col += width; }
      else { pad = col + width - toCol; col = toCol; pos++; }
    } else break;
  }
  return { pos, col, pad };
}

// Absolute column (and line index) of the first non-whitespace character
// from (pos, col, pad) in line text. Pad spaces count as columns.
function indentFromColumn(text, pos, col, pad) {
  let c = col + pad;
  let idx = pos;
  while (idx < text.length) {
    const ch = text[idx];
    if (ch === ' ') { c++; idx++; }
    else if (ch === '\t') { c += 4 - (c % 4); idx++; }
    else break;
  }
  return { col: c, idx };
}

// Try to parse a link reference definition starting at (line row, index at).
// Returns {endLine, label, href, title} or null. The definition may span
// lines (dest/title on following lines) but never a blank line.
function tryParseDefinition(ctx, row, at) {
  const rows = ctx.lines;
  const text = rows[row];
  if (text[at] !== '[') return null;
  const labelClose = findLabelClose(text, at);
  if (labelClose < 0) return null;
  const raw = text.slice(at + 1, labelClose - 1);
  if (raw.length === 0 || raw.length > 999) return null;
  if (text[labelClose] !== ':') return null;
  // Skip spaces/tabs/newlines (not blank lines) after the colon.
  let lineNo = row, colNo = labelClose + 1;
  let jump = skipDefinitionWhitespace(ctx, lineNo, colNo);
  if (!jump) return null;
  lineNo = jump.li; colNo = jump.ci;
  if (lineNo >= ctx.n) return null;
  const destLine = rows[lineNo];
  const dest = parseLinkDestination(destLine, colNo);
  if (!dest) return null;
  let href = dest.href;
  let endRow = lineNo, endCol = dest.end;
  // Optional title: skip spaces/tabs/newlines, then a quoted title.
  const after = skipDefinitionWhitespace(ctx, lineNo, dest.end);
  let title = null;
  if (after) {
    const titleLine = rows[after.li];
    const quote = titleLine[after.ci];
    if (quote === '"' || quote === "'" || quote === '(') {
      const parsed = parseLinkTitle(titleLine, after.ci);
      if (!parsed) return null;
      title = parsed.title;
      endRow = after.li; endCol = parsed.end;
    } else {
      // No title: the rest must be blank, on the same line as the dest.
      if (after.li !== lineNo) return null;
      if (!isBlankAtPos(titleLine, after.ci)) return null;
    }
  }
  // After the title/destination, only spaces may follow on that line.
  if (!isBlankAtPos(rows[endRow], endCol)) return null;
  // A label cannot contain an UNESCAPED `[` (cm-546 `[ref[]`); an escaped
  // `\[` is a literal bracket and is fine (cm-549 `[ref\[]`).
  if (hasRawBracket(raw)) return null;
  const label = normalizeLinkLabel(raw);
  if (label.length === 0) return null;
  return { endLine: endRow, label, href, title };
}

// Link reference definition at block start, working on the
// container-stripped `text` of line row (not the raw line). Subsequent
// lines are read through contentAtLine with the live stack. Returns
// {endLine, label, href, title} or null. Same rules as tryParseDefinition.
function tryParseDefinitionInner(ctx, row, text, stack) {
  const lead = indentSize(text, 0, 0);
  if (lead.col > 3) return null;
  const at = lead.idx;
  if (text[at] !== '[') return null;
  // Virtual lines: index 0 is `text`; later lines come from contentAtLine.
  const virtual = [{ text, li: row }];
  function lineAt(k) {
    while (virtual.length <= k) {
      const li = row + virtual.length;
      if (li >= ctx.n) return null;
      const c = contentAtLine(ctx, li, stack);
      if (!c) return null;
      virtual.push({ text: c.content, li });
    }
    return virtual[k];
  }
  // The label may span lines: find its end across the virtual lines.
  const labelFound = findLabelEndValue(lineAt, 0, at);
  if (!labelFound) return null;
  const raw = labelFound.raw;
  if (raw.length === 0 || raw.length > 999) return null;
  const labelEndText = lineAt(labelFound.endVk).text;
  if (labelEndText[labelFound.endIdx] !== ':') return null;
  const labelClose = labelFound.endIdx;
  const labelCloseRow = labelFound.endVk;
  // Advance (vk, ci) over spaces, tabs and single newlines (never a blank
  // line). Returns {vk, ci} or null.
  function skipBlanks(vk0, ci0) {
    let a = vk0, b = ci0;
    for (;;) {
      const v = lineAt(a);
      if (!v) return null;
      const s = v.text;
      while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b++;
      if (b < s.length) return { vk: a, ci: b };
      const nx = lineAt(a + 1);
      if (!nx || isBlankAtPos(nx.text, 0)) return null;
      a++; b = 0;
    }
  }
  const jump = skipBlanks(labelCloseRow, labelClose + 1);
  if (!jump) return null;
  const destLine = lineAt(jump.vk).text;
  const dest = parseLinkDestination(destLine, jump.ci);
  if (!dest) return null;
  const href = dest.href;
  let endRow = jump.vk, endCol = dest.end;
  const after = skipBlanks(jump.vk, dest.end);
  let title = null;
  if (after) {
    const titleLine = lineAt(after.vk).text;
    const quote = titleLine[after.ci];
    if (quote === '"' || quote === "'" || quote === '(') {
      // A title must be separated from the destination by whitespace
      // (a space, tab, or newline). <bar>(baz) has none, so it is not a
      // title and the definition is invalid.
      const hadGap = after.vk !== jump.vk || after.ci > dest.end;
      if (!hadGap) return null;
      const parsed = parseTitleText(lineAt, after.vk, after.ci);
      if (!parsed) {
        // A malformed title on a LATER line does not kill the definition:
        // it ends at the destination and the title line is a separate
        // block. (On the same line, a bad title kills it.)
        if (after.vk === jump.vk) return null;
      } else if (!isBlankAtPos(lineAt(parsed.endVk).text, parsed.endIdx)) {
        // Junk after the title: same fallback, unless the title is on the
        // destination's own line.
        if (parsed.endVk === jump.vk) return null;
      } else {
        title = parsed.title;
        endRow = parsed.endVk; endCol = parsed.endIdx;
      }
    } else if (after.vk === jump.vk) {
      // Junk after the destination on the same line -> invalid definition.
      if (!isBlankAtPos(titleLine, after.ci)) return null;
    }
    // Otherwise the next line does not start with a quote: there is no
    // title, and the definition ends at the destination (the next line is
    // a separate block, e.g. another definition).
  }
  if (!isBlankAtPos(lineAt(endRow).text, endCol)) return null;
  // A label cannot contain an UNESCAPED `[` (cm-546); `\[` is fine (cm-549).
  if (hasRawBracket(raw)) return null;
  const label = normalizeLinkLabel(raw);
  if (label.length === 0) return null;
  return { endLine: lineAt(endRow).li, label, href, title };
}

// Advance (row, col) over spaces, tabs and single newlines (never a blank
// line, never past the end). Returns {li, ci} or null.
function skipDefinitionWhitespace(ctx, row, col) {
  const rows = ctx.lines;
  while (row < ctx.n) {
    const text = rows[row];
    while (col < text.length) {
      const ch = text[col];
      if (ch === ' ' || ch === '\t') { col++; continue; }
      break;
    }
    if (col < text.length) return { li: row, ci: col };
    // End of line: move to the next line if it is not blank.
    if (row + 1 >= ctx.n) return null;
    if (isBlankAtPos(rows[row + 1], 0)) return null;
    row++; col = 0;
  }
  return null;
}

// Is the line at (text, at, col) a setext underline?
// Returns 1 (=), 2 (-) or 0.
function setextHeadingDepth(text, at, col) {
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return 0;
  let idx = lead.idx;
  const ch = text[idx];
  if (ch !== '=' && ch !== '-') return 0;
  let end = idx;
  while (end < text.length && text[end] === ch) end++;
  // Only spaces/tabs may follow.
  if (!isBlankAtPos(text, end)) return 0;
  return ch === '=' ? 1 : 2;
}

// Is the line at (text, at, col) a thematic break?
function isThematicBreakLine(text, at, col) {
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return false;
  let idx = lead.idx;
  const ch = text[idx];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let total = 0;
  while (idx < text.length) {
    const ch2 = text[idx];
    if (ch2 === ch) { total++; idx++; }
    else if (ch2 === ' ' || ch2 === '\t') idx++;
    else return false;
  }
  return total >= 3;
}

// ATX heading at (text, at, col): returns {level, text} or null.
function atxHeadingDepth(text, at, col) {
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return null;
  let idx = lead.idx;
  let depth = 0;
  while (idx < text.length && text[idx] === '#' && depth < 7) { depth++; idx++; }
  if (depth === 0 || depth > 6) return null;
  if (idx < text.length && text[idx] !== ' ' && text[idx] !== '\t') return null;
  // Skip the spaces after the opening #'s: the content starts there.
  let start = idx;
  while (start < text.length && (text[start] === ' ' || text[start] === '\t')) start++;
  // Closing sequence of #'s preceded by a space, preceded only by spaces.
  let end = text.length;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let back = end;
  while (back > start && text[back - 1] === '#') back--;
  // A closing sequence is trailing #'s preceded by a space/tab, or the
  // whole content being #'s (back backed up to start).
  if (back < end && (back === start || text[back - 1] === ' ' || text[back - 1] === '\t')) end = back;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return { level: depth, text: text.slice(start, end) };
}

// Fenced code start at (text, at, col): returns {ch, len, info} or null.
function fenceStartInfo(text, at, col) {
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return null;
  let idx = lead.idx;
  const ch = text[idx];
  if (ch !== '`' && ch !== '~') return null;
  let run = 0;
  while (idx + run < text.length && text[idx + run] === ch) run++;
  if (run < 3) return null;
  const info = text.slice(idx + run).trim();
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len: run, info, start: idx + run };
}

// Is (text, at, col) a closing fence for ch/run? Only spaces may follow.
function isFenceClosing(text, at, col, ch, run) {
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return false;
  let idx = lead.idx;
  let total = 0;
  while (idx + total < text.length && text[idx + total] === ch) total++;
  if (total < run) return false;
  return isBlankAtPos(text, idx + total);
}

// HTML block start at (text, at, col). Returns {type, endLine} where the
// block consumes lines row..endLine, or null. `inParagraph` forbids type 7.
function htmlBlockStartInfo(ctx, row, at, col, inParagraph) {
  const text = ctx.lines[row];
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return null;
  let idx = lead.idx;
  if (text[idx] !== '<') return null;
  const tail = text.slice(idx);
  // Type 1: script, pre, style, textarea (case-insensitive). Ends at the
  // first line containing the matching closing tag (blank lines do not end
  // it), or at the end of the document.
  // Type 1 starts only with the OPENING tag <pre>/<script>/<style>/
  // <textarea>; a closing tag alone (</pre>) is paragraph text (cm-148).
  const head = /^<(script|pre|style|textarea)(?=[\s>\/]|$)/i.exec(tail);
  if (head) {
    const tag = head[1].toLowerCase();
    const closePattern = new RegExp('</' + tag + '\\s*>', 'i');
    for (let scan = row; scan < ctx.n; scan++) {
      if (closePattern.test(ctx.lines[scan])) return { type: 1, endLine: scan };
    }
    return { type: 1, endLine: ctx.n - 1 };
  }
  // Type 2: comment.
  if (tail.startsWith('<!--')) {
    for (let scan = row; scan < ctx.n; scan++) {
      if (ctx.lines[scan].indexOf('-->') >= 0) return { type: 2, endLine: scan };
    }
    return { type: 2, endLine: ctx.n - 1 };
  }
  // Type 3: processing instruction.
  if (tail.startsWith('<?')) {
    for (let scan = row; scan < ctx.n; scan++) {
      if (ctx.lines[scan].indexOf('?>') >= 0) return { type: 3, endLine: scan };
    }
    return { type: 3, endLine: ctx.n - 1 };
  }
  // Type 4: declaration <!A...>.
  if (tail.startsWith('<!') && tail.length > 2 && /[A-Za-z]/.test(tail[2])) {
    for (let scan = row; scan < ctx.n; scan++) {
      if (ctx.lines[scan].indexOf('>') >= 0) return { type: 4, endLine: scan };
    }
    return { type: 4, endLine: ctx.n - 1 };
  }
  // Type 5: CDATA.
  if (tail.startsWith('<![CDATA[')) {
    for (let scan = row; scan < ctx.n; scan++) {
      if (ctx.lines[scan].indexOf(']]>') >= 0) return { type: 5, endLine: scan };
    }
    return { type: 5, endLine: ctx.n - 1 };
  }
  // Type 6: the line begins with < or </ followed by a block tag name,
  // followed by whitespace, end of line, > or />. The tag need NOT close
  // on this line (attributes may continue on later lines); the block ends
  // at the first blank line. Type 7: a complete non-block tag.
  const tagMatch = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tail);
  if (tagMatch) {
    const tagName = tagMatch[1].toLowerCase();
    const next = tail[tagMatch[0].length];
    const nextOk = next === undefined || next === ' ' || next === '\t' ||
      next === '>' || (next === '/' && tail[tagMatch[0].length + 1] === '>');
    if (nextOk) {
      let scan = row;
      while (scan + 1 < ctx.n && !isBlankAtPos(ctx.lines[scan + 1], 0)) scan++;
      if (HTML_BLOCK_TAG_SET.has(tagName)) return { type: 6, endLine: scan };
      if (!inParagraph && scanHtmlTagToken(text, idx) > 0) return { type: 7, endLine: scan };
    }
  }
  return null;
}

// Split a table row line into cells (unescaped |, not inside code spans).
// Returns null if the line has no cell separator context (caller decides).
function splitTableRowCells(text) {
  const parts = [];
  const len = text.length;
  // Fast path: no `\|` escapes — walk the pipes with indexOf and slice
  // each cell once (trimmed), instead of split('|') which allocates an
  // array plus one string per part before trimming.
  if (text.indexOf('\\|') < 0) {
    let cellAt = 0;
    let pipe = text.indexOf('|');
    if (pipe < 0) return [text.trim()];
    while (pipe >= 0) {
      parts.push(text.slice(cellAt, pipe).trim());
      cellAt = pipe + 1;
      pipe = text.indexOf('|', cellAt);
    }
    parts.push(text.slice(cellAt).trim());
    // A leading pipe (first cell only whitespace) is not a cell; a
    // trailing pipe (last cell only whitespace) is not a cell.
    if (parts.length > 0 && parts[0] === '') parts.shift();
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  }
  // Slow path: a `|` is a cell separator unless preceded by an ODD
  // number of backslashes (then it is content, and the table layer
  // consumes one backslash: `\|` -> `|`). Code spans do NOT protect a
  // pipe in marked — `` `x | y` `` splits into two cells.
  const ranges = [];
  let cellAt = 0;
  let idx = 0;
  while (idx < len) {
    if (text[idx] === '|') {
      let slashes = 0;
      let back = idx - 1;
      while (back >= 0 && text[back] === '\\') { slashes++; back--; }
      if (slashes % 2 === 0) {
        ranges.push([cellAt, idx]);
        cellAt = idx + 1;
      }
    }
    idx++;
  }
  ranges.push([cellAt, len]);
  // Drop a leading empty cell from a leading pipe and a trailing empty
  // cell from a trailing pipe.
  let low = 0, high = ranges.length;
  if (high > 0 && text.slice(ranges[0][0], ranges[0][1]).trim() === '') low = 1;
  if (high > low && text.slice(ranges[high - 1][0], ranges[high - 1][1]).trim() === '') high--;
  if (low >= high) return ranges.length === 1 ? [''] : [];
  for (let p = low; p < high; p++) {
    const chunk = text.slice(ranges[p][0], ranges[p][1]);
    parts.push(chunk.trim().replace(/\\\|/g, '|'));
  }
  return parts;
}

// In a table-cell fragment, \| becomes |; \\ stays \\ (so a following |
// is not treated as escaped).
function unescapePipeChar(text) {
  let buf = '';
  for (let idx = 0; idx < text.length; idx++) {
    if (text[idx] === '\\' && idx + 1 < text.length) {
      if (text[idx + 1] === '|') { buf += '|'; idx++; continue; }
      if (text[idx + 1] === '\\') { buf += '\\\\'; idx++; continue; }
    }
    buf += text[idx];
  }
  return buf;
}

// Find the end of a [...] label that may span lines. lineAt(k) returns the
// k-th virtual line {text} or null. Starts at (row, col) which must be '['.
// Returns {endVk, endIdx} (just past the closing ]) and the raw label text
// (with newlines kept), or null.
function findLabelEndValue(lineAt, row, col) {
  // A label ends at the FIRST unescaped `]` (no nesting; cm-547/548).
  let lineIdx = row, charIdx = col + 1;
  let raw = '';
  for (;;) {
    const line = lineAt(lineIdx);
    if (!line) return null;
    const text = line.text;
    while (charIdx < text.length) {
      const ch = text[charIdx];
      if (ch === '`') {
        let end = charIdx;
        while (end < text.length && text[end] === '`') end++;
        const runLen = end - charIdx;
        const closePos = findCodeSpanClose(text, end, runLen);
        if (closePos < 0) { raw += text.slice(charIdx, end); charIdx = end; continue; }
        raw += text.slice(charIdx, closePos); charIdx = closePos; continue;
      }
      if (ch === '\\' && charIdx + 1 < text.length) { raw += text.slice(charIdx, charIdx + 2); charIdx += 2; continue; }
      if (ch === ']') return { endVk: lineIdx, endIdx: charIdx + 1, raw };
      raw += ch; charIdx++;
    }
    const following = lineAt(lineIdx + 1);
    if (!following || isBlankAtPos(following.text, 0)) return null;
    raw += '\n';
    lineIdx++; charIdx = 0;
  }
}

// Is the line a table delimiter row? Returns the alignments array or null.
function tableDelimiterInfo(text) {
  const parts = splitTableRowCells(text);
  if (parts.length === 0) return null;
  const aligns = [];
  for (const cell of parts) {
    const match = /^:?-+:?$/.exec(cell);
    if (!match) return null;
    const hasLeft = cell[0] === ':';
    const hasRight = cell[cell.length - 1] === ':';
    aligns.push(hasLeft && hasRight ? 'center' : hasLeft ? 'left' : hasRight ? 'right' : null);
  }
  return aligns;
}

// List marker at (text, at, col): returns {ordered, start, delim, markerLen}
// or null. markerLen is the width of the marker in columns.
function listMarkerInfo(text, at, col) {
  const lead = indentSize(text, at, col);
  if (lead.col - col > 3) return null;
  let idx = lead.idx;
  const ch = text[idx];
  if (ch === '-' || ch === '+' || ch === '*') {
    if (text[idx + 1] !== ' ' && text[idx + 1] !== '\t' && idx + 1 < text.length) return null;
    if (idx + 1 >= text.length) return { ordered: false, start: 0, delim: ch, markerLen: 1 };
    return { ordered: false, start: 0, delim: ch, markerLen: 1 };
  }
  if (isDigitChar(ch)) {
    let end = idx, value = 0, count = 0;
    while (end < text.length && isDigitChar(text[end]) && count < 10) { value = value * 10 + (text[end].charCodeAt(0) - 48); count++; end++; }
    if (count === 0 || count > 9) return null;
    const delim = text[end];
    if (delim !== '.' && delim !== ')') return null;
    if (end + 1 < text.length && text[end + 1] !== ' ' && text[end + 1] !== '\t') return null;
    return { ordered: true, start: value, delim, markerLen: end - idx + 1 };
  }
  return null;
}

export function parse(source) {
  const refsMap = new Map();
  // marked's insideLink persists across paragraphs within one parse: an
  // unclosed raw `<a>` suppresses bare autolinks/emails later in the
  // document (doc-03 `<a href="foo\\\nbar">` kills a later email link).
  insideLink = false;
  return renderBlockList(parseBlockList(source, refsMap), refsMap);
}

// Match a blockquote marker at (text, at, col, pad). Returns
// {pos, col, pad} after the '>' and one optional space/tab, or null. Only
// one column of a following tab is consumed; the remainder becomes pad.
function matchBlockquoteMarker(text, at, col, pad) {
  let idx = at, col2 = col, padLeft = pad, spaces = 0;
  // Up to 3 spaces before '>' (pad spaces count first).
  while (padLeft > 0 && spaces < 3) { padLeft--; col2++; spaces++; }
  while (idx < text.length && spaces < 3) {
    const ch = text[idx];
    if (ch === ' ') { idx++; col2++; spaces++; }
    else if (ch === '\t') {
      const width = 4 - (col2 % 4);
      if (spaces + width > 3) break;
      idx++; col2 += width; spaces += width;
    } else break;
  }
  if (text[idx] !== '>') return null;
  idx++; col2++;
  if (text[idx] === ' ') { idx++; col2++; }
  else if (text[idx] === '\t') {
    // A tab directly after '>' expands by the marker's OWN width
    // (leading spaces before '>' plus the '>'), not the absolute
    // column — the marker resets the column for the tab (doc-30:
    // a '>' inside a list item followed by a tab expands to 2
    // spaces of content indent, not 0). The tab's first column is
    // the marker's trailing space, so the pad is w - 1.
    const width = 4 - ((col2 - col) % 4);
    idx++;
    if (width > 1) { padLeft = width - 1; col2 += 1; }
    else col2 += width;
  }
  return { pos: idx, col: col2, pad: padLeft };
}

// Content of line row after the current containers are matched. Pure: does
// not modify the stack. Returns {content, col} or null when the line does
// not continue the containers (or is a lazy continuation line).
function contentAtLine(ctx, row, stack) {
  const text = ctx.lines[row];
  let at = 0, col = 0, pad = 0;
  let stripped = false;
  // Column advance of the innermost (last) container stripped, and
  // whether it was a blockquote: a boundary tab expands using only
  // the innermost blockquote marker's own width ('> ' = 2, plus any
  // leading spaces before that '>'), while for a list item the
  // absolute column counts. E.g. '> > \t' and '  > \t' (item+quote)
  // both expand to 2 spaces; '> - \t' (item innermost) uses the
  // absolute column.
  let lastStep = 0, lastQuote = false;
  for (let depth = 1; depth < stack.length; depth++) {
    const block = stack[depth];
    if (block.t === 'para') break;
    if (isBlankAtPos(text, at)) break;
    if (block.t === 'quote') {
      const mark = matchBlockquoteMarker(text, at, col, pad);
      if (!mark) return null;
      lastStep = mark.col - col;
      lastQuote = true;
      at = mark.pos; col = mark.col; pad = mark.pad;
      stripped = true;
    } else if (block.t === 'item') {
      // _contentIndent is relative to the column after the containers
      // before this item (blockquote columns shift per line).
      const wantCol = col + block._contentIndent;
      const lead = indentFromColumn(text, at, col, pad);
      if (lead.col < wantCol) return null;
      const moved = advanceToColumn(text, at, col, pad, wantCol);
      lastStep = moved.col - col;
      lastQuote = false;
      at = moved.pos; col = moved.col; pad = moved.pad;
      stripped = true;
    }
  }
  // A tab that starts exactly at the strip boundary, after containers
  // were stripped, expands to spaces (its width at that column): e.g. a
  // tab at column 13 becomes 3 spaces. A tab with no container stripped
  // (top level) stays a tab. For a blockquote innermost, only the
  // innermost '>' marker's width counts toward the expansion column.
  if (stripped && text[at] === '\t') {
    const effCol = lastQuote ? lastStep : col;
    const width = 4 - (effCol % 4);
    return { content: (pad > 0 ? ' '.repeat(pad) : '') + ' '.repeat(width) + text.slice(at + 1), col: col + width };
  }
  // A blank line keeps its whitespace content (code blocks need the spaces:
  // a 6-space line in indented code is 2 spaces of content, a 2-space line
  // in fenced code is 2 spaces).
  if (isBlankAtPos(text, at)) {
    return { content: (pad > 0 ? ' '.repeat(pad) : '') + text.slice(at), col };
  }
  return { content: (pad > 0 ? ' '.repeat(pad) : '') + text.slice(at), col };
}

// Does the content start a block that can interrupt an open paragraph?
// Used to decide lazy continuation: such a line is a new block, not a
// continuation of the paragraph.
function interruptingBlockType(ctx, row, text, col, stack) {
  if (atxHeadingDepth(text, 0, col)) return true;
  if (fenceStartInfo(text, 0, col)) return true;
  if (htmlBlockAtLine(ctx, row, text, col, true, stack)) return true;
  if (isThematicBreakLine(text, 0, col)) return true;
  const mark = listMarkerInfo(text, 0, col);
  if (mark) {
    const lead = indentSize(text, 0, col);
    let end = lead.idx + mark.markerLen;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    const isEmpty = end >= text.length;
    // Inside a list, even an empty marker starts a new item (it does not
    // become paragraph text). Outside a list, only a non-empty item that
    // can interrupt does.
    const nested = stack.some(b => b.t === 'item');
    if (nested) return true;
    if (!isEmpty && canInterruptParagraph(mark, false)) return true;
  }
  if (matchBlockquoteMarker(text, 0, col, 0)) return true;
  return false;
}

function parseBlockList(source, refsMap) {
  const doc = splitSource(source);
  doc.refs = refsMap;
  const root = { t: 'doc', children: [] };
  const stack = [root];
  const total = doc.lines.length;
  let row = 0;
  let sawBlank = true;
  // Depth-scoped blank: the stack depth (stack.length) at which the most
  // recent blank line occurred. A blank inside a nested container (e.g.
  // a `>`-only line inside a blockquote within a list item, cm-320)
  // must not loosen the enclosing list — only a blank at or above the
  // item's own depth counts. -1 when no blank is pending.
  let blankDepth = -1;

  function innermost() {
    for (let depth = stack.length - 1; depth >= 0; depth--) {
      if (stack[depth].t !== 'para') return stack[depth];
    }
    return root;
  }
  function closeParagraph() {
    if (stack.length > 0 && stack[stack.length - 1].t === 'para') {
      const para = stack.pop();
      para.text = para.lines.join('\n');
      delete para.lines;
    }
  }
  function closeToDepth(depth) {
    while (stack.length > depth) {
      const block = stack.pop();
      if (block.t === 'para') { block.text = block.lines.join('\n'); delete block.lines; }
    }
  }
  function appendChild(child) {
    const parent = innermost();
    parent.children.push(child);
    // Looseness: a block added to a list item after a blank line, when the
    // item already has a block, makes its list loose — but only if the
    // blank occurred at or above the item's own depth (cm-320: a blank
    // inside a nested blockquote does not loosen the enclosing list).
    if (parent.t === 'item' && parent.children.length > 1 && sawBlank &&
        (blankDepth < 0 || blankDepth <= stack.indexOf(parent) + 1)) {
      parent._list.tight = false;
    }
    return child;
  }

  while (row < total) {
    const text = doc.lines[row];
    // Fully blank line: closes a paragraph and any open blockquotes (a
    // bare blank line has no > marker, so the quote ends here; a later >
    // line starts a NEW blockquote). Lists survive blank lines.
    if (isBlankAtPos(text, 0)) {
      closeParagraph();
      // A bare blank line closes every open blockquote, and everything
      // nested inside it — including a list inside the quote (doc-29:
      // `> 1. one` / blank / `> three` is two blockquotes, not one).
      // A list OUTSIDE any quote survives (it is below the quote in
      // the stack, or there is no quote at all). So truncate the stack
      // to just below the outermost quote, instead of popping only
      // quotes at the stack top (a list/item between the quote and the
      // top used to block the pop).
      let quoteIdx = -1;
      for (let depth = 1; depth < stack.length; depth++) if (stack[depth].t === 'quote') { quoteIdx = depth; break; }
      if (quoteIdx >= 0) closeToDepth(quoteIdx);
      sawBlank = true;
      // A BARE blank line separates blocks at every ancestor level (it
      // ends nested containers), so it may loosen any enclosing list
      // (cm-325/326). Depth 0 means "loosens any list". A markers-only
      // blank (below) is confined to its container and gets the real
      // (deep) stack depth instead.
      blankDepth = 0;
      row++;
      continue;
    }
    // ---- Phase 1: descend into open containers. ----
    let at = 0, col = 0, pad = 0;
    let failAt = -1;
    // Column advance of the innermost container matched, and whether it
    // was a blockquote (mirrors contentAtLine): a tab after the markers
    // expands by the innermost quote marker's own width, not the
    // absolute column (doc-17: `  > \tindented` is 2 spaces).
    let lastStep = 0, lastQuote = false;
    for (let depth = 1; depth < stack.length; depth++) {
      const block = stack[depth];
      if (block.t === 'para') break;
      // Blank after the matched markers: a line with NO further content
      // still closes any remaining BLOCKQUOTE (it lacks that quote's
      // marker — `>` ends an inner `> > ` quote, and a later `> > ` line
      // starts a NEW one). Lists survive blank lines, so only quotes
      // force a failure here.
      if (isBlankAtPos(text, at)) {
        for (let scan = depth; scan < stack.length; scan++) {
          if (stack[scan].t === 'para') break;
          if (stack[scan].t === 'quote') { failAt = scan; break; }
        }
        break;
      }
      if (block.t === 'quote') {
        const mark = matchBlockquoteMarker(text, at, col, pad);
        if (!mark) { failAt = depth; break; }
        lastStep = mark.col - col;
        lastQuote = true;
        at = mark.pos; col = mark.col; pad = mark.pad;
      } else if (block.t === 'item') {
        // An empty item followed by a blank line is closed: its content
        // cannot continue after the blank (the list ends here).
        if (block.children.length === 0 && sawBlank) { failAt = depth; break; }
        const wantCol = col + block._contentIndent;
        const lead = indentFromColumn(text, at, col, pad);
        if (lead.col < wantCol) { failAt = depth; break; }
        const moved = advanceToColumn(text, at, col, pad, wantCol);
        lastStep = moved.col - col;
        lastQuote = false;
        at = moved.pos; col = moved.col; pad = moved.pad;
      }
    }
    if (failAt >= 0) {
      // A container did not match. If a paragraph is open and the line does
      // NOT start a block that can interrupt a paragraph, it is a lazy
      // continuation line of that paragraph; otherwise close the containers
      // and let phase 2 start the new block. A line that is blank after
      // the matched markers (e.g. `>` with no inner `> > `) is NOT a
      // lazy continuation — it closes the unmatched container.
      const lazyText0 = (pad > 0 ? ' '.repeat(pad) : '') + text.slice(at);
      if (stack.length > 0 && stack[stack.length - 1].t === 'para' &&
          lazyText0.trim() !== '' &&
          !interruptingBlockType(doc, row, lazyText0, col, stack)) {
        // A lazy continuation line indented 4+ columns loses 4 columns of
        // leading whitespace (the indented-code indent); a less-indented
        // line keeps its whitespace verbatim. A tab straddling the 4-col
        // boundary leaves the leftover as spaces.
        let lazyText = lazyText0;
        let colCursor = col;
        let scan = 0;
        let leftover = 0;
        while (scan < lazyText.length && (lazyText[scan] === ' ' || lazyText[scan] === '\t')) {
          const width = lazyText[scan] === '\t' ? 4 - (colCursor % 4) : 1;
          if (colCursor + width > col + 4) { leftover = colCursor + width - (col + 4); scan++; break; }
          colCursor += width; scan++;
          if (colCursor - col >= 4) break;
        }
        if (colCursor - col >= 4 || leftover > 0) {
          lazyText = ' '.repeat(leftover) + lazyText.slice(scan);
        }
        // A leading tab in lazy content expands to spaces (its width at
        // the line's column), even when the indent is under 4 columns
        // (doc-17/doc-40: `> \tindented` in a lazy paragraph line is 2
        // spaces, not a literal tab). Spaces are kept verbatim.
        {
          let idx = 0, col2 = col, buf = '';
          while (idx < lazyText.length && (lazyText[idx] === ' ' || lazyText[idx] === '\t')) {
            if (lazyText[idx] === ' ') { buf += ' '; col2++; idx++; }
            else { const width = 4 - (col2 % 4); buf += ' '.repeat(width); col2 += width; idx++; }
          }
          if (idx > 0 && lazyText.slice(0, idx).includes('\t')) lazyText = buf + lazyText.slice(idx);
        }
        const para = stack[stack.length - 1];
        // A lazy `=`-only line (setext underline shape) after a lazy line
        // is paragraph text with exactly 4 spaces prepended (cm-093);
        // a setext underline cannot be a lazy continuation line, and
        // marked pads it to 4 spaces. Only when the previous paragraph
        // line was itself lazy; a `>`-marked previous line gets none.
        if (para.lastLazy) {
          const trimmed = lazyText.trim();
          if (/^=+$/.test(trimmed)) lazyText = '    ' + trimmed;
        }
        para.lines.push(lazyText);
        para.lastLazy = true;
        sawBlank = false;
        row++;
        continue;
      }
      closeToDepth(failAt);
      // Phase 2 continues at the position after the matched containers.
      // (at, col, pad) are still the pre-failure values, as desired.
    }
    // Blank after container markers: a markers-only line (empty content,
    // e.g. `>>`) is a blank line that ends the paragraph. A line with
    // whitespace content after the markers (e.g. `>  `) continues an open
    // paragraph as a line of spaces; with no paragraph open it is blank.
    if (isBlankAtPos(text, at)) {
      const spaces = (pad > 0 ? ' '.repeat(pad) : '') + text.slice(at);
      if (spaces.length > 0 && stack.length > 0 && stack[stack.length - 1].t === 'para') {
        const para = stack[stack.length - 1];
        para.lines.push(spaces);
        para.lastLazy = false;
        sawBlank = false;
        row++;
        continue;
      }
      closeParagraph();
      sawBlank = true;
      blankDepth = stack.length;
      row++;
      continue;
    }
    let content = (at === 0 && pad === 0) ? text : (' '.repeat(pad) + text.slice(at));
    let textCol = col;
    // A leading tab in the content after container markers expands to
    // spaces (its width at the marker column): `> \tindented` in a
    // paragraph is 2 spaces, not a literal tab (doc-17/doc-40). For a
    // blockquote innermost, only that marker's own width counts
    // (lastStep), not the absolute column — `  > \tindented` is 2
    // spaces, not 4. Spaces are kept verbatim; only tabs expand.
    if (at > 0 && content.length > 0 && content.slice(0, content.search(/[^ \t]/) < 0 ? content.length : content.search(/[^ \t]/)).includes('\t')) {
      const effCol = lastQuote ? lastStep : textCol;
      let buf = '', col2 = effCol, idx = 0;
      while (idx < content.length && (content[idx] === ' ' || content[idx] === '\t')) {
        if (content[idx] === ' ') { buf += ' '; col2++; idx++; }
        else { const width = 4 - (col2 % 4); buf += ' '.repeat(width); col2 += width; idx++; }
      }
      content = buf + content.slice(idx);
    }
    // ---- Phase 2: start new blocks (possibly several containers). ----
    while (true) {
      const paraOpen = stack.length > 0 && stack[stack.length - 1].t === 'para';
      // Blank content with no paragraph open (e.g. a bare `>` line) is a
      // blank line: it must NOT start an empty paragraph. (When a
      // paragraph IS open, the line is a continuation and is added below.)
      // An empty list item's content is also blank, but it is NOT a blank
      // line: do not set sawBlank for it (it would wrongly loosen the
      // list when the next item is added).
      if (isBlankAtPos(content, 0) && !paraOpen) {
        const top = stack[stack.length - 1];
        if (!(top && top.t === 'item' && top.children.length === 0)) {
          closeParagraph();
          sawBlank = true;
          blankDepth = stack.length;
        }
        row++;
        break;
      }
      const inPara = paraOpen;
      if (paraOpen) {
        // Setext underline turns the paragraph into a heading.
        const setext = setextHeadingDepth(content, 0, textCol);
        if (setext > 0) {
          const para = stack.pop();
          const parent = innermost();
          // Setext heading content: leading whitespace off the first line,
          // trailing whitespace off the last line.
          const rows = para.lines;
          rows[0] = rows[0].replace(/^[ \t]+/, '');
          rows[rows.length - 1] = rows[rows.length - 1].replace(/[ \t]+$/, '');
          const heading = { t: 'heading', level: setext, text: rows.join('\n') };
          parent.children[parent.children.length - 1] = heading;
          sawBlank = false;
          row++;
          break;
        }
        // A table header + delimiter row interrupts the paragraph. The
        // delimiter row may be indented at most 3 spaces.
        if (row + 1 < total) {
          const next = contentAtLine(doc, row + 1, stack);
          if (next) {
            const header = splitTableRowCells(content);
            const delim = tableDelimiterInfo(next.content);
            const delimLead = indentSize(next.content, 0, next.col);
            if (delim && delim.length === header.length && delimLead.col - next.col <= 3 &&
                setextHeadingDepth(next.content, 0, next.col) === 0) {
              closeParagraph();
              row = parseTableNode(doc, row, stack, header, delim, content, textCol, sawBlank, blankDepth);
              sawBlank = false;
              break;
            }
          }
        }
      }
      // Blocks that can interrupt a paragraph (or start one).
      const atx = atxHeadingDepth(content, 0, textCol);
      if (atx) {
        closeParagraph();
        appendChild({ t: 'heading', level: atx.level, text: atx.text });
        sawBlank = false;
        row++;
        break;
      }
      const fence = fenceStartInfo(content, 0, textCol);
      if (fence) {
        closeParagraph();
        row = parseFencedCodeBlock(doc, row, stack, fence, content, textCol, sawBlank, blankDepth);
        sawBlank = false;
        break;
      }
      const html = htmlBlockAtLine(doc, row, content, textCol, inPara, stack);
      if (html) {
        closeParagraph();
        row = parseHtmlBlockNode(doc, row, stack, html, content, textCol, sawBlank, blankDepth);
        sawBlank = false;
        break;
      }
      if (isThematicBreakLine(content, 0, textCol)) {
        closeParagraph();
        appendChild({ t: 'hr' });
        sawBlank = false;
        row++;
        break;
      }
      const mark = listMarkerInfo(content, 0, textCol);
      if (mark) {
        // Empty item: nothing but spaces/tabs after the marker.
        const lead = indentSize(content, 0, textCol);
        let end = lead.idx + mark.markerLen;
        while (end < content.length && (content[end] === ' ' || content[end] === '\t')) end++;
        const isEmpty = end >= content.length;
        // Inside a list, a marker (even an empty one) starts a new item.
        // Outside, only a non-empty item that can interrupt does.
        const nested = stack.some(b => b.t === 'item');
        if (!paraOpen || nested || canInterruptParagraph(mark, isEmpty)) {
          closeParagraph();
          const result = startListItemNode(doc, row, stack, mark, content, textCol, sawBlank, blankDepth);
          if (result) {
            content = result.content; textCol = result.col; row = result.line;
            sawBlank = false;
            continue; // re-run phase 2 on the item's content
          }
        }
        // A list marker that cannot interrupt is paragraph text.
        if (paraOpen) {
          stack[stack.length - 1].lines.push(content);
          stack[stack.length - 1].lastLazy = false;
          sawBlank = false;
          row++;
          break;
        }
      }
      // Blockquote.
      const quoteMark = matchBlockquoteMarker(content, 0, textCol, 0);
      if (quoteMark) {
        closeParagraph();
        const quote = { t: 'quote', children: [] };
        appendChild(quote);
        stack.push(quote);
        content = (quoteMark.pad > 0 ? ' '.repeat(quoteMark.pad) : '') + content.slice(quoteMark.pos);
        textCol = quoteMark.col;
        sawBlank = false;
        continue; // re-run phase 2 inside the quote
      }
      if (!paraOpen) {
        // Link reference definition (only at a paragraph start). A
        // definition is a block: inside a list item that already holds a
        // block, it loosens the list (cm-317).
        const def = tryParseDefinitionInner(doc, row, content, stack);
        if (def) {
          if (!refsMap.has(def.label)) refsMap.set(def.label, { href: def.href, title: def.title });
          markLooseList(innermost(), sawBlank, blankDepth, stack);
          row = def.endLine + 1;
          sawBlank = false;
          break;
        }
        // Indented code (4+ spaces, no paragraph open).
        const lead = indentSize(content, 0, textCol);
        if (lead.col - textCol >= 4) {
          row = parseIndentedCodeBlock(doc, row, stack, content, textCol, sawBlank, blankDepth);
          sawBlank = false;
          break;
        }
        // Table at a block start (delimiter row indented at most 3).
        if (row + 1 < total) {
          const next = contentAtLine(doc, row + 1, stack);
          if (next) {
            const header = splitTableRowCells(content);
            const delim = tableDelimiterInfo(next.content);
            const delimLead = indentSize(next.content, 0, next.col);
            if (delim && delim.length === header.length && delimLead.col - next.col <= 3 &&
                setextHeadingDepth(next.content, 0, next.col) === 0) {
              row = parseTableNode(doc, row, stack, header, delim, content, textCol, sawBlank, blankDepth);
              sawBlank = false;
              break;
            }
          }
        }
        // Start a paragraph.
        const para = { t: 'para', lines: [content], lastLazy: false };
        appendChild(para);
        stack.push(para);
        sawBlank = false;
        row++;
        break;
      }
      // Paragraph continuation.
      stack[stack.length - 1].lines.push(content);
      stack[stack.length - 1].lastLazy = false;
      sawBlank = false;
      row++;
      break;
    }
  }
  closeToDepth(1);
  return root;
}

// The innermost non-paragraph block in the stack: the container a new
// block is added to.
function parentBlockNode(stack) {
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    if (stack[depth].t !== 'para') return stack[depth];
  }
  return stack[0];
}

// Mark the parent list loose when a block is added to a list item that
// already holds a block after a blank line.
function markLooseList(parent, sawBlank, blankDepth, stack) {
  // Depth-scoped: a blank inside a nested container (deeper than the
  // item) does not loosen the list (cm-320). When no depth/stack is
  // supplied, fall back to the old behaviour.
  if (parent.t === 'item' && parent.children.length > 0 && sawBlank) {
    if (blankDepth === undefined || !stack ||
        blankDepth < 0 || blankDepth <= stack.indexOf(parent) + 1) {
      parent._list.tight = false;
    }
  }
}

// Remove backslash escapes before ASCII punctuation (fence info string).
function unescapeInfoText(text) {
  let buf = '';
  for (let idx = 0; idx < text.length; idx++) {
    if (text[idx] === '\\' && idx + 1 < text.length && isAsciiPunct(text[idx + 1])) { buf += text[idx + 1]; idx++; }
    else buf += text[idx];
  }
  return buf;
}

// Render a parsed block tree to marked-compatible HTML.
function renderBlockList(tree, refsMap) {
  const buf = [];
  renderBlockNode(tree, refsMap, buf);
  return buf.join('');
}

function renderBlockNode(block, refsMap, buf, trailLast) {
  switch (block.t) {
    case 'doc':
      for (let idx = 0; idx < block.children.length; idx++)
        renderBlockNode(block.children[idx], refsMap, buf, trailLast && idx === block.children.length - 1);
      break;
    case 'heading':
      buf.push('<h', String(block.level), '>', renderInlineHtml(block.text, refsMap), '</h', String(block.level), '>\n');
      break;
    case 'para': {
      const text = trailLast ? block.text.replace(/[ \t]+$/, '') : block.text;
      buf.push('<p>', renderInlineHtml(text, refsMap), '</p>\n');
      break;
    }
    case 'code':
      buf.push('<pre><code');
      if (block.fenced && block.info) {
        const lang = block.info.split(/\s+/)[0];
        if (lang) buf.push(' class="language-', escapeText(unescapeInfoText(lang)), '"');
      }
      buf.push('>', escapeFullText(block.text), '</code></pre>\n');
      break;
    case 'hr':
      buf.push('<hr>\n');
      break;
    case 'quote':
      buf.push('<blockquote>\n');
      for (let idx = 0; idx < block.children.length; idx++)
        renderBlockNode(block.children[idx], refsMap, buf, trailLast && idx === block.children.length - 1);
      buf.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      buf.push('<', tag);
      if (block.ordered && block.start !== 1) buf.push(' start="', String(block.start), '"');
      buf.push('>\n');
      for (let idx = 0; idx < block.items.length; idx++)
        renderListItemNode(block.items[idx], block, refsMap, buf, idx === block.items.length - 1);
      buf.push('</', tag, '>\n');
      break;
    }
    case 'table': {
      buf.push('<table>\n<thead>\n<tr>\n');
      for (let idx = 0; idx < block.header.length; idx++) {
        buf.push('<th');
        const align = block.aligns[idx];
        if (align) buf.push(' align="', align, '"');
        buf.push('>', renderInlineHtml(block.header[idx], refsMap), '</th>\n');
      }
      buf.push('</tr>\n</thead>\n');
      if (block.rows.length > 0) {
        buf.push('<tbody>');
        for (const row of block.rows) {
          buf.push('<tr>\n');
          for (let idx = 0; idx < block.header.length; idx++) {
            buf.push('<td');
            const align = block.aligns[idx];
            if (align) buf.push(' align="', align, '"');
            buf.push('>', renderInlineHtml(row[idx], refsMap), '</td>\n');
          }
          buf.push('</tr>\n');
        }
        buf.push('</tbody></table>\n');
      } else {
        buf.push('</table>\n');
      }
      break;
    }
    case 'html': {
      buf.push(block.lines.join('\n'));
      if (block.trailingNL) buf.push('\n');
      break;
    }
  }
}

// Render one list item. Tight: a lone paragraph renders as bare inline
// content; loose: every paragraph gets <p> wrappers. `trailLast` is true
// when this item is the last item of its list (and that list is itself
// the last descendant of its parent): trailing spaces are stripped from
// the item's final paragraph, even when it is nested inside a blockquote
// (doc-28) — the flag propagates to the last descendant.
function renderListItemNode(entry, list, refsMap, buf, trailLast) {
  buf.push('<li>');
  const kids = entry.children;
  const hasTask = entry._task !== undefined;
  const box = hasTask
    ? (entry._task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
    : '';
  for (let idx = 0; idx < kids.length; idx++) {
    const child = kids[idx];
    const isLast = idx === kids.length - 1;
    if (child.t === 'para') {
      const text = (trailLast && isLast) ? child.text.replace(/[ \t]+$/, '') : child.text;
      if (list.tight) {
        if (idx === 0) buf.push(box);
        buf.push(renderInlineHtml(text, refsMap));
      } else {
        buf.push('<p>');
        if (idx === 0) buf.push(box);
        buf.push(renderInlineHtml(text, refsMap));
        buf.push('</p>\n');
      }
    } else {
      renderBlockNode(child, refsMap, buf, trailLast && isLast);
    }
  }
  buf.push('</li>\n');
}

// ---------- Inline parsing ----------

// Render inline markdown (a paragraph/heading/cell string) to HTML.
function renderInlineHtml(text, refsMap) {
  if (!text) return '';
  // Fast path: plain prose with no inline markers, no hard break
  // (`  \n` or `\\\n`), and no autolink trigger. The only output is the
  // escaped text (soft breaks stay as literal newlines).
  if (text.indexOf('*') < 0 && text.indexOf('_') < 0 && text.indexOf('[') < 0 &&
      text.indexOf(']') < 0 && text.indexOf('!') < 0 && text.indexOf('`') < 0 &&
      text.indexOf('<') < 0 && text.indexOf('\\') < 0 && text.indexOf('~') < 0 &&
      text.indexOf('://') < 0 && text.indexOf('www.') < 0 && text.indexOf('@') < 0 &&
      text.indexOf('&#') < 0 && text.indexOf('  \n') < 0) {
    return escapeText(text);
  }
  return renderInlineNodeHtml(parseInlineTokens(text, refsMap));
}

function renderInlineNodeHtml(nodes) {
  const buf = [];
  for (const node of nodes) {
    switch (node.t) {
      case 'text': buf.push(escapeText(node.s)); break;
      case 'code': buf.push('<code>', escapeFullText(node.s), '</code>'); break;
      case 'html': buf.push(node.s); break;
      case 'br': buf.push('<br>'); break;
      case 'soft': buf.push('\n'); break;
      case 'em': buf.push('<em>', renderInlineNodeHtml(node.children), '</em>'); break;
      case 'strong': buf.push('<strong>', renderInlineNodeHtml(node.children), '</strong>'); break;
      case 'del': buf.push('<del>', renderInlineNodeHtml(node.children), '</del>'); break;
      case 'link': {
        buf.push('<a href="', cleanLinkHref(node.href), '"');
        if (node.title != null) buf.push(' title="', escapeText(node.title), '"');
        buf.push('>', renderInlineNodeHtml(node.children), '</a>');
        break;
      }
      case 'image': {
        buf.push('<img src="', cleanLinkHref(node.src), '" alt="', escapeText(node.alt), '"');
        if (node.title != null) buf.push(' title="', escapeText(node.title), '"');
        buf.push('>');
        break;
      }
    }
  }
  return buf.join('');
}

// Plain-text rendering of inline nodes (for image alt text).
function plainTextContent(nodes) {
  let buf = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': buf += node.s; break;
      case 'code': buf += node.s; break;
      case 'html': buf += node.s; break;
      case 'br': case 'soft': buf += '\n'; break;
      case 'em': case 'strong': case 'del': case 'link':
        buf += plainTextContent(node.children); break;
      case 'image': buf += node.alt; break;
    }
  }
  return buf;
}

// Is the character a flanking punctuation/space boundary for emphasis?
// Returns [canOpen, canClose] for a delimiter run ending/starting here.
// Unicode whitespace for emphasis flanking: ASCII space/tab/newline/CR
// plus NBSP (U+00A0) and the other Unicode spaces. (A plain space/tab is
// NOT enough: `* a *` with NBSPs must not form emphasis.)
function isUnicodeSpace(char) {
  if (!char) return false;
  if (isSpaceChar(char)) return true;
  const cp = char.codePointAt(0);
  return cp === 0x00A0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F ||
    cp === 0x205F || cp === 0x3000 || cp === 0xFEFF;
}

function flankingType(text, before, after) {
  const beforeCh = before;
  const afterCh = after;
  const beforeSpace = beforeCh === '' || isUnicodeSpace(beforeCh);
  const afterSpace = afterCh === '' || isUnicodeSpace(afterCh);
  const beforePunct = !beforeSpace && isPunctuationChar(beforeCh);
  const afterPunct = !afterSpace && isPunctuationChar(afterCh);
  const canOpen = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const canClose = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return [canOpen, canClose];
}

// Parse inline markdown into a node list. Single left-to-right scan with a
// delimiter stack for emphasis and links (CommonMark 0.31.2 algorithm).
const INLINE_TRIGGER_PATTERN = /[\\`*_~[\]<&\n]|!(?=\[)/g;
// Raw `<a>` state, shared across inline runs within one parse() (see parse).
let insideLink = false;
function parseInlineTokens(text, refsMap) {
  const nodes = [];
  const delims = [];

  const len = text.length;
  let idx = 0;
  // Hoisted per-paragraph probes: the email check needs an '@' in the
  // text, and the trailing-underscore check needs an '_' opener; a
  // paragraph without them skips those scans entirely.
  const hasAt = text.includes('@');
  const hasUnderscore = text.includes('_');

  function pushText(str) { if (str) nodes.push({ t: 'text', s: str }); }
  function pushDelimiter(kind, len, canOpen, canClose, node, src) {
    delims.push({ kind, len, canOpen, canClose, node, active: true, src: src === undefined ? -1 : src, hasLink: false });
  }
  // Resolve emphasis for the delimiters currently on the stack, in two
  // passes. Pass 1 pairs only same-length openers/closers (so `**` pairs
  // with `**` for strong and `*` with `*` for em); this keeps the inner
  // `**...**` in `*foo**bar**baz*` from being grabbed by the outer `*`.
  // Pass 2 falls back to any-length pairing for the cases that need it
  // (e.g. `***foo***`, `*foo**`), processing closers right to left so a
  // longer closer (e.g. the `***` in `*foo**bar***`) splits across its
  // openers before a shorter closer grabs one.
  function resolveEmphasis() {
    resolveEmphasisPass(true, false);
    resolveEmphasisPass(false, true);
  }
  function resolveEmphasisPass(sameLenOnly, reverse) {
    let cursor = reverse ? delims.length - 1 : 0;
    const step = reverse ? -1 : 1;
    const finished = () => reverse ? cursor < 0 : cursor >= delims.length;
    while (!finished()) {
      const closer = delims[cursor];
      if (!closer.active || closer.isBlocker || closer.blockedForever || closer.kind === '[' || closer.kind === '![' ||
          !closer.canClose) { cursor += step; continue; }
      // Find the nearest opener before cursor (same length first in pass 1).
      // Pass 1 fallback: if no same-length opener exists, a PURE closer
      // (canClose, cannot open) may split the nearest LONGER opener (use
      // 1), so `__foo_ bar_` forms the inner em before the outer closer
      // grabs the opener (cm-408/413/426/430). A closer that can also open
      // must NOT split: it serves as an opener for a later closer
      // (cm-429 `**foo*bar*baz**`: the `*` after `foo` opens `<em>bar</em>`).
      // If the nearest opener is reserved by an earlier PURE closer (see
      // the stolen check below), keep scanning backward for the next
      // opener — the closer may pair with an earlier one instead
      // (`*a *b **c*** d*`: the final `*` pairs with the outer `*a`
      // after the `***` closer reserves the inner `*b`).
      let openIdx = -1;
      let hitBlocker = false;
      let blockerIdx = -1;
      let searchFrom = cursor - 1;
      for (;;) {
        let fallback = -1;
        hitBlocker = false;
        blockerIdx = -1;
        for (let scan = searchFrom; scan >= 0; scan--) {
          const candidate = delims[scan];
          if (!candidate.active || candidate.kind !== closer.kind || !candidate.canOpen) continue;
          // A BLOCKER (an open-capable closer left behind by an inner
          // strong/em) bars the closer from an opener before it when the
          // rule of 3 applies (`*a **b**c*`, doc-03/doc-07). It is
          // single-use (deactivated on encounter). It only permanently
          // blocks when it actually prevents a match: an opener found past
          // it (before it) is barred, but an opener after it — including a
          // pass-1 fallback opener nearer the closer — is not (doc-03
          // `*using *type guide in**`: the `**` closer has no same-length
          // opener in pass 1, so it must retry in pass 2).
          if (candidate.isBlocker) {
            candidate.active = false;
            if ((candidate.len + closer.len) % 3 === 0) { hitBlocker = true; blockerIdx = scan; }
            continue;
          }
          if (sameLenOnly && candidate.len !== closer.len) {
            if (fallback < 0 && !closer.canOpen && candidate.len > closer.len) fallback = scan;
            continue;
          }
          if (closer.kind === '_' &&
              ((candidate.canOpen && candidate.canClose) || (closer.canOpen && closer.canClose)) &&
              (candidate.len + closer.len) % 3 === 0) continue;
          openIdx = scan;
          break;
        }
        if (openIdx < 0 && sameLenOnly && fallback >= 0) {
          // Do not split a longer opener when a later closer of the
          // opener's own length exists — that closer needs the whole
          // opener (`**a *b*c* d**`: the `*` after `c` must not split
          // the `**` opener, the final `**` closes the strong). The
          // fallback is only for openers no later closer can use whole
          // (cm-408/413/426/430).
          const fbOpener = delims[fallback];
          let laterWhole = false;
          for (let scan = cursor + 1; scan < delims.length; scan++) {
            const later = delims[scan];
            if (!later.active || later.isBlocker || later.blockedForever || later.kind !== closer.kind ||
                !later.canClose || later.len < fbOpener.len) continue;
            laterWhole = true;
            break;
          }
          if (!laterWhole) openIdx = fallback;
        }
        if (openIdx < 0) break;
        // A blocker only permanently blocks when it prevented a real match:
        // the opener found lies before the blocker. A fallback opener after
        // the blocker is unaffected.
        const barred = hitBlocker && openIdx >= 0 && openIdx < blockerIdx;
        if (barred) { closer.blockedForever = true; openIdx = -1; break; }
        const opener = delims[openIdx];
        // Earlier-closer priority (both passes): if an earlier PURE closer
        // C' (same kind, still active, canClose but not canOpen) would
        // consume this opener — scanning backward from C' and accumulating
        // opener lengths up to C'.len (a long closer splits across several
        // openers) — C' gets it first. A later closer must not steal an
        // opener an earlier closer needs (doc-01 `**with *this be***` +
        // `*so*version*?`; doc-02 `*uses will **issue lines*** ... 2*3*4`:
        // the `*` in `2*3` must not take the `*` opener the `***` closer
        // needs after splitting). C' reserves O when it matches O's length
        // or is longer than this closer; a shorter dangling closer must
        // not reserve a longer opener from its same-length closer (`**a
        // *b*c* d**`). A middle delimiter that can also open (cm-412
        // `*foo**bar*`) does not reserve.
        let stolen = false;
        for (let earlier = 0; earlier < cursor; earlier++) {
          const earlierCloser = delims[earlier];
          if (!earlierCloser.active || earlierCloser.kind !== closer.kind || !earlierCloser.canClose || earlierCloser.canOpen) continue;
          // An earlier closer reserves the opener when it matches the
          // opener's length or is longer than this closer — including
          // when it is exactly this closer's length (doc-29
          // `**cache ... *tokens ... **library ... *from our*** ...
          // tests output***`: the earlier `***` must reserve `*from`
          // and `**library` from the later `***`, as marked's
          // left-to-right closer processing gives it priority; only a
          // strictly shorter dangling closer must not reserve).
          if (earlierCloser.len !== opener.len && earlierCloser.len < closer.len) continue;
          // Openers C' would consume (nearest first, up to C'.len).
          let need = earlierCloser.len;
          let reserves = false;
          for (let scan = earlier - 1; scan >= 0 && need > 0; scan--) {
            const earlierOpener = delims[scan];
            if (!earlierOpener.active || earlierOpener.kind !== earlierCloser.kind || !earlierOpener.canOpen) continue;
            if (earlierCloser.kind === '_' &&
                ((earlierOpener.canOpen && earlierOpener.canClose) || (earlierCloser.canOpen && earlierCloser.canClose)) &&
                (earlierOpener.len + earlierCloser.len) % 3 === 0) continue;
            if (scan === openIdx) { reserves = true; break; }
            need -= Math.min(earlierOpener.len, need);
          }
          if (reserves) { stolen = true; break; }
        }
        if (!stolen) break;
        // This opener is reserved by an earlier closer: try the next
        // opener further back.
        searchFrom = openIdx - 1;
        openIdx = -1;
      }
      if (openIdx < 0) { cursor += step; continue; }
      const opener = delims[openIdx];
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const tag = closer.kind === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const openNode = opener.node;
      const closeNode = closer.node;
      const openPos = nodes.indexOf(openNode);
      const closePos = nodes.indexOf(closeNode);
      if (openPos < 0 || closePos < 0 || closePos <= openPos) { cursor += step; continue; }
      const children = nodes.slice(openPos + 1, closePos);
      // Resolve emphasis INSIDE the em first (doc-02 `**create same
      // _examples __files guide___**`: the inner `_`/`__`/`___` must
      // pair before the outer `**` closes over them). Collect the inner
      // delimiters, resolve them in the children range, then build the
      // outer node from the resolved children.
      const childSet = new Set(children);
      const innerDelims = [];
      for (let scan = delims.length - 1; scan >= 0; scan--) {
        const dm = delims[scan];
        if (dm === opener || dm === closer) continue;
        if (dm.active && childSet.has(dm.node)) {
          innerDelims.unshift(dm);
          delims.splice(scan, 1);
          if (scan < cursor) cursor--;
          if (scan < openIdx) openIdx--;
        }
      }
      if (innerDelims.length > 0) resolveEmphasisRange(children, innerDelims);
      // Consume `use` chars: opener takes from the end of its run, closer
      // from the start of its run.
      const origCloserLen = closer.len;
      const closerCouldOpen = closer.canOpen;
      opener.len -= use;
      closer.len -= use;
      openNode.s = openNode.s.slice(0, openNode.s.length - use);
      closeNode.s = closeNode.s.slice(use);
      const emNode = { t: tag, children };
      // Rebuild the node range: [opener leftover?] + em + [closer leftover?].
      // The closer leftover goes INSIDE the emphasis (as its last child)
      // when it can no longer pair with any opener — no active opener of
      // the same kind remains — AND the emphasis contains an inner
      // em/strong AND the last child is attached to the closer (no leading
      // whitespace). Marked's raw-span for the match then includes the
      // whole closer run, so the leftover lands in the content
      // (`**a *b*c***` -> `<strong>a <em>b</em>c*</strong>`). When an
      // opener remains (e.g. doc-10 `*a *b **c*** d*`, where the `***`
      // leftover must still close the inner `*b`), or there is no inner
      // emphasis, or the last child starts with whitespace
      // (`**a *b* c***`), the leftover stays outside as before.
      const replacement = [];
      if (openNode.s) replacement.push(openNode);
      replacement.push(emNode);
      let closerInside = false;
      if (closeNode.s) {
        // Only a STRONG takes its closer leftover inside; an em never
        // does (`*a *b*c**` -> `<em>a <em>b</em>c</em>*`, doc-03/doc-04).
        let takeInside = false;
        if (use === 2) {
          const hasInnerEm = children.some(ch => ch.t === 'em' || ch.t === 'strong' || ch.t === 'del');
          const lastChild = children[children.length - 1];
          const attached = lastChild && lastChild.t === 'text' && lastChild.s !== '' && !/^[ \t\n]/.test(lastChild.s);
          let openerRemains = false;
          if (hasInnerEm && attached) {
            for (const dm of delims) {
              if (dm === closer || !dm.active || dm.len === 0 || dm.kind !== closer.kind || !dm.canOpen) continue;
              openerRemains = true;
              break;
            }
          }
          takeInside = hasInnerEm && attached && !openerRemains;
        }
        if (takeInside) {
          children.push({ t: 'text', s: closeNode.s });
          closerInside = true;
        } else {
          replacement.push(closeNode);
        }
      }
      nodes.splice(openPos, closePos - openPos + 1, ...replacement);
      if (opener.len === 0) { delims.splice(openIdx, 1); if (openIdx < cursor) cursor--; }
      if (closer.len === 0) {
        const closeIdx2 = delims.indexOf(closer);
        if (closeIdx2 >= 0) {
          // A blocker is left behind only when the closer can open AND
          // the opener it paired with is a PURE opener (cannot close).
          // If the opener can also close, the pairing is balanced and no
          // blocker forms (`**foo*bar*baz**` forms the outer strong, but
          // `**a *b*c**` does not — there the inner opener `*` before `b`
          // is pure). A blocker stops the next closer from reaching an
          // opener before the inner emphasis (`*a **b**c*`, doc-03/doc-07).
          if (closerCouldOpen && !opener.canClose) {
            closer.len = origCloserLen;
            closer.isBlocker = true;
            closer.canClose = false;
          } else {
            delims.splice(closeIdx2, 1); if (closeIdx2 < cursor) cursor--;
          }
        }
        // Forward scan: the next delimiter shifted into index cursor, so stay
        // (it is examined next). Reverse scan: index cursor now holds an
        // already-processed delimiter, so step left.
        if (reverse) cursor += step;
      }
      // Otherwise the closer still has length left: stay at index cursor so it
      // is re-examined and may pair again.
    }
  }

  // Deactivate emphasis delimiters (* / _ / ~) whose source lies strictly
  // inside a failed link label (openerSrc..closeIdx). Marked's emphasis
  // masking hides a whole link-like `[...](...)` span from the emphasis
  // parser, so `_` inside it never pairs (doc-09/16: `_node `` a ` b ``_`
  // in `[at _node `` a ` b ``_](...)` stays literal).
  function maskLabelDelims(openerSrc, closeIdx) {
    for (const dm of delims) {
      if (!dm.active) continue;
      if ((dm.kind === '*' || dm.kind === '_' || dm.kind === '~') && dm.src > openerSrc && dm.src < closeIdx) {
        dm.active = false;
      }
    }
  }

  // Marked's emphasis mask, step A: a lenient code-span scan over the
  // paragraph. A backtick run pairs with the NEXT maximal run of the
  // same length (content may hold backticks, must start/end non-backtick);
  // a run with no partner is bare. Code-span inner backticks become '+'
  // and escaped punctuation becomes '++' in the transformed string (all
  // replacements length-preserving, so indices still match the source).
  // The replacements are recorded as intervals and the result is
  // assembled from slices: a paragraph with no backticks and no
  // backslashes returns the source string itself (no copy at all), and
  // one with replacements avoids the per-character array + join.
  function transformMasked(text) {
    if (!text.includes('`') && !text.includes('\\')) return text;
    const len = text.length;
    const reps = [];
    let idx = 0;
    while (idx < len) {
      const ch = text[idx];
      if (ch === '\\' && idx + 1 < len && isAsciiPunct(text[idx + 1])) { reps.push([idx, idx + 2]); idx += 2; continue; }
      if (ch !== '`') { idx++; continue; }
      let run = 0;
      while (idx + run < len && text[idx + run] === '`') run++;
      // Nearest later maximal run of exactly `run` backticks, with at
      // least one content char between the runs.
      let closePos = -1;
      let scan = idx + run + 1;
      while (scan < len) {
        if (text[scan] === '`') {
          let end = scan;
          while (end < len && text[end] === '`') end++;
          if (end - scan === run) { closePos = end; break; }
          scan = end;
        } else scan++;
      }
      if (closePos < 0) { idx += run; continue; }
      for (let pos = idx + run; pos < closePos - run;) {
        if (text[pos] === '`') {
          let end = pos;
          while (end < closePos - run && text[end] === '`') end++;
          reps.push([pos, end]);
          pos = end;
        } else pos++;
      }
      idx = closePos;
    }
    if (reps.length === 0) return text;
    const parts = [];
    let last = 0;
    for (const [from, to] of reps) {
      if (from > last) parts.push(text.slice(last, from));
      parts.push('+'.repeat(to - from));
      last = to;
    }
    if (last < len) parts.push(text.slice(last));
    return parts.join('');
  }

  // Try to match marked's blockSkip link at text[at] === '[': a label of
  // non-bracket chars and balanced backtick units, then '](...)'
  // (destination: no spaces, one level of paren nesting). Returns the
  // index just past ')' or -1.
  function findMaskedLinkEnd(text, at) {
    const len = text.length;
    let idx = at + 1;
    while (idx < len) {
      const ch = text[idx];
      if (ch === '`') {
        // Balanced backtick unit: the FIRST later run must have the
        // same length (content holds no backticks).
        let run = 0;
        while (idx + run < len && text[idx + run] === '`') run++;
        let scan = idx + run;
        if (scan >= len || text[scan] === '`') return -1;
        while (scan < len && text[scan] !== '`') scan++;
        if (scan >= len) return -1;
        let end = scan;
        while (end < len && text[end] === '`') end++;
        if (end - scan !== run) return -1;
        idx = end;
        continue;
      }
      if (ch === '[' || ch === ']') break;
      idx++;
    }
    if (idx >= len || text[idx] !== ']') return -1;
    let scan = idx + 1;
    if (scan >= len || text[scan] !== '(') return -1;
    scan++;
    while (scan < len) {
      const ch = text[scan];
      if (ch === '\\' && scan + 1 < len) { scan += 2; continue; }
      if (ch === '(') {
        scan++;
        while (scan < len) {
          const ch2 = text[scan];
          if (ch2 === '\\' && scan + 1 < len) { scan += 2; continue; }
          if (ch2 === '(' || ch2 === ')' || ch2 === ' ' || ch2 === '\t' || ch2 === '\n') break;
          scan++;
        }
        if (scan >= len || text[scan] !== ')') return -1;
        scan++;
        continue;
      }
      if (ch === ')') return scan + 1;
      if (ch === ' ' || ch === '\t' || ch === '\n') return -1;
      scan++;
    }
    return -1;
  }

  // Try to match marked's blockSkip HTML tag at text[at] === '<': '<' not
  // followed by a space, then no '<'/'>' until '>'. Returns the index
  // just past '>' or -1.
  function findMaskedTagEnd(text, at) {
    if (text[at + 1] === ' ') return -1;
    let scan = at + 1;
    while (scan < text.length) {
      if (text[scan] === '<' || text[scan] === '>') break;
      scan++;
    }
    if (scan < text.length && text[scan] === '>') return scan + 1;
    return -1;
  }

  // Marked's emphasis mask, step B: scan the transformed string for
  // blockSkip spans — inline links, code spans, HTML tags — and return
  // the [start, end) ranges they cover. A stray backtick run inside a
  // link label (e.g. `[docs each ``url`]`: its `` `` `` has no
  // same-length partner inside the label, so the link does not match
  // here) pairs with a later same-length run in step A, so step B sees
  // one long code span from the label to that later run and blanks it
  // whole: emphasis delimiters between the two never pair (doc-09/16/
  // 28/35). The real tokenization is untouched — the link and the later
  // code span still form — only emphasis is masked.
  function maskedEmphasisRanges() {
    // No backtick, bracket, or angle bracket: no code span, link, or
    // tag can occur, so nothing can be blanked — skip the whole pass.
    if (!text.includes('`') && !text.includes('[') && !text.includes('<')) return [];
    const masked = transformMasked(text);
    const len = masked.length;
    const ranges = [];
    let pos = 0;
    while (pos < len) {
      const ch = masked[pos];
      if (ch === '[') {
        const end = findMaskedLinkEnd(masked, pos);
        if (end > 0) { ranges.push([pos, end]); pos = end; continue; }
        pos++;
        continue;
      }
      if (ch === '`') {
        let run = 0;
        while (pos + run < len && masked[pos + run] === '`') run++;
        // The FIRST later run must have exactly `run` backticks
        // (code-span content holds no backticks).
        let scan = pos + run;
        while (scan < len && masked[scan] !== '`') scan++;
        if (scan < len) {
          let end = scan;
          while (end < len && masked[end] === '`') end++;
          if (end - scan === run && scan > pos + run) { ranges.push([pos, end]); pos = end; continue; }
        }
        pos += run;
        continue;
      }
      if (ch === '<') {
        const end = findMaskedTagEnd(masked, pos);
        if (end > 0) { ranges.push([pos, end]); pos = end; continue; }
        pos++;
        continue;
      }
      pos++;
    }
    return ranges;
  }

  // Try to form a link/image at the current ']' (index idx). Returns the
  // index just past the link syntax, or -1 when no link forms.
  function attemptLink(closeIdx) {
    // Find the nearest active '[' or '![' delimiter.
    let delimIdx = -1;
    for (let scan = delims.length - 1; scan >= 0; scan--) {
      const dm = delims[scan];
      if (!dm.active) continue;
      if (dm.kind === '[' || dm.kind === '![') { delimIdx = scan; break; }
    }
    if (delimIdx < 0) return -1;
    const opener = delims[delimIdx];
    const isImg = opener.kind === '![';
    // Parse what follows the ']'.
    let scan = closeIdx + 1;
    let href = null, title = null, endIdx = -1;
    if (text[scan] === '(') {
      // Inline link: find the matching ')' (nested parens, escapes).
      // A `<...>` destination may contain `)` (and `(`): skip the whole
      // angle-bracket span so its parens do not affect the depth count.
      let pos = scan + 1, depth = 1;
      let probe = pos;
      while (probe < len && (text[probe] === ' ' || text[probe] === '\t' || text[probe] === '\n')) probe++;
      if (text[probe] === '<') {
        let scan2 = probe + 1;
        while (scan2 < len) {
          if (text[scan2] === '\\' && scan2 + 1 < len && isAsciiPunct(text[scan2 + 1])) { scan2 += 2; continue; }
          if (text[scan2] === '>' || text[scan2] === '\n') break;
          scan2++;
        }
        if (text[scan2] === '>') pos = scan2 + 1;
      }
      while (pos < len && depth > 0) {
        const ch = text[pos];
        if (ch === '\\' && pos + 1 < len && isAsciiPunct(text[pos + 1])) { pos += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        pos++;
      }
      if (depth !== 0) return resolveCollapsedLink(delimIdx, opener, isImg, closeIdx, closeIdx + 1);
      // A `]` inside an unclosed code span (marked's lenient label scan)
      // does not end the label, so no link forms — and the whole
      // link-like `[...](...)` span is hidden from the emphasis parser,
      // so `_` inside the label never pairs (doc-09/16). Scan only the
      // label text (opener..closeIdx), never past the `]`.
      if (labelHasOpenSpan(text.slice(opener.src + 1, closeIdx))) {
        maskLabelDelims(opener.src, closeIdx);
        return -1;
      }
      const inner = text.slice(scan + 1, pos - 1);
      const parsed = parseLinkInnerText(inner);
      // An unparsable `(...)` is not a link at all: fall back to the
      // shortcut reference `[foo]` (cm-568 `[foo](not a link)`).
      if (!parsed) return resolveCollapsedLink(delimIdx, opener, isImg, closeIdx, closeIdx + 1);
      href = parsed.href; title = parsed.title; endIdx = pos;
    } else if (text[scan] === '[') {
      // Reference link [text][label]. A `]` inside an unclosed code span
      // does not end the label (doc-18).
      if (labelHasOpenSpan(text.slice(opener.src + 1, closeIdx))) return -1;
      const labelEnd = findLabelClose(text, scan);
      if (labelEnd < 0) return -1;
      const raw = text.slice(scan + 1, labelEnd - 1);
      const label = raw.length === 0 ? null : normalizeLinkLabel(raw);
      let ref = null;
      if (label === null) {
        // Collapsed reference: the label is the link text itself.
        ref = null; // resolved below from the link text
      } else {
        ref = refsMap.get(label);
        if (!ref) return -1;
      }
      href = ref ? ref.href : null;
      title = ref ? ref.title : null;
      endIdx = labelEnd;
      if (label === null) {
        // Mark for collapsed resolution after the link text is known.
        return resolveCollapsedLink(delimIdx, opener, isImg, closeIdx, endIdx);
      }
    } else {
      // Shortcut reference: the label is the link text itself. A `]`
      // inside an unclosed code span does not end the label.
      if (labelHasOpenSpan(text.slice(opener.src + 1, closeIdx))) return -1;
      return resolveCollapsedLink(delimIdx, opener, isImg, closeIdx, closeIdx + 1);
    }
    return buildLinkNode(delimIdx, opener, isImg, href, title, endIdx);
  }

  // Resolve a collapsed/shortcut reference link: the label is the link
  // text, taken RAW from the source (backslashes kept) so it matches the
  // definition label exactly (cm-194 `[Foo*bar\]]`, cm-550 `[bar\\]`).
  // Using the parsed plain text would strip the backslash and miss.
  function resolveCollapsedLink(delimIdx, opener, isImg, closeIdx, endIdx) {
    let labelText;
    if (opener.src >= 0) {
      labelText = text.slice(opener.src + 1, closeIdx);
    } else {
      const openNode = opener.node;
      const openPos = nodes.indexOf(openNode);
      if (openPos < 0) return -1;
      labelText = plainTextContent(nodes.slice(openPos + 1));
    }
    const ref = refsMap.get(normalizeLinkLabel(labelText));
    if (!ref) return -1;
    return buildLinkNode(delimIdx, opener, isImg, ref.href, ref.title, endIdx);
  }

  // Build the link/image node from the opener through the current nodes.
  // endIdx is the index just past the link syntax.
  function buildLinkNode(delimIdx, opener, isImg, href, title, endIdx) {
    const openNode = opener.node;
    const openPos = nodes.indexOf(openNode);
    if (openPos < 0) return -1;
    const linkText = nodes.slice(openPos + 1);
    // A link's text cannot contain an explicit link, but a bare autolink
    // inside it is just text (doc-01 `[private https://... method][ref]`
    // keeps the URL literal inside the outer link). Flatten bare
    // autolinks to their text before the explicit-link check.
    flattenBareLinkNodes(linkText);
    // A link's text cannot contain a link. Check before touching the
    // delimiter stack, so a failed link leaves the stack intact.
    if (!isImg && hasExplicitLink(linkText)) return -1;
    // Resolve emphasis inside the link text first (delimiters in range).
    const savedDelims = delims.splice(delimIdx + 1);
    resolveEmphasisRange(linkText, savedDelims);
    // Remove the opener delimiter. The delimiters that were inside the
    // link text were spliced out into savedDelims and stay out: they were
    // resolved inside the link text and cannot pair across its boundary.
    delims.splice(delimIdx, 1);
    // Drop the opener's '[' text node and the link-text nodes, push the
    // link/image node.
    nodes.splice(openPos);
    if (isImg) {
      nodes.push({ t: 'image', src: href, alt: plainTextContent(linkText), title });
    } else {
      nodes.push({ t: 'link', href, title, children: linkText });
      // An explicit link inside an open label marks every enclosing
      // label: a later bare-URL probe in that label reads hasLink in
      // O(1) instead of scanning the nodes for a link (the scan it
      // replaces). Bare/angle autolinks do not count, so only this
      // explicit-link path marks. The opener itself was already
      // removed from delims above; the remaining active '[' openers
      // are exactly the enclosing labels.
      for (const dm of delims) {
        if (dm.active && (dm.kind === '[' || dm.kind === '![')) dm.hasLink = true;
      }
    }
    return endIdx;
  }

  // Replace bare-autolink nodes (flagged bare:true) with their plain
  // text, in place, recursively. Used when a bare URL/email lands inside
  // a link's text: it stays literal there.
  function flattenBareLinkNodes(list) {
    for (let idx = 0; idx < list.length; idx++) {
      const node = list[idx];
      if (node.t === 'link' && node.bare) {
        const flat = plainTextContent(node.children);
        list.splice(idx, 1, { t: 'text', s: flat });
      } else if (node.children) {
        flattenBareLinkNodes(node.children);
      }
    }
  }

  // Does any node in the list (recursively) contain an explicit link?
  // Bare and angle autolinks do not count: bare ones are flattened to
  // text, angle ones may nest inside a link's text.
  function hasExplicitLink(list) {
    for (const node of list) {
      if (node.t === 'link' && !node.bare && !node.angle) return true;
      if (node.children && hasExplicitLink(node.children)) return true;
    }
    return false;
  }

  // Process emphasis over a detached node list (link text) using the
  // delimiters that belong to it. Operates on copies; the caller's arrays
  // are updated by reference through the shared node objects.
  function resolveEmphasisRange(linkText, rangeDelims) {
    // Temporarily swap the working arrays so resolveEmphasis runs on the
    // link text only.
    const savedNodes = nodes.splice(0, nodes.length);
    const savedDelims = delims.splice(0, delims.length);
    for (const node of linkText) nodes.push(node);
    for (const dm of rangeDelims) delims.push(dm);
    resolveEmphasis();
    // Write the processed nodes back into linkText.
    linkText.length = 0;
    for (const node of nodes) linkText.push(node);
    nodes.splice(0, nodes.length);
    delims.splice(0, delims.length);
    for (const node of savedNodes) nodes.push(node);
    for (const dm of savedDelims) delims.push(dm);
  }

  while (idx < len) {
    const ch = text[idx];
    // Backslash escape / hard break.
    if (ch === '\\') {
      if (idx + 1 < len && text[idx + 1] === '\n') {
        nodes.push({ t: 'br' });
        idx += 2;
        // After a hard break, the next line's leading spaces are stripped.
        while (idx < len && (text[idx] === ' ' || text[idx] === '\t')) idx++;
        continue;
      }
      if (idx + 1 < len && isAsciiPunct(text[idx + 1])) {
        pushText(text[idx + 1]);
        idx += 2;
        continue;
      }
      pushText('\\');
      idx++;
      continue;
    }
    // Code span.
    if (ch === '`') {
      let run = 0;
      while (idx + run < len && text[idx + run] === '`') run++;
      const closePos = findCodeSpanClose(text, idx + run, run);
      if (closePos < 0) {
        pushText(text.slice(idx, idx + run));
        idx += run;
        continue;
      }
      // A code span must not swallow the `]` that closes an open link
      // label: `[docs each ``url`]` has an unmatched `` `` `` (closing
      // run is a single backtick), and the matching `` `` `` on a later
      // line must not swallow the `]` — the link forms and the
      // backticks stay literal inside it. Only when the opening
      // backtick is INSIDE the label (before its `]`) and the strict
      // closing run lies past it; a backtick after the label's `]`
      // (e.g. doc-12 `` `max_width` `` after a nested-link label)
      // is outside the label and forms a code span normally.
      let labelEnd = -1;
      let labelUnclosed = false;
      for (let scan = delims.length - 1; scan >= 0; scan--) {
        const dm = delims[scan];
        if (dm.active && (dm.kind === '[' || dm.kind === '![') && dm.src >= 0) {
          labelEnd = findLabelClose(text, dm.src + 1);
          // The guard only applies when the link would actually form: a
          // label with an unclosed code span (lenient pairing — a run
          // closes at the first run of any length, as in marked's label
          // regex) never forms a link, so a code span opening inside it
          // must not be blocked. (A strict-pairing check here broke
          // doc-09: `[docs each ``url`](...) forms its link, and the
          // single backtick must not open a code span that swallows
          // the `]`.)
          if (labelEnd >= 0) labelUnclosed = labelHasOpenSpan(text.slice(dm.src + 1, labelEnd - 1));
          break;
        }
      }
      if (labelEnd >= 0 && !labelUnclosed && idx < labelEnd && closePos > labelEnd) {
        pushText(text.slice(idx, idx + run));
        idx += run;
        continue;
      }
      let content = text.slice(idx + run, closePos - run);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          content.trim() !== '') {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content });
      idx = closePos;
      continue;
    }
    // Emphasis / strikethrough delimiter run.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (idx + run < len && text[idx + run] === ch) run++;
      const before = idx > 0 ? text[idx - 1] : '';
      const after = idx + run < len ? text[idx + run] : '';
      const [leftF, rightF] = flankingType(text, before, after);
      let canOpen, canClose;
      if (ch === '~') {
        canOpen = leftF;
        canClose = rightF;
        if (run > 2) { pushText(text.slice(idx, idx + run)); idx += run; continue; }
      } else if (ch === '_') {
        canOpen = leftF && (!rightF || isPunctuationChar(before));
        canClose = rightF && (!leftF || isPunctuationChar(after));
      } else {
        canOpen = leftF;
        canClose = rightF;
      }
      const node = { t: 'text', s: text.slice(idx, idx + run) };
      nodes.push(node);
      pushDelimiter(ch, run, canOpen, canClose, node, idx);
      idx += run;
      continue;
    }
    // Image opener.
    if (ch === '!' && text[idx + 1] === '[') {
      const node = { t: 'text', s: '![' };
      nodes.push(node);
      pushDelimiter('![', 1, true, false, node, idx + 1);
      idx += 2;
      continue;
    }
    // Link opener.
    if (ch === '[') {
      const node = { t: 'text', s: '[' };
      nodes.push(node);
      pushDelimiter('[', 1, true, false, node, idx);
      idx++;
      continue;
    }
    // Link/image close.
    if (ch === ']') {
      const end = attemptLink(idx);
      if (end >= 0) { idx = end; continue; }
      // No link formed: deactivate the nearest '[' opener, emit ']' literally.
      for (let scan = delims.length - 1; scan >= 0; scan--) {
        const dm = delims[scan];
        if (dm.active && (dm.kind === '[' || dm.kind === '![')) { dm.active = false; break; }
      }
      pushText(']');
      idx++;
      continue;
    }
    // Angle autolink or raw HTML.
    if (ch === '<') {
      const auto = matchAngleLink(text, idx);
      if (auto) {
        // Angle autolinks may nest inside a link's text (doc-03
        // `[.. <https://..> ..](..)` keeps the inner link); they are
        // not flattened and do not block the outer link.
        nodes.push({ t: 'link', href: auto.href, title: null, angle: true, children: [{ t: 'text', s: auto.text }] });
        idx = auto.end;
        continue;
      }
      const tagEnd = scanHtmlTagToken(text, idx);
      if (tagEnd > 0) {
        const tag = text.slice(idx, tagEnd);
        // Raw <a>...</a> suppresses autolinks inside it (marked insideLink).
        // marked's startATag is /^<a /i: only `<a ` WITH a space (i.e.
        // with attributes) sets it — a bare `<a>` does not (doc-04).
        const low = tag.toLowerCase();
        if (low.startsWith('<a ') || low.startsWith('<a\t') || low.startsWith('<a\n')) insideLink = true;
        else if (low === '</a>' || low.startsWith('</a ') || low.startsWith('</a\t') || low.startsWith('</a\n') || low.startsWith('</a>')) insideLink = false;
        nodes.push({ t: 'html', s: tag });
        idx = tagEnd;
        continue;
      }
      pushText('<');
      idx++;
      continue;
    }
    // Entity / numeric reference. A named entity (&word;) is emitted as a
    // single text node so escapeText preserves it; a bare & is escaped.
    if (ch === '&') {
      const ref = numericCharRef(text, idx);
      if (ref) {
        pushText(ref.ch);
        idx += ref.len;
        continue;
      }
      let scan = idx + 1;
      while (scan < len && (isAlphaNumeric(text[scan]) || text[scan] === '_')) scan++;
      if (scan > idx + 1 && scan < len && text[scan] === ';') {
        pushText(text.slice(idx, scan + 1));
        idx = scan + 1;
        continue;
      }
      pushText('&');
      idx++;
      continue;
    }
    // Hard break: two or more trailing spaces before a newline.
    if (ch === '\n') {
      nodes.push({ t: 'soft' });
      idx++;
      continue;
    }
    // Bare autolinks (scheme / www) and emails, at a word boundary.
    // Suppressed inside a raw <a>...</a> (insideLink).
    if (!insideLink && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W' || ch === 'm' || ch === 'M' || ch === 'x' || ch === 'X') && (idx === 0 || !isAlphaNumeric(text[idx - 1]))) {
      // A bare URL stops at `]` only when it is inside a link label
      // whose link can still form. If the open label already contains
      // a link node, the link cannot form (a link's text cannot contain
      // a link), so the `]` is free for the URL: doc-08
      // `(https://a.com)](https://b.com)` is one autolink, not two.
      // And if the label cannot form a link at all (no inline `(` and
      // no defined reference — doc-40 `[test render www.tiny.com]
      // [library issues]`), the `]` is likewise free: marked's URL
      // swallows `][library` into the autolink.
      let inLabel = false;
      for (let scan2 = delims.length - 1; scan2 >= 0; scan2--) {
        const dm = delims[scan2];
        if (dm.active && (dm.kind === '[' || dm.kind === '![')) {
          // hasLink is maintained by buildLinkNode: an explicit link was
          // created inside this label. (A bare/angle autolink inside
          // does not count, and buildLinkNode does not mark for those.)
          const hasLink = !!dm.hasLink;
          if (!hasLink && dm.src >= 0) {
            const le = findLabelClose(text, dm.src + 1);
            if (le >= 0 && !labelHasOpenSpan(text.slice(dm.src + 1, le - 1))) {
              const after = text[le];
              if (after === '(') inLabel = true;
              else if (after === '[') {
                const re2 = findLabelClose(text, le + 1);
                if (re2 >= 0) {
                  const refLab = text.slice(le + 1, re2 - 1);
                  const key = refLab.length === 0 ? normalizeLinkLabel(text.slice(dm.src + 1, le - 1)) : normalizeLinkLabel(refLab);
                  if (refsMap.has(key)) inLabel = true;
                }
              } else {
                if (refsMap.has(normalizeLinkLabel(text.slice(dm.src + 1, le - 1)))) inLabel = true;
              }
            }
          }
          break;
        }
      }
      const auto = matchBareLink(text, idx, inLabel);
      if (auto) {
        nodes.push({ t: 'link', href: auto.href, title: null, bare: true, children: [{ t: 'text', s: auto.text }] });
        idx = auto.end;
        continue;
      }
    }
    if (!insideLink && hasAt && isAlphaNumeric(ch) && (idx === 0 || !isEmailLocalChar(text[idx - 1]))) {
      // A trailing `_` is an emphasis closer (not an email char) when
      // there is an active `_` opener that can pair with it.
      let allowU = false;
      if (hasUnderscore) {
        for (let scan2 = delims.length - 1; scan2 >= 0; scan2--) {
          const dm = delims[scan2];
          if (dm.active && dm.kind === '_' && dm.canOpen) { allowU = true; break; }
        }
      }
      const email = matchEmailAddress(text, idx, allowU);
      if (email) {
        nodes.push({ t: 'link', href: 'mailto:' + email.text, title: null, bare: true, children: [{ t: 'text', s: email.text }] });
        idx = email.end;
        continue;
      }
    }
    // Plain text run up to the next special character. First jump to
    // the next special char with a regex; if the segment between here
    // and there contains no autolink/email trigger, take it whole.
    // Otherwise fall back to the per-char loop for this segment.
    INLINE_TRIGGER_PATTERN.lastIndex = idx;
    const special = INLINE_TRIGGER_PATTERN.exec(text);
    const segEnd = special ? special.index : len;
    if (!insideLink) {
      const seg = text.slice(idx, segEnd);
      // Cheap trigger check (native indexOf, not regex): an autolink or
      // email can only start if one of these substrings is present.
      if (seg.indexOf('@') < 0 && seg.indexOf('://') < 0 && seg.indexOf('www.') < 0 &&
          seg.indexOf('mailto:') < 0 && seg.indexOf('xmpp:') < 0) {
        let runText = seg;
        if (segEnd < len && text[segEnd] === '\n') {
          const trail = / {2,}$/.exec(runText);
          if (trail) {
            runText = runText.slice(0, runText.length - trail[0].length);
            pushText(runText);
            nodes.push({ t: 'br' });
            idx = segEnd + 1;
            while (idx < len && (text[idx] === ' ' || text[idx] === '\t')) idx++;
            continue;
          }
        }
        pushText(runText);
        idx = segEnd;
        continue;
      }
    }
    let scan = idx;
    while (scan < len) {
      const ch2 = text[scan];
      if (ch2 === '\\' || ch2 === '`' || ch2 === '*' || ch2 === '_' || ch2 === '~' ||
          ch2 === '[' || ch2 === ']' || ch2 === '<' || ch2 === '&' || ch2 === '\n' ||
          (ch2 === '!' && text[scan + 1] === '[')) break;
      const prev = scan > 0 ? text[scan - 1] : '';
      if (!insideLink && (ch2 === 'h' || ch2 === 'H' || ch2 === 'f' || ch2 === 'F' || ch2 === 'w' || ch2 === 'W' || ch2 === 'm' || ch2 === 'M' || ch2 === 'x' || ch2 === 'X') && !isAlphaNumeric(prev) &&
          matchBareLink(text, scan)) break;
      if (!insideLink && hasAt && isAlphaNumeric(ch2) && !isEmailLocalChar(prev)) {
        let allowU = false;
        if (hasUnderscore) {
          for (let scan2 = delims.length - 1; scan2 >= 0; scan2--) {
            const dm = delims[scan2];
            if (dm.active && dm.kind === '_' && dm.canOpen) { allowU = true; break; }
          }
        }
        if (matchEmailAddress(text, scan, allowU)) break;
      }
      scan++;
    }
    // Two trailing spaces before a newline are a hard break: handled by
    // trimming the run and emitting <br> when the next char is '\n'.
    let runText = text.slice(idx, scan);
    if (scan < len && text[scan] === '\n') {
      const trail = / {2,}$/.exec(runText);
      if (trail) {
        runText = runText.slice(0, runText.length - trail[0].length);
        pushText(runText);
        nodes.push({ t: 'br' });
        idx = scan + 1;
        // After a hard break, the next line's leading spaces are stripped.
        while (idx < len && (text[idx] === ' ' || text[idx] === '\t')) idx++;
        continue;
      }
    }
    pushText(runText);
    idx = scan;
  }
  // Deactivate emphasis delimiters lying inside a masked span (see
  // maskedEmphasisRanges): marked never pairs them (doc-09/16/28/35).
  // Link-text delimiters are already scoped out (buildLinkNode splices
  // them into their own range), so only top-level delimiters remain.
  // The mask is computed lazily: a paragraph with no emphasis
  // delimiters skips the whole pass (maskTransform + scans).
  let hasEmDelim = false;
  for (const dm of delims) {
    if (dm.active && (dm.kind === '*' || dm.kind === '_' || dm.kind === '~')) { hasEmDelim = true; break; }
  }
  if (hasEmDelim) {
    const maskRanges = maskedEmphasisRanges();
    if (maskRanges.length > 0) {
      for (const dm of delims) {
        if (!dm.active || (dm.kind !== '*' && dm.kind !== '_' && dm.kind !== '~')) continue;
        for (const [from, to] of maskRanges) {
          if (dm.src > from && dm.src < to) { dm.active = false; break; }
        }
      }
    }
  }
  resolveEmphasis();
  return nodes;
}

// Parse the inside of an inline link's parentheses: a destination and an
// optional title. Returns {href, title} or null.
function parseLinkInnerText(inner) {
  let idx = 0;
  while (idx < inner.length && (inner[idx] === ' ' || inner[idx] === '\t' || inner[idx] === '\n')) idx++;
  // An empty destination `()` is a valid link with an empty href.
  if (idx >= inner.length) return { href: '', title: null };
  const dest = parseLinkDestination(inner, idx);
  if (!dest) return null;
  let href = dest.href;
  let title = null;
  let pos = dest.end;
  while (pos < inner.length && (inner[pos] === ' ' || inner[pos] === '\t' || inner[pos] === '\n')) pos++;
  if (pos < inner.length) {
    const parsed = parseLinkTitle(inner, pos);
    if (!parsed) return null;
    title = parsed.title;
    pos = parsed.end;
    while (pos < inner.length && (inner[pos] === ' ' || inner[pos] === '\t' || inner[pos] === '\n')) pos++;
    if (pos < inner.length) return null;
  }
  return { href, title };
}

// Is the character part of an email local part (for word-boundary checks)?
function isEmailLocalChar(char) {
  return isAlphaNumeric(char) || char === '.' || char === '_' || char === '%' || char === '+' || char === '-';
}

// Bare autolink (scheme:// or www.) starting at text[at]. The preceding
// character must not be alphanumeric (word boundary). Returns
// {end, href, text} or null. `inLabel` is true when the URL starts
// inside a link label: only then does a `]` end the URL (so it does not
// swallow the label's closing bracket); outside a label, marked's URL
// regex `[^\s<]*` keeps `]` (and a following `(...)`) in the URL
// (doc-08 `(https://a.com)](https://b.com)` is one autolink).
function matchBareLink(text, at, inLabel) {
  if (at > 0 && isAlphaNumeric(text[at - 1])) return null;
  let scheme = null;
  if (startsWithFolded(text, at, 'http://')) scheme = text.slice(at, at + 7);
  else if (startsWithFolded(text, at, 'https://')) scheme = text.slice(at, at + 8);
  else if (startsWithFolded(text, at, 'ftp://')) scheme = text.slice(at, at + 6);
  else if (startsWithFolded(text, at, 'mailto:')) {
    // mailto:email — the whole `mailto:foo@bar.baz` is one link.
    const email = matchEmailAddress(text, at + 7);
    if (!email) return null;
    const url = text.slice(at, at + 7) + email.text;
    return { end: at + 7 + email.text.length, href: url, text: url };
  } else if (startsWithFolded(text, at, 'xmpp:')) {
    // xmpp:email[/resource] — one optional `/segment` resource.
    const email = matchEmailAddress(text, at + 5);
    if (!email) return null;
    let end = at + 5 + email.text.length;
    let url = text.slice(at, at + 5) + email.text;
    if (text[end] === '/') {
      let pos = end + 1;
      while (pos < text.length) {
        const ch = text[pos];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '/') break;
        pos++;
      }
      if (pos > end + 1) { url = text.slice(at, pos); end = pos; }
    }
    return { end, href: url, text: url };
  } else if (text.startsWith('www.', at)) {
    if (at > 0) {
      const prev = text[at - 1];
      if (!(prev === ' ' || prev === '\t' || prev === '\n' || prev === '(')) return null;
    }
    scheme = 'www.';
  }
  if (!scheme) return null;
  let pos = at + scheme.length;
  const len = text.length;
  while (pos < len) {
    const ch = text[pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || (inLabel && ch === ']')) break;
    pos++;
  }
  if (pos === at + scheme.length) return null;
  let url = text.slice(at, pos);
  url = trimUrlString(url);
  if (!url) return null;
  // A www. link needs a dot in the domain part after www.
  if (scheme === 'www.' && url.indexOf('.', 4) < 0) return null;
  const href = scheme === 'www.' ? 'http://' + url : url;
  return { end: at + url.length, href, text: url };
}

// Email autolink starting at text[at] (a word character). Returns
// {end, text} or null.
function matchEmailAddress(text, at, allowTrailingUnderscore) {
  const len = text.length;
  // Fast reject: an email needs an `@` within the current word (before
  // the next space or special char). Scanning for `@` first avoids the
  // full local-part parse for ordinary words.
  let atPos = -1;
  for (let scan = at; scan < len && scan < at + 64; scan++) {
    const ch = text[scan];
    if (ch === '@') { atPos = scan; break; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<') break;
  }
  if (atPos < 0) return null;
  // Local part: letters, digits and . _ % + - (not starting/ending with .).
  let pos = at;
  while (pos < len) {
    const ch = text[pos];
    if (isAlphaNumeric(ch) || ch === '.' || ch === '_' || ch === '%' || ch === '+' || ch === '-') pos++;
    else break;
  }
  if (pos === at || text[pos] !== '@') return null;
  const local = text.slice(at, pos);
  if (local[0] === '.' || local[local.length - 1] === '.') return null;
  let domStart = pos + 1;
  const ds = domStart;
  while (domStart < len) {
    const ch = text[domStart];
    if (isAlphaNumeric(ch) || ch === '.' || ch === '-') domStart++;
    else break;
  }
  if (domStart === ds) return null;
  let dom = text.slice(ds, domStart);
  dom = trimUrlString(dom);
  if (!dom || dom.indexOf('.') < 0) return null;
  if (dom[0] === '.' || dom[0] === '-' || dom[dom.length - 1] === '.' || dom[dom.length - 1] === '-') return null;
  // The char after the domain must not be a word char or `-` (gfm-632
  // `a.b-c_d@a.b_` is not an email: the `_` continues the identifier).
  // But a trailing `_` that is an emphasis closer (there is an active
  // `_` opener that can pair with it, doc-04 `__.. because@mark..__`)
  // does not continue the email — the email is linkified inside the em.
  const after = text[ds + dom.length];
  if (after !== undefined && (isAlphaNumeric(after) || after === '-')) return null;
  if (after === '_' && !allowTrailingUnderscore) return null;
  return { end: ds + dom.length, text: local + '@' + dom };
}
function canInterruptParagraph(mark, isEmpty) {
  if (isEmpty) return false;
  if (!mark.ordered) return true;
  return mark.start === 1;
}

// Start (or continue) a list for the marker at (text, col). Creates the
// list/item, pushes the item, and returns the item's first content
// {content, col, line} or null. `line` is the current line index.
function startListItemNode(ctx, row, stack, mark, text, col, sawBlank, blankDepth) {
  // Content indent: marker start + marker width + following spaces (1-4
  // spaces; 5+ means only 1 column is consumed, the rest is content).
  const lead = indentSize(text, 0, col);
  const markCol = lead.col; // column of the marker
  const afterIdx = lead.idx + mark.markerLen;
  const afterCol = markCol + mark.markerLen;
  // Measure the whitespace after the marker (up to 5 columns).
  let wsIdx = afterIdx, wsCol = afterCol, wsCols = 0;
  while (wsIdx < text.length && wsCols < 5) {
    const ch = text[wsIdx];
    if (ch === ' ') { wsIdx++; wsCol++; wsCols++; }
    else if (ch === '\t') { const width = 4 - (wsCol % 4); wsIdx++; wsCol += width; wsCols += width; }
    else break;
  }
  let contentIndent;
  let firstContent;
  if (isBlankAtPos(text, afterIdx)) {
    // Empty item: content starts on a later line.
    contentIndent = markCol + mark.markerLen + 1;
    firstContent = '';
  } else if (wsCols >= 5) {
    // 5+ spaces: consume only 1 column; the rest is content (a partially
    // consumed tab becomes pad spaces).
    contentIndent = markCol + mark.markerLen + 1;
    const moved = advanceToColumn(text, afterIdx, afterCol, 0, contentIndent);
    firstContent = ' '.repeat(moved.pad) + text.slice(moved.pos);
  } else {
    contentIndent = wsCol;
    firstContent = text.slice(wsIdx);
  }
  // Task list item: the first line's content starts with [ ] / [x] / [X]
  // followed by a space/tab and more content on the same line. Only on the
  // marker line (a [ ] on a later line is not a task). Strip the marker
  // and the following whitespace; the renderer emits the checkbox.
  let task = undefined;
  if (firstContent.length >= 4 && firstContent[0] === '[' &&
      (firstContent[1] === ' ' || firstContent[1] === 'x' || firstContent[1] === 'X') &&
      firstContent[2] === ']' &&
      (firstContent[3] === ' ' || firstContent[3] === '\t')) {
    let scan = 3;
    while (scan < firstContent.length && (firstContent[scan] === ' ' || firstContent[scan] === '\t')) scan++;
    if (scan < firstContent.length) {
      task = firstContent[1] === 'x' || firstContent[1] === 'X';
      firstContent = firstContent.slice(scan);
    }
  }
  // Find or create the list: the current container's last child, if it is a
  // list of the same kind, continues when the new marker is a sibling of
  // the last item — i.e. its indent is below the last item's content
  // indent (so `- foo`, ` - bar`, `  - baz` are one list). At or above
  // that indent it is a sublist (a new list nested in the item).
  const parent = parentBlockNode(stack);
  const kids = parent.children;
  let list = null;
  if (kids.length > 0) {
    const last = kids[kids.length - 1];
    if (last.t === 'list' && last.ordered === mark.ordered &&
        last._delim === mark.delim && last.items.length > 0) {
      const lastItem = last.items[last.items.length - 1];
      if (markCol - col < lastItem._contentIndent) list = last;
    }
  }
  if (!list) {
    list = { t: 'list', ordered: mark.ordered, start: mark.start, tight: true, items: [], _markerIndent: markCol, _delim: mark.delim };
    markLooseList(parent, sawBlank, blankDepth, stack);
    kids.push(list);
  } else if (sawBlank && list.items.length > 0 &&
      (blankDepth === undefined || blankDepth < 0 ||
       blankDepth <= stack.indexOf(parent) + 2)) {
    // Depth-scoped (cm-320): a blank inside a nested container (e.g. a
    // `>`-only line in a blockquote within the previous item) does not
    // loosen the list; only a blank at or above the list's level does.
    list.tight = false;
  }
  const item = { t: 'item', children: [], _contentIndent: contentIndent - col, _list: list };
  if (task !== undefined) item._task = task;
  list.items.push(item);
  stack.push(item);
  return { content: firstContent, col: contentIndent, line: row };
}

// Parse a fenced code block starting at line row. Returns the next line index.
function parseFencedCodeBlock(ctx, row, stack, fence, text, col, sawBlank, blankDepth) {
  const rows = [];
  let scan = row + 1;
  const total = ctx.lines.length;
  // The fence's own indent is stripped from every code line — but only
  // for BACKTICK fences. A TILDE fence never dedents its content in
  // marked (doc-22: `~~~typescript` keeps the 3 spaces of its content
  // line; a ``` fence at the same indent strips them).
  const fenceIndent = fence.ch === '~' ? 0 : indentSize(text, 0, col).col - col;
  while (scan < total) {
    const got = contentAtLine(ctx, scan, stack);
    if (got) {
      if (isFenceClosing(got.content, 0, got.col, fence.ch, fence.len)) { scan++; break; }
      // A blank line that is missing a BLOCKQUOTE marker ends the
      // blockquote — and a fence inside it — instead of becoming an
      // empty code line (doc-06 `>` with no inner `> > `; doc-08 a
      // bare blank line after a fence opened in a blockquote). A
      // completely blank line is code content only when the fence is
      // NOT inside a blockquote (doc-02 list-item fence); a blank line
      // missing only a LIST indent is still fence content.
      if (got.content.trim() === '') {
        const raw = ctx.lines[scan];
        let quotesInStack = 0;
        for (let depth = 1; depth < stack.length; depth++) {
          if (stack[depth].t === 'para') break;
          if (stack[depth].t === 'quote') quotesInStack++;
        }
        if (quotesInStack > 0) {
          if (/^[ \t]*$/.test(raw)) break;
          // Count the `>` markers the raw line actually has. The
          // markers may sit past a list-item indent (more than 3
          // spaces), so skip all leading whitespace before each `>`
          // — contentAtLine already validated the line against the
          // containers, so a `>` here is a marker, not code text.
          let markers = 0, pos = 0;
          while (pos < raw.length) {
            while (pos < raw.length && (raw[pos] === ' ' || raw[pos] === '\t')) pos++;
            if (pos < raw.length && raw[pos] === '>') { markers++; pos++; }
            else break;
          }
          if (markers < quotesInStack) break;
        }
      }
      let line = contentFromColumn(got.content, got.col, got.col + fenceIndent, true);
      // A leading tab in the dedented content expands to spaces when the
      // fence is inside a container (doc-22: `>   \tindented` in a
      // ```rust fence becomes 4 spaces; at top level the tab is kept).
      // The tab's width comes from its ABSOLUTE column in the source
      // (the dedented content starts at got.col + fenceIndent), not from
      // column 0 of the dedented line (doc-30: a tab at absolute column
      // 3 expands to 1 space, not 4).
      if (stack.length > 1 && line.length > 0 && line.slice(0, line.search(/[^ \t]/) < 0 ? line.length : line.search(/[^ \t]/)).includes('\t')) {
        let buf = '', col2 = got.col + fenceIndent, idx = 0;
        while (idx < line.length && (line[idx] === ' ' || line[idx] === '\t')) {
          if (line[idx] === ' ') { buf += ' '; col2++; idx++; }
          else { const width = 4 - (col2 % 4); buf += ' '.repeat(width); col2 += width; idx++; }
        }
        line = buf + line.slice(idx);
      }
      rows.push(line);
      scan++;
      continue;
    }
    // A line that does not match the enclosing containers still belongs
    // to an open fenced code block when the mismatch is a LIST item
    // (marked keeps a column-0 line inside a fence opened in a list
    // item). A blank line, or a line that fails a BLOCKQUOTE marker,
    // closes the blockquote (and the fence) instead.
    const raw = ctx.lines[scan];
    if (isBlankAtPos(raw, 0)) break;
    let quoteFails = false;
    let itemIndentFails = false;
    {
      let pos2 = 0, col2 = 0, pad2 = 0;
      for (let depth = 1; depth < stack.length; depth++) {
        const block = stack[depth];
        if (block.t === 'para') break;
        if (isBlankAtPos(raw, pos2)) break;
        if (block.t === 'quote') {
          const mark = matchBlockquoteMarker(raw, pos2, col2, pad2);
          if (!mark) { quoteFails = true; break; }
          pos2 = mark.pos; col2 = mark.col; pad2 = mark.pad;
        } else if (block.t === 'item') {
          const wantCol = col2 + block._contentIndent;
          const lead = indentFromColumn(raw, pos2, col2, pad2);
          if (lead.col < wantCol) { itemIndentFails = true; break; }
          const moved = advanceToColumn(raw, pos2, col2, pad2, wantCol);
          pos2 = moved.pos; col2 = moved.col; pad2 = moved.pad;
        }
      }
    }
    if (quoteFails) break;
    // A line that starts a new list item is a new block, not fence
    // content (doc-05 `* [x] ...` after a fenced blockquote; doc-21
    // `  - b` after a fence in a nested blockquote; doc-36 `      * Pull`
    // after a fence in a blockquote). The marker may be indented to the
    // enclosing list's level (any number of spaces), as long as the line
    // fails the enclosing item's content indent (itemIndentFails).
    // Plain text (e.g. `npm install ...`) is still absorbed.
    if (itemIndentFails && /^ *(?:[*+-]|\d{1,9}[.)])[ \t]/.test(raw)) break;
    // An EMPTY fence in a list item ends at a line that fails the item's
    // content indent: a column-0 line cannot be the fence's first
    // content line (doc-17: `1. item` + `   ```toml` + `if previous` is
    // an empty fence + a paragraph). Once the fence has content, such
    // lines are absorbed as code (doc-05, cases A/C/E). A fence in a
    // blockquote (no list item) still absorbs them (itemIndentFails is
    // false there).
    if (itemIndentFails && rows.length === 0) break;
    if (isFenceClosing(raw, 0, 0, fence.ch, fence.len)) { scan++; break; }
    rows.push(contentFromColumn(raw, 0, fenceIndent, true));
    scan++;
  }
  // Drop exactly one trailing empty line (the code always ends with a
  // newline); whitespace-only lines with spaces are kept.
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  const code = rows.length === 0 ? '' : rows.join('\n') + '\n';
  const parent = parentBlockNode(stack);
  markLooseList(parent, sawBlank, blankDepth, stack);
  parent.children.push({ t: 'code', fenced: true, info: fence.info, text: code });
  return scan;
}

// Parse an indented code block starting at line row. Returns next line index.
// Line row uses the already container-stripped `text` (it may be the list
// marker line, which contentAtLine could not re-derive); later lines go through
// contentAtLine.
function parseIndentedCodeBlock(ctx, row, stack, text, col, sawBlank, blankDepth) {
  const rows = [];
  let scan = row;
  const total = ctx.lines.length;
  // Blank lines are held as pending: they only join the code block if a
  // later non-blank line is still indented code. Otherwise the block ends
  // BEFORE the first pending blank line, so the main loop sees it (and a
  // bare blank line can close an enclosing blockquote).
  let pending = [];
  let pendingStart = -1;
  while (scan < total) {
    const got = scan === row ? { content: text, col } : contentAtLine(ctx, scan, stack);
    if (!got) break;
    if (isBlankAtPos(got.content, 0)) {
      if (pendingStart < 0) pendingStart = scan;
      pending.push(contentFromColumn(got.content, got.col, got.col + 4));
      scan++;
      continue;
    }
    const lead = indentSize(got.content, 0, got.col);
    if (lead.col - got.col < 4) break;
    for (const held of pending) rows.push(held);
    pending = []; pendingStart = -1;
    rows.push(contentFromColumn(got.content, got.col, got.col + 4));
    scan++;
  }
  // Strip ALL trailing blank lines (indented code ends at the last
  // non-blank line; the final newline is added by the join below).
  while (rows.length > 0 && isBlankAtPos(rows[rows.length - 1], 0)) rows.pop();
  const code = rows.length === 0 ? '' : rows.join('\n') + '\n';
  const parent = parentBlockNode(stack);
  markLooseList(parent, sawBlank, blankDepth, stack);
  parent.children.push({ t: 'code', fenced: false, info: '', text: code });
  // If we stopped at a non-code line with pending blank lines, resume at
  // the first pending blank line so the main loop sees it.
  return pendingStart >= 0 ? pendingStart : scan;
}

// Parse an HTML block. html = {type, endLine} from htmlBlockAtLine. Returns the
// next line index. The block's lines are the container-stripped content
// lines (blockquote/list markers are not part of the HTML output).
function parseHtmlBlockNode(ctx, row, stack, html, text, col, sawBlank, blankDepth) {
  const parent = parentBlockNode(stack);
  markLooseList(parent, sawBlank, blankDepth, stack);
  const rawLines = [text];
  for (let scan = row + 1; scan <= html.endLine; scan++) {
    const got = contentAtLine(ctx, scan, stack);
    rawLines.push(got ? got.content : '');
  }
  // Trailing newline (delimited types 1-5 only: script/pre/style,
  // comment, PI, declaration, CDATA — all end at a closing marker):
  // present iff the block is followed by a line that is not completely
  // empty — a whitespace-only line (space or tab) counts (doc-15: a
  // tab-only line after `-->` keeps the trailing newline), but a truly
  // empty line does not. Tag blocks (types 6-7) never have one. At EOF
  // it depends on the source ending with a newline at top level.
  let trailingNL = false;
  if (html.endLine < ctx.n - 1) {
    if (html.type <= 5) {
      const next = contentAtLine(ctx, html.endLine + 1, stack);
      trailingNL = !!next && next.content.length > 0;
    }
  } else {
    trailingNL = stack.length === 1 && ctx.endsNL;
  }
  parent.children.push({ t: 'html', lines: rawLines, trailingNL });
  return html.endLine + 1;
}

// Parse a table starting at line row (header = current line, delimiter = next
// line). Returns the next line index. Rows are padded with empty cells or
// truncated to the header cell count.
function parseTableNode(ctx, row, stack, header, delim, text, col, sawBlank, blankDepth) {
  const rows = [];
  let scan = row + 2;
  const total = ctx.lines.length;
  while (scan < total) {
    const got = contentAtLine(ctx, scan, stack);
    if (!got) break;
    // A line with exactly one tab is a table row of empty cells in
    // marked (doc-02); two tabs or tab+space is a blank line.
    if (got.content === '\t') {
      const cells = [];
      while (cells.length < header.length) cells.push('');
      rows.push(cells);
      scan++;
      continue;
    }
    if (isBlankAtPos(got.content, 0)) break;
    // A line that starts a block (blockquote, heading, fence, ...) ends
    // the table; a bare line without `|` is still a one-cell row.
    if (interruptingBlockType(ctx, scan, got.content, got.col, stack)) break;
    const cells = splitTableRowCells(got.content);
    while (cells.length < header.length) cells.push('');
    if (cells.length > header.length) cells.length = header.length;
    rows.push(cells);
    scan++;
  }
  const parent = parentBlockNode(stack);
  markLooseList(parent, sawBlank, blankDepth, stack);
  parent.children.push({ t: 'table', aligns: delim, header, rows });
  return scan;
}

// HTML block start, content-based (works on the container-stripped content
// string of the current line). Returns {type, endLine} or null. Lookahead
// lines are read through contentAtLine with the live stack, so blockquote/list
// markers are stripped before the closing-marker search. A line that does
// not continue the containers ends the block.
function htmlBlockAtLine(ctx, row, text, col, inParagraph, stack) {
  const lead = indentSize(text, 0, col);
  if (lead.col - col > 3) return null;
  const idx = lead.idx;
  if (text[idx] !== '<') return null;
  const tail = text.slice(idx);
  // Scan subsequent lines for a substring; returns the line index where it
  // is found, or the last line that continues the containers.
  function scanForText(needle) {
    let last = row;
    for (let scan = row; scan < ctx.n; scan++) {
      const got = scan === row ? { content: text } : contentAtLine(ctx, scan, stack);
      if (!got) return last;
      last = scan;
      if (got.content.indexOf(needle) >= 0) return scan;
    }
    return last;
  }
  function scanForPattern(pattern) {
    let last = row;
    for (let scan = row; scan < ctx.n; scan++) {
      const got = scan === row ? { content: text } : contentAtLine(ctx, scan, stack);
      if (!got) return last;
      last = scan;
      if (pattern.test(got.content)) return scan;
    }
    return last;
  }
  // Type 1 starts only with the OPENING tag <pre>/<script>/<style>/
  // <textarea>; a closing tag alone (</pre>) is paragraph text (cm-148).
  const head = /^<(script|pre|style|textarea)(?=[\s>\/]|$)/i.exec(tail);
  if (head) {
    const tag = head[1].toLowerCase();
    return { type: 1, endLine: scanForPattern(new RegExp('</' + tag + '\\s*>', 'i')) };
  }
  if (tail.startsWith('<!--')) return { type: 2, endLine: scanForText('-->') };
  if (tail.startsWith('<?')) return { type: 3, endLine: scanForText('?>') };
  if (tail.startsWith('<!') && tail.length > 2 && /[A-Za-z]/.test(tail[2])) {
    return { type: 4, endLine: scanForText('>') };
  }
  if (tail.startsWith('<![CDATA[')) return { type: 5, endLine: scanForText(']]>') };
  // Type 6: the line begins with < or </ followed by a block tag name,
  // followed by whitespace, end of line, > or />. The tag need NOT close
  // on this line. Type 7: a complete non-block tag.
  const tagMatch = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tail);
  if (tagMatch) {
    const tagName = tagMatch[1].toLowerCase();
    const next = tail[tagMatch[0].length];
    const nextOk = next === undefined || next === ' ' || next === '\t' ||
      next === '>' || (next === '/' && tail[tagMatch[0].length + 1] === '>');
    if (nextOk) {
      let scan = row;
      while (scan + 1 < ctx.n) {
        const got = contentAtLine(ctx, scan + 1, stack);
        if (!got || isBlankAtPos(got.content, 0)) break;
        scan++;
      }
      if (HTML_BLOCK_TAG_SET.has(tagName)) return { type: 6, endLine: scan };
      // Type 7: a complete non-block tag that is alone on the line (only
      // whitespace may follow it); otherwise it is inline HTML in a
      // paragraph, e.g. <del>*foo*</del>.
      if (!inParagraph) {
        const tagEnd = scanHtmlTagToken(text, idx);
        if (tagEnd > 0 && isBlankAtPos(text, tagEnd)) return { type: 7, endLine: scan };
      }
    }
  }
  return null;
}

// Check whether text (starting at at) begins an autolink <scheme:...> or
// <email>. Returns {end, href, text} or null.
function matchAngleLink(text, at) {
  const len = text.length;
  const closePos = text.indexOf('>', at + 1);
  if (closePos < 0) return null;
  const inner = text.slice(at + 1, closePos);
  if (inner.length === 0 || inner.indexOf(' ') >= 0 || inner.indexOf('\n') >= 0 || inner.indexOf('<') >= 0) return null;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  const match = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
  if (match) return { end: closePos + 1, href: inner, text: inner };
  // Email: local@domain with a dot in the domain.
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(inner)) {
    return { end: closePos + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}
