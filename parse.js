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
  const TRAILING = '?!.,:;*_\\\'"~&(';
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
