// A fast, dependency-free drop-in for marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off, async off). Hand-written single-pass
// parser: blocks walk lines once, inline runs in one scan with a delimiter
// stack for emphasis, and HTML is emitted straight into an array.
// parse() is stateless per call: nothing is kept between calls.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_SET = new Set(BLOCK_TAGS.split('|'));

// ASCII punctuation that a backslash can escape.
function isPunct(ch) {
  return (ch >= '!' && ch <= '/') || (ch >= ':' && ch <= '@') ||
    (ch >= '[' && ch <= '`') || (ch >= '{' && ch <= '~');
}
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isAlphaNum(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || isDigit(ch);
}
function isWhite(ch) { return ch === ' ' || ch === '\t'; }

// Escape text for HTML output. When encode is false, an ampersand that
// starts something looking like an entity (&word; or &#123; or &#x1f;) is
// left alone, exactly as marked leaves it; < > " ' are always escaped.
const ESC_RE = /&(?:#[0-9]+;|#[xX][0-9A-Fa-f]+;|[A-Za-z0-9_]+;)|[<>"'&]/g;
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  ESC_RE.lastIndex = 0;
  return s.replace(ESC_RE, (m) => {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    if (m === '"') return '&quot;';
    if (m === "'") return '&#39;';
    return m; // a valid-looking entity: left alone.
  });
}

// Escape where every & becomes &amp; (code spans, and the href/title of
// autolinks).
function escFull(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// Decode a numeric character reference starting at s[i] === '&'.
// Returns {len, ch} or null when it is not a valid numeric reference.
function numRef(s, i) {
  if (s[i + 1] !== '#') return null;
  let j = i + 2;
  let cp = 0;
  if (s[j] === 'x' || s[j] === 'X') {
    j++;
    const st = j;
    while (j < s.length && j < st + 6) {
      const c = s[j];
      let d = -1;
      if (c >= '0' && c <= '9') d = c.charCodeAt(0) - 48;
      else if (c >= 'a' && c <= 'f') d = c.charCodeAt(0) - 87;
      else if (c >= 'A' && c <= 'F') d = c.charCodeAt(0) - 55;
      else break;
      cp = cp * 16 + d;
      j++;
    }
    if (j === st || s[j] !== ';') return null;
  } else {
    const st = j;
    while (j < s.length && j < st + 7 && isDigit(s[j])) { cp = cp * 10 + (s[j].charCodeAt(0) - 48); j++; }
    if (j === st || s[j] !== ';') return null;
  }
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return { len: j + 1 - i, ch: '�' };
  return { len: j + 1 - i, ch: String.fromCodePoint(cp) };
}

// A link destination / title as marked cleans it: encodeURI, with %25
// folded back to %, then entity-aware escaping for the attribute.
function cleanHref(href) {
  let h = href;
  try { h = encodeURI(h).replace(/%25/g, '%'); } catch (e) { /* lone surrogate: keep as-is */ }
  return escText(h);
}

// Normalise a link label: unescape backslash-escaped punctuation, collapse
// whitespace runs to one space, trim, lower-case.
// Does the label contain a `[` that is not backslash-escaped?
function hasUnescapedBracket(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '[') return true;
  }
  return false;
}

function normLabel(label) {
  // Labels match after case folding + whitespace collapsing, WITHOUT
  // unescaping backslashes: `[foo\!]` does not match `[foo!]` (cm-545),
  // while `[Foo*bar\]]` matches itself (cm-194). Unicode case folding:
  // ß (U+00DF) and ẞ (U+1E9E) both fold to "ss" (cm-540).
  return label.replace(/ß|ẞ/g, 'ss').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Is the character at position i the start of a word character for the
// purposes of flanking checks? Punctuation = ASCII punctuation or any
// Unicode punctuation/symbol. Letters and numbers (any script, incl.
// Cyrillic) are NOT punctuation.
function isPunctChar(ch) {
  if (!ch) return false;
  if (isSpace(ch)) return false;
  const code = ch.codePointAt(0);
  if (code < 128) return isPunct(ch);
  return !/\p{L}|\p{N}/u.test(ch);
}
function isUnicodePunct(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  if (code < 128) return isPunct(ch);
  // Letters and numbers (incl. astral) are not punctuation; everything
  // else that is not whitespace counts as punctuation here.
  if (ch === ' ' || ch === '\t' || ch === '\n') return false;
  return !/\p{L}|\p{N}/u.test(ch);
}

// ---- inline helpers -------------------------------------------------------

// Skip spaces, tabs and single newlines (but never a blank line: two \n).
// Returns the new index, or -1 if a blank line is hit.
function skipInlineSpace(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\n') {
      if (s[i + 1] === '\n') return -1;
      i++; continue;
    }
    break;
  }
  return i;
}

// Parse a link destination starting at s[i] (after '(' or after the ': '
// of a reference definition, where leading space was already skipped).
// Returns {href, end} or null. Handles <...> and bare destinations.
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { href: out, end: j + 1 };
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i;
  let out = '';
  let depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === '\\') {
      if (j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      // Backslash before a non-punctuation char is a literal backslash.
      out += '\\'; j++; continue;
    }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    if (c < ' ') return null;
    out += c; j++;
  }
  if (j === i) return null;
  return { href: out, end: j };
}

// Parse a link title starting at s[i] (the opening " ' or (). Returns
// {title, end} or null.
// Parse a link title that may span lines. vline(k) returns the k-th
// virtual line {text} or null. Returns {title, endVk, endIdx} or null.
// A title may contain single newlines but not a blank line.
function parseTitleV(vline, vk, ci) {
  const first = vline(vk);
  if (!first) return null;
  const q = first.text[ci];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let a = vk, b = ci + 1;
  let out = '';
  for (;;) {
    const v = vline(a);
    if (!v) return null;
    const s = v.text;
    while (b < s.length) {
      const c = s[b];
      if (c === '\\' && b + 1 < s.length) {
        const d = s[b + 1];
        // Only a backslash before ASCII punctuation is an escape (the
        // backslash is dropped); before any other char it stays literal.
        if (isPunct(d)) { out += d; b += 2; continue; }
      }
      if (c === close) return { title: out, endVk: a, endIdx: b + 1 };
      out += c; b++;
    }
    // End of line: a single newline is part of the title (unless the next
    // line is blank, which ends the definition).
    const nx = vline(a + 1);
    if (!nx || isBlankFrom(nx.text, 0)) return null;
    out += '\n';
    a++; b = 0;
  }
}

function parseTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) {
      const d = s[j + 1];
      // Only a backslash before ASCII punctuation is an escape.
      if (isPunct(d)) { out += d; j += 2; continue; }
    }
    if (c === close) return { title: out, end: j + 1 };
    if (q === "'" || q === '(') {
      if (c === '\n') {
        if (s[j + 1] === '\n') return null;
        out += c; j++; continue;
      }
    }
    out += c; j++;
  }
  return null;
}

// Find the index just past the matching ']' for the '[' at s[start],
// skipping code spans and escaped brackets. Returns -1 if none.
// Does a link label (the raw text between `[` and `]`) contain an
// unclosed code span under marked's LENIENT label scan? A backtick run
// opens a span and the NEXT run (any length) closes it; a run of 2+
// backticks at the very end of the label is consumed by marked's
// `` ``+(?=\]) `` alternative and is not unclosed. An unclosed span
// swallows the `]`, so the link does not form (doc-16/18/20/22/23:
// `[at `` a ` b ``_]` and `[public updates `` a ` b `` in uses]`).
function labelHasUnclosedSpan(label) {
  let i = 0;
  const n = label.length;
  let inSpan = false;
  while (i < n) {
    if (label[i] === '`') {
      let k = i;
      while (k < n && label[k] === '`') k++;
      if (!inSpan) {
        if (k === n && k - i >= 2) return false;
        inSpan = true;
      } else {
        inSpan = false;
      }
      i = k;
    } else if (label[i] === '\\' && i + 1 < n) {
      i += 2;
    } else {
      i++;
    }
  }
  return inSpan;
}

function findLabelEnd(s, start) {
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
  const n = s.length;
  let i = start;
  while (i < n) {
    const c = s[i];
    if (c === '`') {
      let k = i;
      while (k < n && s[k] === '`') k++;
      // First backtick run after the opening (any length). A ']' in
      // between is span content, not a label end.
      let j = k;
      let close = -1;
      while (j < n) {
        if (s[j] === '`') {
          let m = j;
          while (m < n && s[m] === '`') m++;
          close = m;
          break;
        }
        if (s[j] === '\\' && j + 1 < n) { j += 2; continue; }
        j++;
      }
      if (close < 0) {
        // No closing backtick run. Marked's label regex has one more
        // alternative: `` ``+(?=\]) `` — a run of 2+ backticks immediately
        // before `]` is consumed as a unit and the `]` ends the label
        // (doc-16 `[at `` a ` b ``]` forms a link). Otherwise the span is
        // unclosed and swallows the rest, so no `]` ends the label and
        // the link does not form (`[at `` a ` b ``_]` does not).
        if (k - i >= 2 && s[k] === ']') return k + 1;
        return -1;
      }
      i = close; continue;
    }
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === ']') return i + 1;
    i++;
  }
  return -1;
}

// Find the index just past the closing backtick run of length `run`
// starting at or after s[i]. Returns -1 if none.
function findCodeEnd(s, i, run) {
  const n = s.length;
  let k = i;
  while (k < n) {
    if (s[k] === '`') {
      let m = k;
      while (m < n && s[m] === '`') m++;
      if (m - k === run) return m;
      k = m;
    } else k++;
  }
  return -1;
}

// Trim an extended autolink the way marked does: trailing punctuation
// (except a ) that closes an earlier () is dropped, an unmatched ( cuts
// the link off, and a trailing ; / & is dropped.
function trimUrl(u) {
  let end = u.length;
  // A trailing `&...;` (entity-like) is not part of the URL (gfm-627
  // `...&hl;` links only up to `commonmark`).
  const em = /&[#A-Za-z0-9]+;$/.exec(u.slice(0, end));
  if (em) end -= em[0].length;
  // An unmatched '(' truncates the link at the '('.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < end; i++) {
    if (u[i] === '(') depth++;
    else if (u[i] === ')') { if (depth > 0) depth--; }
  }
  if (depth > 0) {
    // Find the first '(' that never closes.
    depth = 0;
    for (let i = 0; i < end; i++) {
      if (u[i] === '(') { if (depth === 0) cut = i; depth++; }
      else if (u[i] === ')') { if (depth > 0) depth--; }
    }
    if (cut >= 0) end = cut;
  }
  const PUNCT = '?!.,:;*_\'"~&(';
  while (end > 0) {
    const c = u[end - 1];
    if (c === ')') {
      // Keep a trailing ')' only when it closes an earlier '(' (depth
      // just before it is > 0). A ')' at depth 0 (no open paren) does
      // not make a LATER trailing ')' unmatched: in
      // `https://a.com)](https://b.com)` the final ')' closes the '('
      // before b.com and is kept, even though the ')' after a.com is
      // unmatched.
      let d = 0;
      for (let i = 0; i < end - 1; i++) {
        if (u[i] === '(') d++;
        else if (u[i] === ')') { if (d > 0) d--; }
      }
      if (d <= 0) { end--; continue; }
      break;
    }
    if (PUNCT.indexOf(c) >= 0) { end--; continue; }
    break;
  }
  return u.slice(0, end);
}

// Try to match a strikethrough starting at s[i] (a run of 1-2 tildes).
// Returns {end, contentStart, contentEnd} or null. The opener and closer
// runs must be the same length; the content must end in a non-space,
// non-tilde character (or an escape pair); the closer must not be
// followed by another tilde.
function matchDel(s, i) {
  const n = s.length;
  let run = 0;
  while (i + run < n && s[i + run] === '~') run++;
  if (run === 0 || run > 2) return null;
  const next = s[i + run];
  if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '~') return null;
  const start = i + run;
  for (let k = start; k < n; k++) {
    if (s[k] !== '~') continue;
    let r = 0;
    while (k + r < n && s[k + r] === '~') r++;
    if (r < run) continue;
    if (k + run < n && s[k + run] === '~') continue;
    // Content must be non-empty and end properly.
    const content = s.slice(start, k);
    if (content.length === 0) continue;
    let b = 0;
    for (let t = content.length - 1; t >= 0 && content[t] === '\\'; t--) b++;
    let ok;
    if (b % 2 === 1) ok = false;
    else if (b > 0) ok = true;
    else {
      const last = content[content.length - 1];
      ok = last !== ' ' && last !== '\t' && last !== '\n' && last !== '~';
    }
    if (!ok) continue;
    return { end: k + run, contentStart: start, contentEnd: k };
  }
  return null;
}

// Try to read an HTML tag / comment / processing instruction /
// declaration / CDATA starting at s[i] === '<'. Returns the index just
// past it, or -1. Attribute values may be quoted (either quote) or
// unquoted; a quoted value may contain '>'.
function scanHtmlTag(s, i) {
  const n = s.length;
  if (s[i] !== '<') return -1;
  let j = i + 1;
  if (s[j] === '!') {
    if (s.startsWith('<!--', j - 1)) {
      // `<!-->` and `<!--->` are complete (abruptly closed) comments.
      if (s.startsWith('<!-->', j - 1)) return j + 4;
      if (s.startsWith('<!--->', j - 1)) return j + 6;
      const e = s.indexOf('-->', j + 3);
      if (e < 0) return n;
      return e + 3;
    }
    if (s.startsWith('<![CDATA[', j - 1)) {
      const e = s.indexOf(']]>', j + 8);
      if (e < 0) return n;
      return e + 3;
    }
    // Declaration: <!A ...> up to the first '>'.
    const e = s.indexOf('>', j);
    if (e < 0) return -1;
    return e + 1;
  }
  if (s[j] === '?') {
    const e = s.indexOf('?>', j + 1);
    if (e < 0) return n;
    return e + 2;
  }
  if (s[j] === '/') j++;
  const isClose = s[i + 1] === '/';
  // Tag name (no `:`: `<m:abc>` is not a tag, cm-609).
  if (j >= n || !((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z'))) return -1;
  j++;
  while (j < n) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { j++; continue; }
    break;
  }
  // A closing tag takes no attributes: only whitespace then `>`
  // (`</a href="foo">` is not a tag, cm-624).
  if (isClose) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '>') return j + 1;
    return -1;
  }
  // Attributes / close. An attribute must be preceded by whitespace
  // (so `<m:abc>` is not a tag: `:` directly after the tag name, cm-609).
  let sawSpace = false;
  while (j < n) {
    const c = s[j];
    if (c === '>') return j + 1;
    if (c === '/' && s[j + 1] === '>') return j + 2;
    if (c === ' ' || c === '\t' || c === '\n') { j++; sawSpace = true; continue; }
    if (!sawSpace) return -1;
    // Attribute name.
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === ':')) return -1;
    sawSpace = false;
    j++;
    while (j < n) {
      const d = s[j];
      if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '_' || d === ':' || d === '.' || d === '-') { j++; continue; }
      break;
    }
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; sawSpace = true; }
    if (s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        const st = j;
        while (j < n) {
          const d = s[j];
          if (d === ' ' || d === '\t' || d === '\n' || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
          j++;
        }
        if (j === st) return -1;
      }
    }
  }
  return -1;
}

// ---- block parsing --------------------------------------------------------
// Split normalized source into lines (without \n). endsNL tells whether the
// source ended with a line ending (so the last line had a trailing \n).
function splitSrc(src) {
  src = src.replace(/\r\n?/g, '\n');
  if (src === '') return { lines: [], endsNL: false };
  const lines = src.split('\n');
  let endsNL = false;
  if (lines[lines.length - 1] === '') { lines.pop(); endsNL = true; }
  return { lines, endsNL, n: lines.length };
}

// Columns of leading whitespace from index i in line s (tabs to 4-col stops).
function indentOf(s, i, col) {
  let c = col;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { c++; i++; }
    else if (ch === '\t') { c += 4 - (c % 4); i++; }
    else break;
  }
  return { col: c, idx: i };
}

// Advance n columns from (i, col) in line s. Returns {idx, col, pad}: pad is
// the number of spaces a partially-consumed tab contributes as content.
function advanceN(s, i, col, n) {
  let pad = 0;
  while (n > 0 && i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (w <= n) { i++; col += w; n -= w; }
      else { pad = w - n; col += n; n = 0; i++; }
    } else break;
  }
  return { idx: i, col, pad };
}

// Is line s blank from index i (only spaces/tabs)?
function isBlankFrom(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
    i++;
  }
  return true;
}

// Content of line s starting at absolute column `target`. s[0] sits at
// absolute column `startCol`. A partially-consumed tab at the boundary
// expands to spaces.
// Content of string s from absolute column targetCol (s starts at
// startCol). Spaces advance one column; a tab advances to the next
// multiple of 4. When `wholeTab` is set, a tab that would overshoot the
// target is consumed ENTIRELY (no remainder spaces) — marked's fenced
// code dedent removes up to N leading whitespace CHARACTERS, so a tab
// counts as one unit (doc-13: a `\tindented` line in a ``` fence
// indented 2 loses the whole tab, not 2 of its 4 columns; `\t\t` in a
// fence indented 2 loses both tabs). Without it, the tab's overshoot
// becomes remainder spaces (indented code blocks).
function contentFromCol(s, startCol, targetCol, wholeTab) {
  let col = startCol, i = 0;
  if (wholeTab) {
    // Character-count dedent: remove up to (targetCol - startCol)
    // leading whitespace characters (space or tab = 1 each).
    let n = targetCol - startCol;
    while (i < s.length && n > 0 && (s[i] === ' ' || s[i] === '\t')) { i++; n--; }
    return s.slice(i);
  }
  while (i < s.length && col < targetCol) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= targetCol) { col += w; i++; }
      else return ' '.repeat(col + w - targetCol) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Advance to absolute column `target` from (pos, col, pad) in line s.
// Consumes pad spaces first, then line characters. A tab that would
// overshoot the target is partially consumed (its remainder becomes pad).
// Returns {pos, col, pad}.
function advanceTo(s, pos, col, pad, target) {
  while (pad > 0 && col < target) { pad--; col++; }
  while (col < target && pos < s.length) {
    const ch = s[pos];
    if (ch === ' ') { pos++; col++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= target) { pos++; col += w; }
      else { pad = col + w - target; col = target; pos++; }
    } else break;
  }
  return { pos, col, pad };
}

// Absolute column (and line index) of the first non-whitespace character
// from (pos, col, pad) in line s. Pad spaces count as columns.
function indentFrom(s, pos, col, pad) {
  let c = col + pad;
  let j = pos;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ') { c++; j++; }
    else if (ch === '\t') { c += 4 - (c % 4); j++; }
    else break;
  }
  return { col: c, idx: j };
}

// Try to parse a link reference definition starting at (line i, index pos).
// Returns {endLine, label, href, title} or null. The definition may span
// lines (dest/title on following lines) but never a blank line.
function tryDef(P, i, pos) {
  const lines = P.lines;
  const line = lines[i];
  if (line[pos] !== '[') return null;
  const labelEnd = findLabelEnd(line, pos);
  if (labelEnd < 0) return null;
  const rawLabel = line.slice(pos + 1, labelEnd - 1);
  if (rawLabel.length === 0 || rawLabel.length > 999) return null;
  if (line[labelEnd] !== ':') return null;
  // Skip spaces/tabs/newlines (not blank lines) after the colon.
  let li = i, ci = labelEnd + 1;
  let ok = skipDefSpace(P, li, ci);
  if (!ok) return null;
  li = ok.li; ci = ok.ci;
  if (li >= P.n) return null;
  const dline = lines[li];
  const dest = parseDest(dline, ci);
  if (!dest) return null;
  let href = dest.href;
  let endLine = li, endIdx = dest.end;
  // Optional title: skip spaces/tabs/newlines, then a quoted title.
  const sp = skipDefSpace(P, li, dest.end);
  let title = null;
  if (sp) {
    const tline = lines[sp.li];
    const q = tline[sp.ci];
    if (q === '"' || q === "'" || q === '(') {
      const t = parseTitle(tline, sp.ci);
      if (!t) return null;
      title = t.title;
      endLine = sp.li; endIdx = t.end;
    } else {
      // No title: the rest must be blank, on the same line as the dest.
      if (sp.li !== li) return null;
      if (!isBlankFrom(tline, sp.ci)) return null;
    }
  }
  // After the title/destination, only spaces may follow on that line.
  if (!isBlankFrom(lines[endLine], endIdx)) return null;
  // A label cannot contain an UNESCAPED `[` (cm-546 `[ref[]`); an escaped
  // `\[` is a literal bracket and is fine (cm-549 `[ref\[]`).
  if (hasUnescapedBracket(rawLabel)) return null;
  const label = normLabel(rawLabel);
  if (label.length === 0) return null;
  return { endLine, label, href, title };
}

// Link reference definition at block start, working on the
// container-stripped `content` of line i (not the raw line). Subsequent
// lines are read through contentAt with the live stack. Returns
// {endLine, label, href, title} or null. Same rules as tryDef.
function tryDef2(P, i, content, stack) {
  const ind = indentOf(content, 0, 0);
  if (ind.col > 3) return null;
  const j = ind.idx;
  if (content[j] !== '[') return null;
  // Virtual lines: index 0 is `content`; later lines come from contentAt.
  const vlines = [{ text: content, li: i }];
  function vline(k) {
    while (vlines.length <= k) {
      const li = i + vlines.length;
      if (li >= P.n) return null;
      const c = contentAt(P, li, stack);
      if (!c) return null;
      vlines.push({ text: c.content, li });
    }
    return vlines[k];
  }
  // The label may span lines: find its end across the virtual lines.
  const lab = findLabelEndV(vline, 0, j);
  if (!lab) return null;
  const rawLabel = lab.raw;
  if (rawLabel.length === 0 || rawLabel.length > 999) return null;
  const labEndLine = vline(lab.endVk).text;
  if (labEndLine[lab.endIdx] !== ':') return null;
  const labelEnd = lab.endIdx;
  const labelEndVk = lab.endVk;
  // Advance (vk, ci) over spaces, tabs and single newlines (never a blank
  // line). Returns {vk, ci} or null.
  function skipSpace(vk0, ci0) {
    let a = vk0, b = ci0;
    for (;;) {
      const v = vline(a);
      if (!v) return null;
      const s = v.text;
      while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b++;
      if (b < s.length) return { vk: a, ci: b };
      const nx = vline(a + 1);
      if (!nx || isBlankFrom(nx.text, 0)) return null;
      a++; b = 0;
    }
  }
  const ok = skipSpace(labelEndVk, labelEnd + 1);
  if (!ok) return null;
  const dline = vline(ok.vk).text;
  const dest = parseDest(dline, ok.ci);
  if (!dest) return null;
  const href = dest.href;
  let endVk = ok.vk, endIdx = dest.end;
  const sp = skipSpace(ok.vk, dest.end);
  let title = null;
  if (sp) {
    const tline = vline(sp.vk).text;
    const q = tline[sp.ci];
    if (q === '"' || q === "'" || q === '(') {
      // A title must be separated from the destination by whitespace
      // (a space, tab, or newline). <bar>(baz) has none, so it is not a
      // title and the definition is invalid.
      const hadSep = sp.vk !== ok.vk || sp.ci > dest.end;
      if (!hadSep) return null;
      const t = parseTitleV(vline, sp.vk, sp.ci);
      if (!t) {
        // A malformed title on a LATER line does not kill the definition:
        // it ends at the destination and the title line is a separate
        // block. (On the same line, a bad title kills it.)
        if (sp.vk === ok.vk) return null;
      } else if (!isBlankFrom(vline(t.endVk).text, t.endIdx)) {
        // Junk after the title: same fallback, unless the title is on the
        // destination's own line.
        if (t.endVk === ok.vk) return null;
      } else {
        title = t.title;
        endVk = t.endVk; endIdx = t.endIdx;
      }
    } else if (sp.vk === ok.vk) {
      // Junk after the destination on the same line -> invalid definition.
      if (!isBlankFrom(tline, sp.ci)) return null;
    }
    // Otherwise the next line does not start with a quote: there is no
    // title, and the definition ends at the destination (the next line is
    // a separate block, e.g. another definition).
  }
  if (!isBlankFrom(vline(endVk).text, endIdx)) return null;
  // A label cannot contain an UNESCAPED `[` (cm-546); `\[` is fine (cm-549).
  if (hasUnescapedBracket(rawLabel)) return null;
  const label = normLabel(rawLabel);
  if (label.length === 0) return null;
  return { endLine: vline(endVk).li, label, href, title };
}

// Advance (li, ci) over spaces, tabs and single newlines (never a blank
// line, never past the end). Returns {li, ci} or null.
function skipDefSpace(P, li, ci) {
  const lines = P.lines;
  while (li < P.n) {
    const s = lines[li];
    while (ci < s.length) {
      const c = s[ci];
      if (c === ' ' || c === '\t') { ci++; continue; }
      break;
    }
    if (ci < s.length) return { li, ci };
    // End of line: move to the next line if it is not blank.
    if (li + 1 >= P.n) return null;
    if (isBlankFrom(lines[li + 1], 0)) return null;
    li++; ci = 0;
  }
  return null;
}

// Is the line at P.lines[i] (from column col) a setext underline?
// Returns 1 (=), 2 (-) or 0.
function setextLevel(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return 0;
  let j = ind.idx;
  const c = line[j];
  if (c !== '=' && c !== '-') return 0;
  let k = j;
  while (k < line.length && line[k] === c) k++;
  // Only spaces/tabs may follow.
  if (!isBlankFrom(line, k)) return 0;
  return c === '=' ? 1 : 2;
}

// Is the line at P.lines[i] (from column col) a thematic break?
function isThematicBreak(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return false;
  let j = ind.idx;
  const c = line[j];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  while (j < line.length) {
    const ch = line[j];
    if (ch === c) { count++; j++; }
    else if (ch === ' ' || ch === '\t') j++;
    else return false;
  }
  return count >= 3;
}

// ATX heading at (line, pos, col): returns {level, text} or null.
function atxHeading(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return null;
  let j = ind.idx;
  let level = 0;
  while (j < line.length && line[j] === '#' && level < 7) { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  // Skip the spaces after the opening #'s: the content starts there.
  let start = j;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
  // Closing sequence of #'s preceded by a space, preceded only by spaces.
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let k = end;
  while (k > start && line[k - 1] === '#') k--;
  // A closing sequence is trailing #'s preceded by a space/tab, or the
  // whole content being #'s (k backed up to start).
  if (k < end && (k === start || line[k - 1] === ' ' || line[k - 1] === '\t')) end = k;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return { level, text: line.slice(start, end) };
}

// Fenced code start at (line, pos, col): returns {ch, len, info} or null.
function fenceStart(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return null;
  let j = ind.idx;
  const c = line[j];
  if (c !== '`' && c !== '~') return null;
  let len = 0;
  while (j + len < line.length && line[j + len] === c) len++;
  if (len < 3) return null;
  const info = line.slice(j + len).trim();
  if (c === '`' && info.indexOf('`') >= 0) return null;
  return { ch: c, len, info, start: j + len };
}

// Is (line, pos, col) a closing fence for ch/len? Only spaces may follow.
function isFenceClose(line, pos, col, ch, len) {
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return false;
  let j = ind.idx;
  let n = 0;
  while (j + n < line.length && line[j + n] === ch) n++;
  if (n < len) return false;
  return isBlankFrom(line, j + n);
}

// HTML block start at (line, pos, col). Returns {type, endLine} where the
// block consumes lines i..endLine, or null. `inPara` forbids type 7.
function htmlBlockStart(P, i, pos, col, inPara) {
  const line = P.lines[i];
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return null;
  let j = ind.idx;
  if (line[j] !== '<') return null;
  const rest = line.slice(j);
  // Type 1: script, pre, style, textarea (case-insensitive). Ends at the
  // first line containing the matching closing tag (blank lines do not end
  // it), or at the end of the document.
  // Type 1 starts only with the OPENING tag <pre>/<script>/<style>/
  // <textarea>; a closing tag alone (</pre>) is paragraph text (cm-148).
  const m1 = /^<(script|pre|style|textarea)(?=[\s>\/]|$)/i.exec(rest);
  if (m1) {
    const tag = m1[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
    for (let k = i; k < P.n; k++) {
      if (closeRe.test(P.lines[k])) return { type: 1, endLine: k };
    }
    return { type: 1, endLine: P.n - 1 };
  }
  // Type 2: comment.
  if (rest.startsWith('<!--')) {
    for (let k = i; k < P.n; k++) {
      if (P.lines[k].indexOf('-->') >= 0) return { type: 2, endLine: k };
    }
    return { type: 2, endLine: P.n - 1 };
  }
  // Type 3: processing instruction.
  if (rest.startsWith('<?')) {
    for (let k = i; k < P.n; k++) {
      if (P.lines[k].indexOf('?>') >= 0) return { type: 3, endLine: k };
    }
    return { type: 3, endLine: P.n - 1 };
  }
  // Type 4: declaration <!A...>.
  if (rest.startsWith('<!') && rest.length > 2 && /[A-Za-z]/.test(rest[2])) {
    for (let k = i; k < P.n; k++) {
      if (P.lines[k].indexOf('>') >= 0) return { type: 4, endLine: k };
    }
    return { type: 4, endLine: P.n - 1 };
  }
  // Type 5: CDATA.
  if (rest.startsWith('<![CDATA[')) {
    for (let k = i; k < P.n; k++) {
      if (P.lines[k].indexOf(']]>') >= 0) return { type: 5, endLine: k };
    }
    return { type: 5, endLine: P.n - 1 };
  }
  // Type 6: the line begins with < or </ followed by a block tag name,
  // followed by whitespace, end of line, > or />. The tag need NOT close
  // on this line (attributes may continue on later lines); the block ends
  // at the first blank line. Type 7: a complete non-block tag.
  const mTag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (mTag) {
    const name = mTag[1].toLowerCase();
    const after = rest[mTag[0].length];
    const afterOk = after === undefined || after === ' ' || after === '\t' ||
      after === '>' || (after === '/' && rest[mTag[0].length + 1] === '>');
    if (afterOk) {
      let k = i;
      while (k + 1 < P.n && !isBlankFrom(P.lines[k + 1], 0)) k++;
      if (BLOCK_TAG_SET.has(name)) return { type: 6, endLine: k };
      if (!inPara && scanHtmlTag(line, j) > 0) return { type: 7, endLine: k };
    }
  }
  return null;
}

// Split a table row line into cells (unescaped |, not inside code spans).
// Returns null if the line has no cell separator context (caller decides).
function splitTableRow(s) {
  const cells = [];
  const n = s.length;
  // Fast path: no `\|` escapes — a plain split on `|`.
  if (s.indexOf('\\|') < 0) {
    const parts = s.split('|');
    // A leading pipe (first part only whitespace) is not a cell; a
    // trailing pipe (last part only whitespace) is not a cell.
    let startIdx = 0;
    if (parts[0].trim() === '') startIdx = 1;
    let endIdx = parts.length;
    if (parts.length > 0 && parts[parts.length - 1].trim() === '') endIdx = parts.length - 1;
    if (startIdx >= endIdx) {
      // The whole row is whitespace (or just pipes): one empty cell.
      return parts.length === 1 ? [''] : [];
    }
    for (let p = startIdx; p < endIdx; p++) cells.push(parts[p].trim());
    return cells;
  }
  // Slow path: a `|` is a cell separator unless preceded by an ODD
  // number of backslashes (then it is content, and the table layer
  // consumes one backslash: `\|` -> `|`). Code spans do NOT protect a
  // pipe in marked — `` `x | y` `` splits into two cells.
  const spans = [];
  let cellStart = 0;
  let i = 0;
  while (i < n) {
    if (s[i] === '|') {
      let bs = 0;
      let q = i - 1;
      while (q >= 0 && s[q] === '\\') { bs++; q--; }
      if (bs % 2 === 0) {
        spans.push([cellStart, i]);
        cellStart = i + 1;
      }
    }
    i++;
  }
  spans.push([cellStart, n]);
  // Drop a leading empty cell from a leading pipe and a trailing empty
  // cell from a trailing pipe.
  let lo = 0, hi = spans.length;
  if (hi > 0 && s.slice(spans[0][0], spans[0][1]).trim() === '') lo = 1;
  if (hi > lo && s.slice(spans[hi - 1][0], spans[hi - 1][1]).trim() === '') hi--;
  if (lo >= hi) return spans.length === 1 ? [''] : [];
  for (let p = lo; p < hi; p++) {
    const raw = s.slice(spans[p][0], spans[p][1]);
    cells.push(raw.trim().replace(/\\\|/g, '|'));
  }
  return cells;
}

// In a table-cell fragment, \| becomes |; \\ stays \\ (so a following |
// is not treated as escaped).
function unescapePipe(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '|') { out += '|'; i++; continue; }
      if (s[i + 1] === '\\') { out += '\\\\'; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

// Find the end of a [...] label that may span lines. vline(k) returns the
// k-th virtual line {text} or null. Starts at (vk, ci) which must be '['.
// Returns {endVk, endIdx} (just past the closing ]) and the raw label text
// (with newlines kept), or null.
function findLabelEndV(vline, vk, ci) {
  // A label ends at the FIRST unescaped `]` (no nesting; cm-547/548).
  let a = vk, b = ci + 1;
  let raw = '';
  for (;;) {
    const v = vline(a);
    if (!v) return null;
    const s = v.text;
    while (b < s.length) {
      const c = s[b];
      if (c === '`') {
        let k = b;
        while (k < s.length && s[k] === '`') k++;
        const run = k - b;
        const close = findCodeEnd(s, k, run);
        if (close < 0) { raw += s.slice(b, k); b = k; continue; }
        raw += s.slice(b, close); b = close; continue;
      }
      if (c === '\\' && b + 1 < s.length) { raw += s.slice(b, b + 2); b += 2; continue; }
      if (c === ']') return { endVk: a, endIdx: b + 1, raw };
      raw += c; b++;
    }
    const nx = vline(a + 1);
    if (!nx || isBlankFrom(nx.text, 0)) return null;
    raw += '\n';
    a++; b = 0;
  }
}

// Is the line a table delimiter row? Returns the alignments array or null.
function tableDelimiter(s) {
  const cells = splitTableRow(s);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// List marker at (line, pos, col): returns {ordered, start, delim, markerLen}
// or null. markerLen is the width of the marker in columns.
function listMarker(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.col - col > 3) return null;
  let j = ind.idx;
  const c = line[j];
  if (c === '-' || c === '+' || c === '*') {
    if (line[j + 1] !== ' ' && line[j + 1] !== '\t' && j + 1 < line.length) return null;
    if (j + 1 >= line.length) return { ordered: false, start: 0, delim: c, markerLen: 1 };
    return { ordered: false, start: 0, delim: c, markerLen: 1 };
  }
  if (isDigit(c)) {
    let k = j, num = 0, digits = 0;
    while (k < line.length && isDigit(line[k]) && digits < 10) { num = num * 10 + (line[k].charCodeAt(0) - 48); digits++; k++; }
    if (digits === 0 || digits > 9) return null;
    const d = line[k];
    if (d !== '.' && d !== ')') return null;
    if (k + 1 < line.length && line[k + 1] !== ' ' && line[k + 1] !== '\t') return null;
    return { ordered: true, start: num, delim: d, markerLen: k - j + 1 };
  }
  return null;
}

export function parse(markdown) {
  const refs = new Map();
  // marked's inLink persists across paragraphs within one parse: an
  // unclosed raw `<a>` suppresses bare autolinks/emails later in the
  // document (doc-03 `<a href="foo\\\nbar">` kills a later email link).
  inLink = false;
  return renderBlocks(parseBlocks(markdown, refs), refs);
}

// Match a blockquote marker at (line, pos, col, pad). Returns
// {pos, col, pad} after the '>' and one optional space/tab, or null. Only
// one column of a following tab is consumed; the remainder becomes pad.
function matchQuoteMarker(line, pos, col, pad) {
  let j = pos, c = col, p = pad, sp = 0;
  // Up to 3 spaces before '>' (pad spaces count first).
  while (p > 0 && sp < 3) { p--; c++; sp++; }
  while (j < line.length && sp < 3) {
    const ch = line[j];
    if (ch === ' ') { j++; c++; sp++; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      if (sp + w > 3) break;
      j++; c += w; sp += w;
    } else break;
  }
  if (line[j] !== '>') return null;
  j++; c++;
  if (line[j] === ' ') { j++; c++; }
  else if (line[j] === '\t') {
    // A tab directly after '>' expands by the marker's OWN width
    // (leading spaces before '>' plus the '>'), not the absolute
    // column — the marker resets the column for the tab (doc-30:
    // a '>' inside a list item followed by a tab expands to 2
    // spaces of content indent, not 0). The tab's first column is
    // the marker's trailing space, so the pad is w - 1.
    const w = 4 - ((c - col) % 4);
    j++;
    if (w > 1) { p = w - 1; c += 1; }
    else c += w;
  }
  return { pos: j, col: c, pad: p };
}

// Content of line li after the current containers are matched. Pure: does
// not modify the stack. Returns {content, col} or null when the line does
// not continue the containers (or is a lazy continuation line).
function contentAt(P, li, stack) {
  const line = P.lines[li];
  let pos = 0, col = 0, pad = 0;
  let stripped = false;
  // Column advance of the innermost (last) container stripped, and
  // whether it was a blockquote: a boundary tab expands using only
  // the innermost blockquote marker's own width ('> ' = 2, plus any
  // leading spaces before that '>'), while for a list item the
  // absolute column counts. E.g. '> > \t' and '  > \t' (item+quote)
  // both expand to 2 spaces; '> - \t' (item innermost) uses the
  // absolute column.
  let lastDelta = 0, lastWasQuote = false;
  for (let s = 1; s < stack.length; s++) {
    const b = stack[s];
    if (b.t === 'para') break;
    if (isBlankFrom(line, pos)) break;
    if (b.t === 'quote') {
      const m = matchQuoteMarker(line, pos, col, pad);
      if (!m) return null;
      lastDelta = m.col - col;
      lastWasQuote = true;
      pos = m.pos; col = m.col; pad = m.pad;
      stripped = true;
    } else if (b.t === 'item') {
      // _contentIndent is relative to the column after the containers
      // before this item (blockquote columns shift per line).
      const want = col + b._contentIndent;
      const ind = indentFrom(line, pos, col, pad);
      if (ind.col < want) return null;
      const adv = advanceTo(line, pos, col, pad, want);
      lastDelta = adv.col - col;
      lastWasQuote = false;
      pos = adv.pos; col = adv.col; pad = adv.pad;
      stripped = true;
    }
  }
  // A tab that starts exactly at the strip boundary, after containers
  // were stripped, expands to spaces (its width at that column): e.g. a
  // tab at column 13 becomes 3 spaces. A tab with no container stripped
  // (top level) stays a tab. For a blockquote innermost, only the
  // innermost '>' marker's width counts toward the expansion column.
  if (stripped && line[pos] === '\t') {
    const effCol = lastWasQuote ? lastDelta : col;
    const w = 4 - (effCol % 4);
    return { content: (pad > 0 ? ' '.repeat(pad) : '') + ' '.repeat(w) + line.slice(pos + 1), col: col + w };
  }
  // A blank line keeps its whitespace content (code blocks need the spaces:
  // a 6-space line in indented code is 2 spaces of content, a 2-space line
  // in fenced code is 2 spaces).
  if (isBlankFrom(line, pos)) {
    return { content: (pad > 0 ? ' '.repeat(pad) : '') + line.slice(pos), col };
  }
  return { content: (pad > 0 ? ' '.repeat(pad) : '') + line.slice(pos), col };
}

// Does the content start a block that can interrupt an open paragraph?
// Used to decide lazy continuation: such a line is a new block, not a
// continuation of the paragraph.
function startsInterruptingBlock(P, i, content, ccol, stack) {
  if (atxHeading(content, 0, ccol)) return true;
  if (fenceStart(content, 0, ccol)) return true;
  if (htmlBlockAt(P, i, content, ccol, true, stack)) return true;
  if (isThematicBreak(content, 0, ccol)) return true;
  const marker = listMarker(content, 0, ccol);
  if (marker) {
    const mi = indentOf(content, 0, ccol);
    let e = mi.idx + marker.markerLen;
    while (e < content.length && (content[e] === ' ' || content[e] === '\t')) e++;
    const empty = e >= content.length;
    // Inside a list, even an empty marker starts a new item (it does not
    // become paragraph text). Outside a list, only a non-empty item that
    // can interrupt does.
    const inList = stack.some(b => b.t === 'item');
    if (inList) return true;
    if (!empty && canInterruptPara(marker, false)) return true;
  }
  if (matchQuoteMarker(content, 0, ccol, 0)) return true;
  return false;
}

function parseBlocks(src, refs) {
  const P = splitSrc(src);
  P.refs = refs;
  const root = { t: 'doc', children: [] };
  const stack = [root];
  const n = P.lines.length;
  let i = 0;
  let lastBlank = true;
  // Depth-scoped blank: the stack depth (stack.length) at which the most
  // recent blank line occurred. A blank inside a nested container (e.g.
  // a `>`-only line inside a blockquote within a list item, cm-320)
  // must not loosen the enclosing list — only a blank at or above the
  // item's own depth counts. -1 when no blank is pending.
  let lastBlankDepth = -1;

  function container() {
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].t !== 'para') return stack[s];
    }
    return root;
  }
  function closePara() {
    if (stack.length > 0 && stack[stack.length - 1].t === 'para') {
      const p = stack.pop();
      p.text = p.lines.join('\n');
      delete p.lines;
    }
  }
  function closeTo(depth) {
    while (stack.length > depth) {
      const b = stack.pop();
      if (b.t === 'para') { b.text = b.lines.join('\n'); delete b.lines; }
    }
  }
  function addChild(node) {
    const parent = container();
    parent.children.push(node);
    // Looseness: a block added to a list item after a blank line, when the
    // item already has a block, makes its list loose — but only if the
    // blank occurred at or above the item's own depth (cm-320: a blank
    // inside a nested blockquote does not loosen the enclosing list).
    if (parent.t === 'item' && parent.children.length > 1 && lastBlank &&
        (lastBlankDepth < 0 || lastBlankDepth <= stack.indexOf(parent) + 1)) {
      parent._list.tight = false;
    }
    return node;
  }

  while (i < n) {
    const line = P.lines[i];
    // Fully blank line: closes a paragraph and any open blockquotes (a
    // bare blank line has no > marker, so the quote ends here; a later >
    // line starts a NEW blockquote). Lists survive blank lines.
    if (isBlankFrom(line, 0)) {
      closePara();
      // A bare blank line closes every open blockquote, and everything
      // nested inside it — including a list inside the quote (doc-29:
      // `> 1. one` / blank / `> three` is two blockquotes, not one).
      // A list OUTSIDE any quote survives (it is below the quote in
      // the stack, or there is no quote at all). So truncate the stack
      // to just below the outermost quote, instead of popping only
      // quotes at the stack top (a list/item between the quote and the
      // top used to block the pop).
      let q = -1;
      for (let s = 1; s < stack.length; s++) if (stack[s].t === 'quote') { q = s; break; }
      if (q >= 0) closeTo(q);
      lastBlank = true;
      // A BARE blank line separates blocks at every ancestor level (it
      // ends nested containers), so it may loosen any enclosing list
      // (cm-325/326). Depth 0 means "loosens any list". A markers-only
      // blank (below) is confined to its container and gets the real
      // (deep) stack depth instead.
      lastBlankDepth = 0;
      i++;
      continue;
    }
    // ---- Phase 1: descend into open containers. ----
    let pos = 0, col = 0, pad = 0;
    let failAt = -1;
    for (let s = 1; s < stack.length; s++) {
      const b = stack[s];
      if (b.t === 'para') break;
      // Blank after the matched markers: a line with NO further content
      // still closes any remaining BLOCKQUOTE (it lacks that quote's
      // marker — `>` ends an inner `> > ` quote, and a later `> > ` line
      // starts a NEW one). Lists survive blank lines, so only quotes
      // force a failure here.
      if (isBlankFrom(line, pos)) {
        for (let t = s; t < stack.length; t++) {
          if (stack[t].t === 'para') break;
          if (stack[t].t === 'quote') { failAt = t; break; }
        }
        break;
      }
      if (b.t === 'quote') {
        const m = matchQuoteMarker(line, pos, col, pad);
        if (!m) { failAt = s; break; }
        pos = m.pos; col = m.col; pad = m.pad;
      } else if (b.t === 'item') {
        // An empty item followed by a blank line is closed: its content
        // cannot continue after the blank (the list ends here).
        if (b.children.length === 0 && lastBlank) { failAt = s; break; }
        const want = col + b._contentIndent;
        const ind = indentFrom(line, pos, col, pad);
        if (ind.col < want) { failAt = s; break; }
        const adv = advanceTo(line, pos, col, pad, want);
        pos = adv.pos; col = adv.col; pad = adv.pad;
      }
    }
    if (failAt >= 0) {
      // A container did not match. If a paragraph is open and the line does
      // NOT start a block that can interrupt a paragraph, it is a lazy
      // continuation line of that paragraph; otherwise close the containers
      // and let phase 2 start the new block. A line that is blank after
      // the matched markers (e.g. `>` with no inner `> > `) is NOT a
      // lazy continuation — it closes the unmatched container.
      const lazyContent0 = (pad > 0 ? ' '.repeat(pad) : '') + line.slice(pos);
      if (stack.length > 0 && stack[stack.length - 1].t === 'para' &&
          lazyContent0.trim() !== '' &&
          !startsInterruptingBlock(P, i, lazyContent0, col, stack)) {
        // A lazy continuation line indented 4+ columns loses 4 columns of
        // leading whitespace (the indented-code indent); a less-indented
        // line keeps its whitespace verbatim. A tab straddling the 4-col
        // boundary leaves the leftover as spaces.
        let lazyContent = lazyContent0;
        let cc = col;
        let k = 0;
        let leftover = 0;
        while (k < lazyContent.length && (lazyContent[k] === ' ' || lazyContent[k] === '\t')) {
          const w = lazyContent[k] === '\t' ? 4 - (cc % 4) : 1;
          if (cc + w > col + 4) { leftover = cc + w - (col + 4); k++; break; }
          cc += w; k++;
          if (cc - col >= 4) break;
        }
        if (cc - col >= 4 || leftover > 0) {
          lazyContent = ' '.repeat(leftover) + lazyContent.slice(k);
        }
        const p = stack[stack.length - 1];
        // A lazy `=`-only line (setext underline shape) after a lazy line
        // is paragraph text with exactly 4 spaces prepended (cm-093);
        // a setext underline cannot be a lazy continuation line, and
        // marked pads it to 4 spaces. Only when the previous paragraph
        // line was itself lazy; a `>`-marked previous line gets none.
        if (p.lastLazy) {
          const t = lazyContent.trim();
          if (/^=+$/.test(t)) lazyContent = '    ' + t;
        }
        p.lines.push(lazyContent);
        p.lastLazy = true;
        lastBlank = false;
        i++;
        continue;
      }
      closeTo(failAt);
      // Phase 2 continues at the position after the matched containers.
      // (pos, col, pad) are still the pre-failure values, as desired.
    }
    // Blank after container markers: a markers-only line (empty content,
    // e.g. `>>`) is a blank line that ends the paragraph. A line with
    // whitespace content after the markers (e.g. `>  `) continues an open
    // paragraph as a line of spaces; with no paragraph open it is blank.
    if (isBlankFrom(line, pos)) {
      const ws = (pad > 0 ? ' '.repeat(pad) : '') + line.slice(pos);
      if (ws.length > 0 && stack.length > 0 && stack[stack.length - 1].t === 'para') {
        const p = stack[stack.length - 1];
        p.lines.push(ws);
        p.lastLazy = false;
        lastBlank = false;
        i++;
        continue;
      }
      closePara();
      lastBlank = true;
      lastBlankDepth = stack.length;
      i++;
      continue;
    }
    let content = (pos === 0 && pad === 0) ? line : (' '.repeat(pad) + line.slice(pos));
    let ccol = col;
    // ---- Phase 2: start new blocks (possibly several containers). ----
    while (true) {
      const paraOpen = stack.length > 0 && stack[stack.length - 1].t === 'para';
      // Blank content with no paragraph open (e.g. a bare `>` line) is a
      // blank line: it must NOT start an empty paragraph. (When a
      // paragraph IS open, the line is a continuation and is added below.)
      // An empty list item's content is also blank, but it is NOT a blank
      // line: do not set lastBlank for it (it would wrongly loosen the
      // list when the next item is added).
      if (isBlankFrom(content, 0) && !paraOpen) {
        const top = stack[stack.length - 1];
        if (!(top && top.t === 'item' && top.children.length === 0)) {
          closePara();
          lastBlank = true;
          lastBlankDepth = stack.length;
        }
        i++;
        break;
      }
      const inPara = paraOpen;
      if (paraOpen) {
        // Setext underline turns the paragraph into a heading.
        const sl = setextLevel(content, 0, ccol);
        if (sl > 0) {
          const p = stack.pop();
          const parent = container();
          // Setext heading content: leading whitespace off the first line,
          // trailing whitespace off the last line.
          const lines = p.lines;
          lines[0] = lines[0].replace(/^[ \t]+/, '');
          lines[lines.length - 1] = lines[lines.length - 1].replace(/[ \t]+$/, '');
          const h = { t: 'heading', level: sl, text: lines.join('\n') };
          parent.children[parent.children.length - 1] = h;
          lastBlank = false;
          i++;
          break;
        }
        // A table header + delimiter row interrupts the paragraph. The
        // delimiter row may be indented at most 3 spaces.
        if (i + 1 < n) {
          const nx = contentAt(P, i + 1, stack);
          if (nx) {
            const hdr = splitTableRow(content);
            const del = tableDelimiter(nx.content);
            const dind = indentOf(nx.content, 0, nx.col);
            if (del && del.length === hdr.length && dind.col - nx.col <= 3 &&
                setextLevel(nx.content, 0, nx.col) === 0) {
              closePara();
              i = parseTable(P, i, stack, hdr, del, content, ccol, lastBlank, lastBlankDepth);
              lastBlank = false;
              break;
            }
          }
        }
      }
      // Blocks that can interrupt a paragraph (or start one).
      const atx = atxHeading(content, 0, ccol);
      if (atx) {
        closePara();
        addChild({ t: 'heading', level: atx.level, text: atx.text });
        lastBlank = false;
        i++;
        break;
      }
      const fence = fenceStart(content, 0, ccol);
      if (fence) {
        closePara();
        i = parseFenced(P, i, stack, fence, content, ccol, lastBlank, lastBlankDepth);
        lastBlank = false;
        break;
      }
      const hb = htmlBlockAt(P, i, content, ccol, inPara, stack);
      if (hb) {
        closePara();
        i = parseHtmlBlock(P, i, stack, hb, content, ccol, lastBlank, lastBlankDepth);
        lastBlank = false;
        break;
      }
      if (isThematicBreak(content, 0, ccol)) {
        closePara();
        addChild({ t: 'hr' });
        lastBlank = false;
        i++;
        break;
      }
      const marker = listMarker(content, 0, ccol);
      if (marker) {
        // Empty item: nothing but spaces/tabs after the marker.
        const mi = indentOf(content, 0, ccol);
        let e = mi.idx + marker.markerLen;
        while (e < content.length && (content[e] === ' ' || content[e] === '\t')) e++;
        const empty = e >= content.length;
        // Inside a list, a marker (even an empty one) starts a new item.
        // Outside, only a non-empty item that can interrupt does.
        const inList = stack.some(b => b.t === 'item');
        if (!paraOpen || inList || canInterruptPara(marker, empty)) {
          closePara();
          const res = startListItem(P, i, stack, marker, content, ccol, lastBlank, lastBlankDepth);
          if (res) {
            content = res.content; ccol = res.col; i = res.line;
            lastBlank = false;
            continue; // re-run phase 2 on the item's content
          }
        }
        // A list marker that cannot interrupt is paragraph text.
        if (paraOpen) {
          stack[stack.length - 1].lines.push(content);
          stack[stack.length - 1].lastLazy = false;
          lastBlank = false;
          i++;
          break;
        }
      }
      // Blockquote.
      const qm = matchQuoteMarker(content, 0, ccol, 0);
      if (qm) {
        closePara();
        const q = { t: 'quote', children: [] };
        addChild(q);
        stack.push(q);
        content = (qm.pad > 0 ? ' '.repeat(qm.pad) : '') + content.slice(qm.pos);
        ccol = qm.col;
        lastBlank = false;
        continue; // re-run phase 2 inside the quote
      }
      if (!paraOpen) {
        // Link reference definition (only at a paragraph start). A
        // definition is a block: inside a list item that already holds a
        // block, it loosens the list (cm-317).
        const def = tryDef2(P, i, content, stack);
        if (def) {
          if (!refs.has(def.label)) refs.set(def.label, { href: def.href, title: def.title });
          markLoose(container(), lastBlank, lastBlankDepth, stack);
          i = def.endLine + 1;
          lastBlank = false;
          break;
        }
        // Indented code (4+ spaces, no paragraph open).
        const ind = indentOf(content, 0, ccol);
        if (ind.col - ccol >= 4) {
          i = parseIndentedCode(P, i, stack, content, ccol, lastBlank, lastBlankDepth);
          lastBlank = false;
          break;
        }
        // Table at a block start (delimiter row indented at most 3).
        if (i + 1 < n) {
          const nx = contentAt(P, i + 1, stack);
          if (nx) {
            const hdr = splitTableRow(content);
            const del = tableDelimiter(nx.content);
            const dind = indentOf(nx.content, 0, nx.col);
            if (del && del.length === hdr.length && dind.col - nx.col <= 3 &&
                setextLevel(nx.content, 0, nx.col) === 0) {
              i = parseTable(P, i, stack, hdr, del, content, ccol, lastBlank, lastBlankDepth);
              lastBlank = false;
              break;
            }
          }
        }
        // Start a paragraph.
        const p = { t: 'para', lines: [content], lastLazy: false };
        addChild(p);
        stack.push(p);
        lastBlank = false;
        i++;
        break;
      }
      // Paragraph continuation.
      stack[stack.length - 1].lines.push(content);
      stack[stack.length - 1].lastLazy = false;
      lastBlank = false;
      i++;
      break;
    }
  }
  closeTo(1);
  return root;
}

// The innermost non-paragraph block in the stack: the container a new
// block is added to.
function blockParent(stack) {
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].t !== 'para') return stack[s];
  }
  return stack[0];
}

// Mark the parent list loose when a block is added to a list item that
// already holds a block after a blank line.
function markLoose(parent, lastBlank, lastBlankDepth, stack) {
  // Depth-scoped: a blank inside a nested container (deeper than the
  // item) does not loosen the list (cm-320). When no depth/stack is
  // supplied, fall back to the old behaviour.
  if (parent.t === 'item' && parent.children.length > 0 && lastBlank) {
    if (lastBlankDepth === undefined || !stack ||
        lastBlankDepth < 0 || lastBlankDepth <= stack.indexOf(parent) + 1) {
      parent._list.tight = false;
    }
  }
}

// Remove backslash escapes before ASCII punctuation (fence info string).
function unescapeInfo(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Render a parsed block tree to marked-compatible HTML.
function renderBlocks(node, refs) {
  const out = [];
  renderNode(node, refs, out);
  return out.join('');
}

function renderNode(node, refs, out, lastTrail) {
  switch (node.t) {
    case 'doc':
      for (let c = 0; c < node.children.length; c++)
        renderNode(node.children[c], refs, out, lastTrail && c === node.children.length - 1);
      break;
    case 'heading':
      out.push('<h', String(node.level), '>', renderInline(node.text, refs), '</h', String(node.level), '>\n');
      break;
    case 'para': {
      const text = lastTrail ? node.text.replace(/[ \t]+$/, '') : node.text;
      out.push('<p>', renderInline(text, refs), '</p>\n');
      break;
    }
    case 'code':
      out.push('<pre><code');
      if (node.fenced && node.info) {
        const lang = node.info.split(/\s+/)[0];
        if (lang) out.push(' class="language-', escText(unescapeInfo(lang)), '"');
      }
      out.push('>', escFull(node.text), '</code></pre>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (let c = 0; c < node.children.length; c++)
        renderNode(node.children[c], refs, out, lastTrail && c === node.children.length - 1);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      out.push('<', tag);
      if (node.ordered && node.start !== 1) out.push(' start="', String(node.start), '"');
      out.push('>\n');
      for (let i = 0; i < node.items.length; i++)
        renderItem(node.items[i], node, refs, out, i === node.items.length - 1);
      out.push('</', tag, '>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < node.header.length; c++) {
        out.push('<th');
        const a = node.aligns[c];
        if (a) out.push(' align="', a, '"');
        out.push('>', renderInline(node.header[c], refs), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let c = 0; c < node.header.length; c++) {
            out.push('<td');
            const a = node.aligns[c];
            if (a) out.push(' align="', a, '"');
            out.push('>', renderInline(row[c], refs), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
    case 'html': {
      out.push(node.lines.join('\n'));
      if (node.trailingNL) out.push('\n');
      break;
    }
  }
}

// Render one list item. Tight: a lone paragraph renders as bare inline
// content; loose: every paragraph gets <p> wrappers. `lastTrail` is true
// when this item is the last item of its list (and that list is itself
// the last descendant of its parent): trailing spaces are stripped from
// the item's final paragraph, even when it is nested inside a blockquote
// (doc-28) — the flag propagates to the last descendant.
function renderItem(item, list, refs, out, lastTrail) {
  out.push('<li>');
  const kids = item.children;
  const hasTask = item._task !== undefined;
  const box = hasTask
    ? (item._task ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
    : '';
  for (let k = 0; k < kids.length; k++) {
    const child = kids[k];
    const isLastKid = k === kids.length - 1;
    if (child.t === 'para') {
      const text = (lastTrail && isLastKid) ? child.text.replace(/[ \t]+$/, '') : child.text;
      if (list.tight) {
        if (k === 0) out.push(box);
        out.push(renderInline(text, refs));
      } else {
        out.push('<p>');
        if (k === 0) out.push(box);
        out.push(renderInline(text, refs));
        out.push('</p>\n');
      }
    } else {
      renderNode(child, refs, out, lastTrail && isLastKid);
    }
  }
  out.push('</li>\n');
}

// ---------- Inline parsing ----------

// Render inline markdown (a paragraph/heading/cell string) to HTML.
function renderInline(text, refs) {
  if (!text) return '';
  // Fast path: plain prose with no inline markers, no hard break
  // (`  \n` or `\\\n`), and no autolink trigger. The only output is the
  // escaped text (soft breaks stay as literal newlines).
  if (text.indexOf('*') < 0 && text.indexOf('_') < 0 && text.indexOf('[') < 0 &&
      text.indexOf(']') < 0 && text.indexOf('!') < 0 && text.indexOf('`') < 0 &&
      text.indexOf('<') < 0 && text.indexOf('\\') < 0 && text.indexOf('~') < 0 &&
      text.indexOf('://') < 0 && text.indexOf('www.') < 0 && text.indexOf('@') < 0 &&
      text.indexOf('&#') < 0 && text.indexOf('  \n') < 0) {
    return escText(text);
  }
  return renderInlineNodes(parseInlineNodes(text, refs));
}

function renderInlineNodes(nodes) {
  const out = [];
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out.push(escText(node.s)); break;
      case 'code': out.push('<code>', escFull(node.s), '</code>'); break;
      case 'html': out.push(node.s); break;
      case 'br': out.push('<br>'); break;
      case 'soft': out.push('\n'); break;
      case 'em': out.push('<em>', renderInlineNodes(node.children), '</em>'); break;
      case 'strong': out.push('<strong>', renderInlineNodes(node.children), '</strong>'); break;
      case 'del': out.push('<del>', renderInlineNodes(node.children), '</del>'); break;
      case 'link': {
        out.push('<a href="', cleanHref(node.href), '"');
        if (node.title != null) out.push(' title="', escText(node.title), '"');
        out.push('>', renderInlineNodes(node.children), '</a>');
        break;
      }
      case 'image': {
        out.push('<img src="', cleanHref(node.src), '" alt="', escText(node.alt), '"');
        if (node.title != null) out.push(' title="', escText(node.title), '"');
        out.push('>');
        break;
      }
    }
  }
  return out.join('');
}

// Plain-text rendering of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += node.s; break;
      case 'code': out += node.s; break;
      case 'html': out += node.s; break;
      case 'br': case 'soft': out += '\n'; break;
      case 'em': case 'strong': case 'del': case 'link':
        out += plainText(node.children); break;
      case 'image': out += node.alt; break;
    }
  }
  return out;
}

// Is the character a flanking punctuation/space boundary for emphasis?
// Returns [canOpen, canClose] for a delimiter run ending/starting here.
// Unicode whitespace for emphasis flanking: ASCII space/tab/newline/CR
// plus NBSP (U+00A0) and the other Unicode spaces. (A plain space/tab is
// NOT enough: `* a *` with NBSPs must not form emphasis.)
function isUniSpace(ch) {
  if (!ch) return false;
  if (isSpace(ch)) return true;
  const code = ch.codePointAt(0);
  return code === 0x00A0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200A) || code === 0x202F ||
    code === 0x205F || code === 0x3000 || code === 0xFEFF;
}

function flanking(text, before, after) {
  const b = before;
  const a = after;
  const bSpace = b === '' || isUniSpace(b);
  const aSpace = a === '' || isUniSpace(a);
  const bPunct = !bSpace && isPunctChar(b);
  const aPunct = !aSpace && isPunctChar(a);
  const leftFlanking = !aSpace && (!aPunct || bSpace || bPunct);
  const rightFlanking = !bSpace && (!bPunct || aSpace || aPunct);
  return [leftFlanking, rightFlanking];
}

// Parse inline markdown into a node list. Single left-to-right scan with a
// delimiter stack for emphasis and links (CommonMark 0.31.2 algorithm).
const INLINE_SPECIAL_RE = /[\\`*_~[\]<&\n]|!(?=\[)/g;
// Raw `<a>` state, shared across inline runs within one parse() (see parse).
let inLink = false;
function parseInlineNodes(text, refs) {
  const nodes = [];
  const delims = [];
  const n = text.length;
  let i = 0;

  function addText(s) { if (s) nodes.push({ t: 'text', s }); }
  function pushDelim(kind, len, canOpen, canClose, node, src) {
    delims.push({ kind, len, canOpen, canClose, node, active: true, src: src === undefined ? -1 : src });
  }
  // Resolve emphasis for the delimiters currently on the stack, in two
  // passes. Pass 1 pairs only same-length openers/closers (so `**` pairs
  // with `**` for strong and `*` with `*` for em); this keeps the inner
  // `**...**` in `*foo**bar**baz*` from being grabbed by the outer `*`.
  // Pass 2 falls back to any-length pairing for the cases that need it
  // (e.g. `***foo***`, `*foo**`), processing closers right to left so a
  // longer closer (e.g. the `***` in `*foo**bar***`) splits across its
  // openers before a shorter closer grabs one.
  function processEmphasis() {
    processEmphasisPass(true, false);
    processEmphasisPass(false, true);
  }
  function processEmphasisPass(sameLengthOnly, reverse) {
    let d = reverse ? delims.length - 1 : 0;
    const step = reverse ? -1 : 1;
    const done = () => reverse ? d < 0 : d >= delims.length;
    while (!done()) {
      const closer = delims[d];
      if (!closer.active || closer.isBlocker || closer.blockedForever || closer.kind === '[' || closer.kind === '![' ||
          !closer.canClose) { d += step; continue; }
      // Find the nearest opener before d (same length first in pass 1).
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
      let o = -1;
      let hitBlocker = false;
      let blockerIdx = -1;
      let searchFrom = d - 1;
      for (;;) {
        let fallback = -1;
        hitBlocker = false;
        blockerIdx = -1;
        for (let j = searchFrom; j >= 0; j--) {
          const op = delims[j];
          if (!op.active || op.kind !== closer.kind || !op.canOpen) continue;
          // A BLOCKER (an open-capable closer left behind by an inner
          // strong/em) bars the closer from an opener before it when the
          // rule of 3 applies (`*a **b**c*`, doc-03/doc-07). It is
          // single-use (deactivated on encounter). It only permanently
          // blocks when it actually prevents a match: an opener found past
          // it (before it) is barred, but an opener after it — including a
          // pass-1 fallback opener nearer the closer — is not (doc-03
          // `*using *type guide in**`: the `**` closer has no same-length
          // opener in pass 1, so it must retry in pass 2).
          if (op.isBlocker) {
            op.active = false;
            if ((op.len + closer.len) % 3 === 0) { hitBlocker = true; blockerIdx = j; }
            continue;
          }
          if (sameLengthOnly && op.len !== closer.len) {
            if (fallback < 0 && !closer.canOpen && op.len > closer.len) fallback = j;
            continue;
          }
          if (closer.kind === '_' &&
              ((op.canOpen && op.canClose) || (closer.canOpen && closer.canClose)) &&
              (op.len + closer.len) % 3 === 0) continue;
          o = j;
          break;
        }
        if (o < 0 && sameLengthOnly && fallback >= 0) {
          // Do not split a longer opener when a later closer of the
          // opener's own length exists — that closer needs the whole
          // opener (`**a *b*c* d**`: the `*` after `c` must not split
          // the `**` opener, the final `**` closes the strong). The
          // fallback is only for openers no later closer can use whole
          // (cm-408/413/426/430).
          const fbOpener = delims[fallback];
          let laterWhole = false;
          for (let j = d + 1; j < delims.length; j++) {
            const cl = delims[j];
            if (!cl.active || cl.isBlocker || cl.blockedForever || cl.kind !== closer.kind ||
                !cl.canClose || cl.len < fbOpener.len) continue;
            laterWhole = true;
            break;
          }
          if (!laterWhole) o = fallback;
        }
        if (o < 0) break;
        // A blocker only permanently blocks when it prevented a real match:
        // the opener found lies before the blocker. A fallback opener after
        // the blocker is unaffected.
        const barred = hitBlocker && o >= 0 && o < blockerIdx;
        if (barred) { closer.blockedForever = true; o = -1; break; }
        const opener = delims[o];
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
        for (let c2 = 0; c2 < d; c2++) {
          const cl2 = delims[c2];
          if (!cl2.active || cl2.kind !== closer.kind || !cl2.canClose || cl2.canOpen) continue;
          if (cl2.len !== opener.len && cl2.len <= closer.len) continue;
          // Openers C' would consume (nearest first, up to C'.len).
          let need = cl2.len;
          let reserves = false;
          for (let j = c2 - 1; j >= 0 && need > 0; j--) {
            const op2 = delims[j];
            if (!op2.active || op2.kind !== cl2.kind || !op2.canOpen) continue;
            if (cl2.kind === '_' &&
                ((op2.canOpen && op2.canClose) || (cl2.canOpen && cl2.canClose)) &&
                (op2.len + cl2.len) % 3 === 0) continue;
            if (j === o) { reserves = true; break; }
            need -= Math.min(op2.len, need);
          }
          if (reserves) { stolen = true; break; }
        }
        if (!stolen) break;
        // This opener is reserved by an earlier closer: try the next
        // opener further back.
        searchFrom = o - 1;
        o = -1;
      }
      if (o < 0) { d += step; continue; }
      const opener = delims[o];
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const tag = closer.kind === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const opNode = opener.node;
      const clNode = closer.node;
      const opIdx = nodes.indexOf(opNode);
      const clIdx = nodes.indexOf(clNode);
      if (opIdx < 0 || clIdx < 0 || clIdx <= opIdx) { d += step; continue; }
      const children = nodes.slice(opIdx + 1, clIdx);
      // Resolve emphasis INSIDE the em first (doc-02 `**create same
      // _examples __files guide___**`: the inner `_`/`__`/`___` must
      // pair before the outer `**` closes over them). Collect the inner
      // delimiters, resolve them in the children range, then build the
      // outer node from the resolved children.
      const childSet = new Set(children);
      const innerDelims = [];
      for (let j = delims.length - 1; j >= 0; j--) {
        const dm = delims[j];
        if (dm === opener || dm === closer) continue;
        if (dm.active && childSet.has(dm.node)) {
          innerDelims.unshift(dm);
          delims.splice(j, 1);
          if (j < d) d--;
          if (j < o) o--;
        }
      }
      if (innerDelims.length > 0) processEmphasisRange(children, innerDelims);
      // Consume `use` chars: opener takes from the end of its run, closer
      // from the start of its run.
      const origCloserLen = closer.len;
      const closerCouldOpen = closer.canOpen;
      opener.len -= use;
      closer.len -= use;
      opNode.s = opNode.s.slice(0, opNode.s.length - use);
      clNode.s = clNode.s.slice(use);
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
      if (opNode.s) replacement.push(opNode);
      replacement.push(emNode);
      let closerInside = false;
      if (clNode.s) {
        // Only a STRONG takes its closer leftover inside; an em never
        // does (`*a *b*c**` -> `<em>a <em>b</em>c</em>*`, doc-03/doc-04).
        let takeInside = false;
        if (use === 2) {
          const hasInnerEm = children.some(ch => ch.t === 'em' || ch.t === 'strong' || ch.t === 'del');
          const lastCh = children[children.length - 1];
          const attached = lastCh && lastCh.t === 'text' && lastCh.s !== '' && !/^[ \t\n]/.test(lastCh.s);
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
          children.push({ t: 'text', s: clNode.s });
          closerInside = true;
        } else {
          replacement.push(clNode);
        }
      }
      nodes.splice(opIdx, clIdx - opIdx + 1, ...replacement);
      if (opener.len === 0) { delims.splice(o, 1); if (o < d) d--; }
      if (closer.len === 0) {
        const ci = delims.indexOf(closer);
        if (ci >= 0) {
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
            delims.splice(ci, 1); if (ci < d) d--;
          }
        }
        // Forward scan: the next delimiter shifted into index d, so stay
        // (it is examined next). Reverse scan: index d now holds an
        // already-processed delimiter, so step left.
        if (reverse) d += step;
      }
      // Otherwise the closer still has length left: stay at index d so it
      // is re-examined and may pair again.
    }
  }

  // Deactivate emphasis delimiters (* / _ / ~) whose source lies strictly
  // inside a failed link label (openerSrc..closeIdx). Marked's emphasis
  // masking hides a whole link-like `[...](...)` span from the emphasis
  // parser, so `_` inside it never pairs (doc-09/16: `_node `` a ` b ``_`
  // in `[at _node `` a ` b ``_](...)` stays literal).
  function maskLabelEmphasis(openerSrc, closeIdx) {
    for (const dm of delims) {
      if (!dm.active) continue;
      if ((dm.kind === '*' || dm.kind === '_' || dm.kind === '~') && dm.src > openerSrc && dm.src < closeIdx) {
        dm.active = false;
      }
    }
  }

  // Try to form a link/image at the current ']' (index i). Returns the
  // index just past the link syntax, or -1 when no link forms.
  function tryLink(closeIdx) {
    // Find the nearest active '[' or '![' delimiter.
    let di = -1;
    for (let j = delims.length - 1; j >= 0; j--) {
      const dm = delims[j];
      if (!dm.active) continue;
      if (dm.kind === '[' || dm.kind === '![') { di = j; break; }
    }
    if (di < 0) return -1;
    const opener = delims[di];
    const isImg = opener.kind === '![';
    // Parse what follows the ']'.
    let j = closeIdx + 1;
    let href = null, title = null, endIdx = -1;
    if (text[j] === '(') {
      // Inline link: find the matching ')' (nested parens, escapes).
      // A `<...>` destination may contain `)` (and `(`): skip the whole
      // angle-bracket span so its parens do not affect the depth count.
      let k = j + 1, depth = 1;
      let p = k;
      while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p++;
      if (text[p] === '<') {
        let q = p + 1;
        while (q < n) {
          if (text[q] === '\\' && q + 1 < n && isPunct(text[q + 1])) { q += 2; continue; }
          if (text[q] === '>' || text[q] === '\n') break;
          q++;
        }
        if (text[q] === '>') k = q + 1;
      }
      while (k < n && depth > 0) {
        const c = text[k];
        if (c === '\\' && k + 1 < n && isPunct(text[k + 1])) { k += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        k++;
      }
      if (depth !== 0) return tryLinkCollapsed(di, opener, isImg, closeIdx, closeIdx + 1);
      // A `]` inside an unclosed code span (marked's lenient label scan)
      // does not end the label, so no link forms — and the whole
      // link-like `[...](...)` span is hidden from the emphasis parser,
      // so `_` inside the label never pairs (doc-09/16). Scan only the
      // label text (opener..closeIdx), never past the `]`.
      if (labelHasUnclosedSpan(text.slice(opener.src + 1, closeIdx))) {
        maskLabelEmphasis(opener.src, closeIdx);
        return -1;
      }
      const inner = text.slice(j + 1, k - 1);
      const parsed = parseLinkInner(inner);
      // An unparsable `(...)` is not a link at all: fall back to the
      // shortcut reference `[foo]` (cm-568 `[foo](not a link)`).
      if (!parsed) return tryLinkCollapsed(di, opener, isImg, closeIdx, closeIdx + 1);
      href = parsed.href; title = parsed.title; endIdx = k;
    } else if (text[j] === '[') {
      // Reference link [text][label]. A `]` inside an unclosed code span
      // does not end the label (doc-18).
      if (labelHasUnclosedSpan(text.slice(opener.src + 1, closeIdx))) return -1;
      const le = findLabelEnd(text, j);
      if (le < 0) return -1;
      const rawLabel = text.slice(j + 1, le - 1);
      const label = rawLabel.length === 0 ? null : normLabel(rawLabel);
      let ref = null;
      if (label === null) {
        // Collapsed reference: the label is the link text itself.
        ref = null; // resolved below from the link text
      } else {
        ref = refs.get(label);
        if (!ref) return -1;
      }
      href = ref ? ref.href : null;
      title = ref ? ref.title : null;
      endIdx = le;
      if (label === null) {
        // Mark for collapsed resolution after the link text is known.
        return tryLinkCollapsed(di, opener, isImg, closeIdx, endIdx);
      }
    } else {
      // Shortcut reference: the label is the link text itself. A `]`
      // inside an unclosed code span does not end the label.
      if (labelHasUnclosedSpan(text.slice(opener.src + 1, closeIdx))) return -1;
      return tryLinkCollapsed(di, opener, isImg, closeIdx, closeIdx + 1);
    }
    return finishLink(di, opener, isImg, href, title, endIdx);
  }

  // Resolve a collapsed/shortcut reference link: the label is the link
  // text, taken RAW from the source (backslashes kept) so it matches the
  // definition label exactly (cm-194 `[Foo*bar\]]`, cm-550 `[bar\\]`).
  // Using the parsed plain text would strip the backslash and miss.
  function tryLinkCollapsed(di, opener, isImg, closeIdx, endIdx) {
    let labelText;
    if (opener.src >= 0) {
      labelText = text.slice(opener.src + 1, closeIdx);
    } else {
      const opNode = opener.node;
      const opIdx = nodes.indexOf(opNode);
      if (opIdx < 0) return -1;
      labelText = plainText(nodes.slice(opIdx + 1));
    }
    const ref = refs.get(normLabel(labelText));
    if (!ref) return -1;
    return finishLink(di, opener, isImg, ref.href, ref.title, endIdx);
  }

  // Build the link/image node from the opener through the current nodes.
  // endIdx is the index just past the link syntax.
  function finishLink(di, opener, isImg, href, title, endIdx) {
    const opNode = opener.node;
    const opIdx = nodes.indexOf(opNode);
    if (opIdx < 0) return -1;
    const textNodes = nodes.slice(opIdx + 1);
    // A link's text cannot contain an explicit link, but a bare autolink
    // inside it is just text (doc-01 `[private https://... method][ref]`
    // keeps the URL literal inside the outer link). Flatten bare
    // autolinks to their text before the explicit-link check.
    flattenBareLinks(textNodes);
    // A link's text cannot contain a link. Check before touching the
    // delimiter stack, so a failed link leaves the stack intact.
    if (!isImg && containsLink(textNodes)) return -1;
    // Resolve emphasis inside the link text first (delimiters in range).
    const savedDelims = delims.splice(di + 1);
    processEmphasisRange(textNodes, savedDelims);
    // Remove the opener delimiter. The delimiters that were inside the
    // link text were spliced out into savedDelims and stay out: they were
    // resolved inside the link text and cannot pair across its boundary.
    delims.splice(di, 1);
    // Drop the opener's '[' text node and the link-text nodes, push the
    // link/image node.
    nodes.splice(opIdx);
    if (isImg) {
      nodes.push({ t: 'image', src: href, alt: plainText(textNodes), title });
    } else {
      nodes.push({ t: 'link', href, title, children: textNodes });
    }
    return endIdx;
  }

  // Replace bare-autolink nodes (flagged bare:true) with their plain
  // text, in place, recursively. Used when a bare URL/email lands inside
  // a link's text: it stays literal there.
  function flattenBareLinks(list) {
    for (let k = 0; k < list.length; k++) {
      const nd = list[k];
      if (nd.t === 'link' && nd.bare) {
        const txt = plainText(nd.children);
        list.splice(k, 1, { t: 'text', s: txt });
      } else if (nd.children) {
        flattenBareLinks(nd.children);
      }
    }
  }

  // Does any node in the list (recursively) contain an explicit link?
  // Bare and angle autolinks do not count: bare ones are flattened to
  // text, angle ones may nest inside a link's text.
  function containsLink(list) {
    for (const nd of list) {
      if (nd.t === 'link' && !nd.bare && !nd.angle) return true;
      if (nd.children && containsLink(nd.children)) return true;
    }
    return false;
  }

  // Process emphasis over a detached node list (link text) using the
  // delimiters that belong to it. Operates on copies; the caller's arrays
  // are updated by reference through the shared node objects.
  function processEmphasisRange(textNodes, rangeDelims) {
    // Temporarily swap the working arrays so processEmphasis runs on the
    // link text only.
    const savedNodes = nodes.splice(0, nodes.length);
    const savedDelims = delims.splice(0, delims.length);
    for (const nd of textNodes) nodes.push(nd);
    for (const dm of rangeDelims) delims.push(dm);
    processEmphasis();
    // Write the processed nodes back into textNodes.
    textNodes.length = 0;
    for (const nd of nodes) textNodes.push(nd);
    nodes.splice(0, nodes.length);
    delims.splice(0, delims.length);
    for (const nd of savedNodes) nodes.push(nd);
    for (const dm of savedDelims) delims.push(dm);
  }

  while (i < n) {
    const c = text[i];
    // Backslash escape / hard break.
    if (c === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        nodes.push({ t: 'br' });
        i += 2;
        // After a hard break, the next line's leading spaces are stripped.
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && isPunct(text[i + 1])) {
        addText(text[i + 1]);
        i += 2;
        continue;
      }
      addText('\\');
      i++;
      continue;
    }
    // Code span.
    if (c === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      const close = findCodeEnd(text, i + run, run);
      if (close < 0) {
        addText(text.slice(i, i + run));
        i += run;
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
      for (let j = delims.length - 1; j >= 0; j--) {
        const dm = delims[j];
        if (dm.active && (dm.kind === '[' || dm.kind === '![') && dm.src >= 0) {
          labelEnd = findLabelEnd(text, dm.src + 1);
          break;
        }
      }
      if (labelEnd >= 0 && i < labelEnd && close > labelEnd) {
        addText(text.slice(i, i + run));
        i += run;
        continue;
      }
      let content = text.slice(i + run, close - run);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          content.trim() !== '') {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content });
      i = close;
      continue;
    }
    // Emphasis / strikethrough delimiter run.
    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (i + run < n && text[i + run] === c) run++;
      const before = i > 0 ? text[i - 1] : '';
      const after = i + run < n ? text[i + run] : '';
      const [leftF, rightF] = flanking(text, before, after);
      let canOpen, canClose;
      if (c === '~') {
        canOpen = leftF;
        canClose = rightF;
        if (run > 2) { addText(text.slice(i, i + run)); i += run; continue; }
      } else if (c === '_') {
        canOpen = leftF && (!rightF || isPunctChar(before));
        canClose = rightF && (!leftF || isPunctChar(after));
      } else {
        canOpen = leftF;
        canClose = rightF;
      }
      const node = { t: 'text', s: text.slice(i, i + run) };
      nodes.push(node);
      pushDelim(c, run, canOpen, canClose, node, i);
      i += run;
      continue;
    }
    // Image opener.
    if (c === '!' && text[i + 1] === '[') {
      const node = { t: 'text', s: '![' };
      nodes.push(node);
      pushDelim('![', 1, true, false, node, i + 1);
      i += 2;
      continue;
    }
    // Link opener.
    if (c === '[') {
      const node = { t: 'text', s: '[' };
      nodes.push(node);
      pushDelim('[', 1, true, false, node, i);
      i++;
      continue;
    }
    // Link/image close.
    if (c === ']') {
      const end = tryLink(i);
      if (end >= 0) { i = end; continue; }
      // No link formed: deactivate the nearest '[' opener, emit ']' literally.
      for (let j = delims.length - 1; j >= 0; j--) {
        const dm = delims[j];
        if (dm.active && (dm.kind === '[' || dm.kind === '![')) { dm.active = false; break; }
      }
      addText(']');
      i++;
      continue;
    }
    // Angle autolink or raw HTML.
    if (c === '<') {
      const auto = matchAngleAutolink(text, i);
      if (auto) {
        // Angle autolinks may nest inside a link's text (doc-03
        // `[.. <https://..> ..](..)` keeps the inner link); they are
        // not flattened and do not block the outer link.
        nodes.push({ t: 'link', href: auto.href, title: null, angle: true, children: [{ t: 'text', s: auto.text }] });
        i = auto.end;
        continue;
      }
      const tagEnd = scanHtmlTag(text, i);
      if (tagEnd > 0) {
        const tag = text.slice(i, tagEnd);
        // Raw <a>...</a> suppresses autolinks inside it (marked inLink).
        // marked's startATag is /^<a /i: only `<a ` WITH a space (i.e.
        // with attributes) sets it — a bare `<a>` does not (doc-04).
        const low = tag.toLowerCase();
        if (low.startsWith('<a ') || low.startsWith('<a\t') || low.startsWith('<a\n')) inLink = true;
        else if (low === '</a>' || low.startsWith('</a ') || low.startsWith('</a\t') || low.startsWith('</a\n') || low.startsWith('</a>')) inLink = false;
        nodes.push({ t: 'html', s: tag });
        i = tagEnd;
        continue;
      }
      addText('<');
      i++;
      continue;
    }
    // Entity / numeric reference. A named entity (&word;) is emitted as a
    // single text node so escText preserves it; a bare & is escaped.
    if (c === '&') {
      const nr = numRef(text, i);
      if (nr) {
        addText(nr.ch);
        i += nr.len;
        continue;
      }
      let j = i + 1;
      while (j < n && (isAlphaNum(text[j]) || text[j] === '_')) j++;
      if (j > i + 1 && j < n && text[j] === ';') {
        addText(text.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      addText('&');
      i++;
      continue;
    }
    // Hard break: two or more trailing spaces before a newline.
    if (c === '\n') {
      nodes.push({ t: 'soft' });
      i++;
      continue;
    }
    // Bare autolinks (scheme / www) and emails, at a word boundary.
    // Suppressed inside a raw <a>...</a> (inLink).
    if (!inLink && (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'W' || c === 'm' || c === 'M' || c === 'x' || c === 'X') && (i === 0 || !isAlphaNum(text[i - 1]))) {
      // A bare URL stops at `]` only when it is inside a link label
      // whose link can still form. If the open label already contains
      // a link node, the link cannot form (a link's text cannot contain
      // a link), so the `]` is free for the URL: doc-08
      // `(https://a.com)](https://b.com)` is one autolink, not two.
      let inLabel = false;
      for (let q = delims.length - 1; q >= 0; q--) {
        const dm = delims[q];
        if (dm.active && (dm.kind === '[' || dm.kind === '![')) {
          const opIdx = nodes.indexOf(dm.node);
          let hasLink = false;
          if (opIdx >= 0) {
            for (let k = opIdx + 1; k < nodes.length; k++) {
              const nd = nodes[k];
              if (nd.t === 'link' && !nd.bare && !nd.angle) { hasLink = true; break; }
              if (nd.children && containsLink(nd.children)) { hasLink = true; break; }
            }
          }
          if (!hasLink) inLabel = true;
          break;
        }
      }
      const auto = matchBareAutolink(text, i, inLabel);
      if (auto) {
        nodes.push({ t: 'link', href: auto.href, title: null, bare: true, children: [{ t: 'text', s: auto.text }] });
        i = auto.end;
        continue;
      }
    }
    if (!inLink && isAlphaNum(c) && (i === 0 || !isEmailLocal(text[i - 1]))) {
      // A trailing `_` is an emphasis closer (not an email char) when
      // there is an active `_` opener that can pair with it.
      let allowU = false;
      for (let q = delims.length - 1; q >= 0; q--) {
        const dm = delims[q];
        if (dm.active && dm.kind === '_' && dm.canOpen) { allowU = true; break; }
      }
      const em = matchEmail(text, i, allowU);
      if (em) {
        nodes.push({ t: 'link', href: 'mailto:' + em.text, title: null, bare: true, children: [{ t: 'text', s: em.text }] });
        i = em.end;
        continue;
      }
    }
    // Plain text run up to the next special character. First jump to
    // the next special char with a regex; if the segment between here
    // and there contains no autolink/email trigger, take it whole.
    // Otherwise fall back to the per-char loop for this segment.
    INLINE_SPECIAL_RE.lastIndex = i;
    const sm = INLINE_SPECIAL_RE.exec(text);
    const segEnd = sm ? sm.index : n;
    if (!inLink) {
      const seg = text.slice(i, segEnd);
      // Cheap trigger check (native indexOf, not regex): an autolink or
      // email can only start if one of these substrings is present.
      if (seg.indexOf('@') < 0 && seg.indexOf('://') < 0 && seg.indexOf('www.') < 0 &&
          seg.indexOf('mailto:') < 0 && seg.indexOf('xmpp:') < 0) {
        let runText = seg;
        if (segEnd < n && text[segEnd] === '\n') {
          const m = / {2,}$/.exec(runText);
          if (m) {
            runText = runText.slice(0, runText.length - m[0].length);
            addText(runText);
            nodes.push({ t: 'br' });
            i = segEnd + 1;
            while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
            continue;
          }
        }
        addText(runText);
        i = segEnd;
        continue;
      }
    }
    let j = i;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\' || ch === '`' || ch === '*' || ch === '_' || ch === '~' ||
          ch === '[' || ch === ']' || ch === '<' || ch === '&' || ch === '\n' ||
          (ch === '!' && text[j + 1] === '[')) break;
      const prev = j > 0 ? text[j - 1] : '';
      if (!inLink && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W' || ch === 'm' || ch === 'M' || ch === 'x' || ch === 'X') && !isAlphaNum(prev) &&
          matchBareAutolink(text, j)) break;
      if (!inLink && isAlphaNum(ch) && !isEmailLocal(prev)) {
        let allowU = false;
        for (let q = delims.length - 1; q >= 0; q--) {
          const dm = delims[q];
          if (dm.active && dm.kind === '_' && dm.canOpen) { allowU = true; break; }
        }
        if (matchEmail(text, j, allowU)) break;
      }
      j++;
    }
    // Two trailing spaces before a newline are a hard break: handled by
    // trimming the run and emitting <br> when the next char is '\n'.
    let runText = text.slice(i, j);
    if (j < n && text[j] === '\n') {
      const m = / {2,}$/.exec(runText);
      if (m) {
        runText = runText.slice(0, runText.length - m[0].length);
        addText(runText);
        nodes.push({ t: 'br' });
        i = j + 1;
        // After a hard break, the next line's leading spaces are stripped.
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
    }
    addText(runText);
    i = j;
  }
  processEmphasis();
  return nodes;
}

// Parse the inside of an inline link's parentheses: a destination and an
// optional title. Returns {href, title} or null.
function parseLinkInner(inner) {
  let i = 0;
  while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t' || inner[i] === '\n')) i++;
  // An empty destination `()` is a valid link with an empty href.
  if (i >= inner.length) return { href: '', title: null };
  const dest = parseDest(inner, i);
  if (!dest) return null;
  let href = dest.href;
  let title = null;
  let k = dest.end;
  while (k < inner.length && (inner[k] === ' ' || inner[k] === '\t' || inner[k] === '\n')) k++;
  if (k < inner.length) {
    const t = parseTitle(inner, k);
    if (!t) return null;
    title = t.title;
    k = t.end;
    while (k < inner.length && (inner[k] === ' ' || inner[k] === '\t' || inner[k] === '\n')) k++;
    if (k < inner.length) return null;
  }
  return { href, title };
}

// Is the character part of an email local part (for word-boundary checks)?
function isEmailLocal(ch) {
  return isAlphaNum(ch) || ch === '.' || ch === '_' || ch === '%' || ch === '+' || ch === '-';
}

// Bare autolink (scheme:// or www.) starting at text[i]. The preceding
// character must not be alphanumeric (word boundary). Returns
// {end, href, text} or null. `inLabel` is true when the URL starts
// inside a link label: only then does a `]` end the URL (so it does not
// swallow the label's closing bracket); outside a label, marked's URL
// regex `[^\s<]*` keeps `]` (and a following `(...)`) in the URL
// (doc-08 `(https://a.com)](https://b.com)` is one autolink).
function matchBareAutolink(text, i, inLabel) {
  if (i > 0 && isAlphaNum(text[i - 1])) return null;
  let scheme = null;
  const low = text.slice(i, i + 8).toLowerCase();
  if (low.startsWith('http://')) scheme = text.slice(i, i + 7);
  else if (low.startsWith('https://')) scheme = text.slice(i, i + 8);
  else if (low.startsWith('ftp://')) scheme = text.slice(i, i + 6);
  else if (low.startsWith('mailto:')) {
    // mailto:email — the whole `mailto:foo@bar.baz` is one link.
    const em = matchEmail(text, i + 7);
    if (!em) return null;
    const url = text.slice(i, i + 7) + em.text;
    return { end: i + 7 + em.text.length, href: url, text: url };
  } else if (low.startsWith('xmpp:')) {
    // xmpp:email[/resource] — one optional `/segment` resource.
    const em = matchEmail(text, i + 5);
    if (!em) return null;
    let end = i + 5 + em.text.length;
    let url = text.slice(i, i + 5) + em.text;
    if (text[end] === '/') {
      let k = end + 1;
      while (k < text.length) {
        const ch = text[k];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '/') break;
        k++;
      }
      if (k > end + 1) { url = text.slice(i, k); end = k; }
    }
    return { end, href: url, text: url };
  } else if (text.startsWith('www.', i)) {
    if (i > 0) {
      const p = text[i - 1];
      if (!(p === ' ' || p === '\t' || p === '\n' || p === '(')) return null;
    }
    scheme = 'www.';
  }
  if (!scheme) return null;
  let j = i + scheme.length;
  const n = text.length;
  while (j < n) {
    const ch = text[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || (inLabel && ch === ']')) break;
    j++;
  }
  if (j === i + scheme.length) return null;
  let url = text.slice(i, j);
  url = trimUrl(url);
  if (!url) return null;
  // A www. link needs a dot in the domain part after www.
  if (scheme === 'www.' && url.indexOf('.', 4) < 0) return null;
  const href = scheme === 'www.' ? 'http://' + url : url;
  return { end: i + url.length, href, text: url };
}

// Email autolink starting at text[i] (a word character). Returns
// {end, text} or null.
function matchEmail(text, i, allowTrailingUnderscore) {
  const n = text.length;
  // Fast reject: an email needs an `@` within the current word (before
  // the next space or special char). Scanning for `@` first avoids the
  // full local-part parse for ordinary words.
  let at = -1;
  for (let q = i; q < n && q < i + 64; q++) {
    const ch = text[q];
    if (ch === '@') { at = q; break; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<') break;
  }
  if (at < 0) return null;
  // Local part: letters, digits and . _ % + - (not starting/ending with .).
  let j = i;
  while (j < n) {
    const ch = text[j];
    if (isAlphaNum(ch) || ch === '.' || ch === '_' || ch === '%' || ch === '+' || ch === '-') j++;
    else break;
  }
  if (j === i || text[j] !== '@') return null;
  const local = text.slice(i, j);
  if (local[0] === '.' || local[local.length - 1] === '.') return null;
  let k = j + 1;
  const ds = k;
  while (k < n) {
    const ch = text[k];
    if (isAlphaNum(ch) || ch === '.' || ch === '-') k++;
    else break;
  }
  if (k === ds) return null;
  let dom = text.slice(ds, k);
  dom = trimUrl(dom);
  if (!dom || dom.indexOf('.') < 0) return null;
  if (dom[0] === '.' || dom[0] === '-' || dom[dom.length - 1] === '.' || dom[dom.length - 1] === '-') return null;
  // The char after the domain must not be a word char or `-` (gfm-632
  // `a.b-c_d@a.b_` is not an email: the `_` continues the identifier).
  // But a trailing `_` that is an emphasis closer (there is an active
  // `_` opener that can pair with it, doc-04 `__.. because@mark..__`)
  // does not continue the email — the email is linkified inside the em.
  const after = text[ds + dom.length];
  if (after !== undefined && (isAlphaNum(after) || after === '-')) return null;
  if (after === '_' && !allowTrailingUnderscore) return null;
  return { end: ds + dom.length, text: local + '@' + dom };
}
function canInterruptPara(marker, empty) {
  if (empty) return false;
  if (!marker.ordered) return true;
  return marker.start === 1;
}

// Start (or continue) a list for the marker at (content, ccol). Creates the
// list/item, pushes the item, and returns the item's first content
// {content, col, line} or null. `line` is the current line index.
function startListItem(P, i, stack, marker, content, ccol, lastBlank, lastBlankDepth) {
  // Content indent: marker start + marker width + following spaces (1-4
  // spaces; 5+ means only 1 column is consumed, the rest is content).
  const ind = indentOf(content, 0, ccol);
  const mcol = ind.col; // column of the marker
  const afterIdx = ind.idx + marker.markerLen;
  const afterCol = mcol + marker.markerLen;
  // Measure the whitespace after the marker (up to 5 columns).
  let wj = afterIdx, wc = afterCol, wcols = 0;
  while (wj < content.length && wcols < 5) {
    const ch = content[wj];
    if (ch === ' ') { wj++; wc++; wcols++; }
    else if (ch === '\t') { const w = 4 - (wc % 4); wj++; wc += w; wcols += w; }
    else break;
  }
  let contentIndent;
  let firstContent;
  if (isBlankFrom(content, afterIdx)) {
    // Empty item: content starts on a later line.
    contentIndent = mcol + marker.markerLen + 1;
    firstContent = '';
  } else if (wcols >= 5) {
    // 5+ spaces: consume only 1 column; the rest is content (a partially
    // consumed tab becomes pad spaces).
    contentIndent = mcol + marker.markerLen + 1;
    const adv = advanceTo(content, afterIdx, afterCol, 0, contentIndent);
    firstContent = ' '.repeat(adv.pad) + content.slice(adv.pos);
  } else {
    contentIndent = wc;
    firstContent = content.slice(wj);
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
    let r = 3;
    while (r < firstContent.length && (firstContent[r] === ' ' || firstContent[r] === '\t')) r++;
    if (r < firstContent.length) {
      task = firstContent[1] === 'x' || firstContent[1] === 'X';
      firstContent = firstContent.slice(r);
    }
  }
  // Find or create the list: the current container's last child, if it is a
  // list of the same kind, continues when the new marker is a sibling of
  // the last item — i.e. its indent is below the last item's content
  // indent (so `- foo`, ` - bar`, `  - baz` are one list). At or above
  // that indent it is a sublist (a new list nested in the item).
  const parent = blockParent(stack);
  const kids = parent.children;
  let list = null;
  if (kids.length > 0) {
    const last = kids[kids.length - 1];
    if (last.t === 'list' && last.ordered === marker.ordered &&
        last._delim === marker.delim && last.items.length > 0) {
      const lastItem = last.items[last.items.length - 1];
      if (mcol - ccol < lastItem._contentIndent) list = last;
    }
  }
  if (!list) {
    list = { t: 'list', ordered: marker.ordered, start: marker.start, tight: true, items: [], _markerIndent: mcol, _delim: marker.delim };
    markLoose(parent, lastBlank, lastBlankDepth, stack);
    kids.push(list);
  } else if (lastBlank && list.items.length > 0 &&
      (lastBlankDepth === undefined || lastBlankDepth < 0 ||
       lastBlankDepth <= stack.indexOf(parent) + 2)) {
    // Depth-scoped (cm-320): a blank inside a nested container (e.g. a
    // `>`-only line in a blockquote within the previous item) does not
    // loosen the list; only a blank at or above the list's level does.
    list.tight = false;
  }
  const item = { t: 'item', children: [], _contentIndent: contentIndent - ccol, _list: list };
  if (task !== undefined) item._task = task;
  list.items.push(item);
  stack.push(item);
  return { content: firstContent, col: contentIndent, line: i };
}

// Parse a fenced code block starting at line i. Returns the next line index.
function parseFenced(P, i, stack, fence, content, ccol, lastBlank, lastBlankDepth) {
  const lines = [];
  let k = i + 1;
  const n = P.lines.length;
  // The fence's own indent is stripped from every code line — but only
  // for BACKTICK fences. A TILDE fence never dedents its content in
  // marked (doc-22: `~~~typescript` keeps the 3 spaces of its content
  // line; a ``` fence at the same indent strips them).
  const fenceIndent = fence.ch === '~' ? 0 : indentOf(content, 0, ccol).col - ccol;
  while (k < n) {
    const c = contentAt(P, k, stack);
    if (c) {
      if (isFenceClose(c.content, 0, c.col, fence.ch, fence.len)) { k++; break; }
      // A blank line that is missing a BLOCKQUOTE marker ends the
      // blockquote — and a fence inside it — instead of becoming an
      // empty code line (doc-06 `>` with no inner `> > `; doc-08 a
      // bare blank line after a fence opened in a blockquote). A
      // completely blank line is code content only when the fence is
      // NOT inside a blockquote (doc-02 list-item fence); a blank line
      // missing only a LIST indent is still fence content.
      if (c.content.trim() === '') {
        const raw = P.lines[k];
        let quotesInStack = 0;
        for (let s = 1; s < stack.length; s++) {
          if (stack[s].t === 'para') break;
          if (stack[s].t === 'quote') quotesInStack++;
        }
        if (quotesInStack > 0) {
          if (/^[ \t]*$/.test(raw)) break;
          // Count the `>` markers the raw line actually has. The
          // markers may sit past a list-item indent (more than 3
          // spaces), so skip all leading whitespace before each `>`
          // — contentAt already validated the line against the
          // containers, so a `>` here is a marker, not code text.
          let markers = 0, p = 0;
          while (p < raw.length) {
            while (p < raw.length && (raw[p] === ' ' || raw[p] === '\t')) p++;
            if (p < raw.length && raw[p] === '>') { markers++; p++; }
            else break;
          }
          if (markers < quotesInStack) break;
        }
      }
      let line = contentFromCol(c.content, c.col, c.col + fenceIndent, true);
      // A leading tab in the dedented content expands to spaces when the
      // fence is inside a container (doc-22: `>   \tindented` in a
      // ```rust fence becomes 4 spaces; at top level the tab is kept).
      // The tab's width comes from its ABSOLUTE column in the source
      // (the dedented content starts at c.col + fenceIndent), not from
      // column 0 of the dedented line (doc-30: a tab at absolute column
      // 3 expands to 1 space, not 4).
      if (stack.length > 1 && line.length > 0 && line.slice(0, line.search(/[^ \t]/) < 0 ? line.length : line.search(/[^ \t]/)).includes('\t')) {
        let out = '', col = c.col + fenceIndent, j = 0;
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
          if (line[j] === ' ') { out += ' '; col++; j++; }
          else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; j++; }
        }
        line = out + line.slice(j);
      }
      lines.push(line);
      k++;
      continue;
    }
    // A line that does not match the enclosing containers still belongs
    // to an open fenced code block when the mismatch is a LIST item
    // (marked keeps a column-0 line inside a fence opened in a list
    // item). A blank line, or a line that fails a BLOCKQUOTE marker,
    // closes the blockquote (and the fence) instead.
    const raw = P.lines[k];
    if (isBlankFrom(raw, 0)) break;
    let quoteFails = false;
    let itemIndentFails = false;
    {
      let p2 = 0, c2 = 0, pd2 = 0;
      for (let s = 1; s < stack.length; s++) {
        const b = stack[s];
        if (b.t === 'para') break;
        if (isBlankFrom(raw, p2)) break;
        if (b.t === 'quote') {
          const m = matchQuoteMarker(raw, p2, c2, pd2);
          if (!m) { quoteFails = true; break; }
          p2 = m.pos; c2 = m.col; pd2 = m.pad;
        } else if (b.t === 'item') {
          const want = c2 + b._contentIndent;
          const ind = indentFrom(raw, p2, c2, pd2);
          if (ind.col < want) { itemIndentFails = true; break; }
          const adv = advanceTo(raw, p2, c2, pd2, want);
          p2 = adv.pos; c2 = adv.col; pd2 = adv.pad;
        }
      }
    }
    if (quoteFails) break;
    // A line that starts a new list item is a new block, not fence
    // content (doc-05 `* [x] ...` after a fenced blockquote; doc-21
    // `  - b` after a fence in a nested blockquote). The marker may be
    // indented up to 3 spaces (a list item at the enclosing list's
    // level). Plain text (e.g. `npm install ...`) is still absorbed.
    if (itemIndentFails && /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]/.test(raw)) break;
    // An EMPTY fence in a list item ends at a line that fails the item's
    // content indent: a column-0 line cannot be the fence's first
    // content line (doc-17: `1. item` + `   ```toml` + `if previous` is
    // an empty fence + a paragraph). Once the fence has content, such
    // lines are absorbed as code (doc-05, cases A/C/E). A fence in a
    // blockquote (no list item) still absorbs them (itemIndentFails is
    // false there).
    if (itemIndentFails && lines.length === 0) break;
    if (isFenceClose(raw, 0, 0, fence.ch, fence.len)) { k++; break; }
    lines.push(contentFromCol(raw, 0, fenceIndent, true));
    k++;
  }
  // Drop exactly one trailing empty line (the code always ends with a
  // newline); whitespace-only lines with spaces are kept.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const text = lines.length === 0 ? '' : lines.join('\n') + '\n';
  const parent = blockParent(stack);
  markLoose(parent, lastBlank, lastBlankDepth, stack);
  parent.children.push({ t: 'code', fenced: true, info: fence.info, text });
  return k;
}

// Parse an indented code block starting at line i. Returns next line index.
// Line i uses the already container-stripped `content` (it may be the list
// marker line, which contentAt could not re-derive); later lines go through
// contentAt.
function parseIndentedCode(P, i, stack, content, ccol, lastBlank, lastBlankDepth) {
  const lines = [];
  let k = i;
  const n = P.lines.length;
  // Blank lines are held as pending: they only join the code block if a
  // later non-blank line is still indented code. Otherwise the block ends
  // BEFORE the first pending blank line, so the main loop sees it (and a
  // bare blank line can close an enclosing blockquote).
  let pending = [];
  let pendingStart = -1;
  while (k < n) {
    const c = k === i ? { content, col: ccol } : contentAt(P, k, stack);
    if (!c) break;
    if (isBlankFrom(c.content, 0)) {
      if (pendingStart < 0) pendingStart = k;
      pending.push(contentFromCol(c.content, c.col, c.col + 4));
      k++;
      continue;
    }
    const ind = indentOf(c.content, 0, c.col);
    if (ind.col - c.col < 4) break;
    for (const pl of pending) lines.push(pl);
    pending = []; pendingStart = -1;
    lines.push(contentFromCol(c.content, c.col, c.col + 4));
    k++;
  }
  // Strip ALL trailing blank lines (indented code ends at the last
  // non-blank line; the final newline is added by the join below).
  while (lines.length > 0 && isBlankFrom(lines[lines.length - 1], 0)) lines.pop();
  const text = lines.length === 0 ? '' : lines.join('\n') + '\n';
  const parent = blockParent(stack);
  markLoose(parent, lastBlank, lastBlankDepth, stack);
  parent.children.push({ t: 'code', fenced: false, info: '', text });
  // If we stopped at a non-code line with pending blank lines, resume at
  // the first pending blank line so the main loop sees it.
  return pendingStart >= 0 ? pendingStart : k;
}

// Parse an HTML block. hb = {type, endLine} from htmlBlockAt. Returns the
// next line index. The block's lines are the container-stripped content
// lines (blockquote/list markers are not part of the HTML output).
function parseHtmlBlock(P, i, stack, hb, content, ccol, lastBlank, lastBlankDepth) {
  const parent = blockParent(stack);
  markLoose(parent, lastBlank, lastBlankDepth, stack);
  const rawLines = [content];
  for (let k = i + 1; k <= hb.endLine; k++) {
    const c = contentAt(P, k, stack);
    rawLines.push(c ? c.content : '');
  }
  // Trailing newline (delimited types 1-5 only: script/pre/style,
  // comment, PI, declaration, CDATA — all end at a closing marker):
  // present iff the block is followed by a line that is not completely
  // empty — a whitespace-only line (space or tab) counts (doc-15: a
  // tab-only line after `-->` keeps the trailing newline), but a truly
  // empty line does not. Tag blocks (types 6-7) never have one. At EOF
  // it depends on the source ending with a newline at top level.
  let trailingNL = false;
  if (hb.endLine < P.n - 1) {
    if (hb.type <= 5) {
      const nx = contentAt(P, hb.endLine + 1, stack);
      trailingNL = !!nx && nx.content.length > 0;
    }
  } else {
    trailingNL = stack.length === 1 && P.endsNL;
  }
  parent.children.push({ t: 'html', lines: rawLines, trailingNL });
  return hb.endLine + 1;
}

// Parse a table starting at line i (header = current line, delimiter = next
// line). Returns the next line index. Rows are padded with empty cells or
// truncated to the header cell count.
function parseTable(P, i, stack, hdr, del, content, ccol, lastBlank, lastBlankDepth) {
  const rows = [];
  let k = i + 2;
  const n = P.lines.length;
  while (k < n) {
    const c = contentAt(P, k, stack);
    if (!c) break;
    // A line with exactly one tab is a table row of empty cells in
    // marked (doc-02); two tabs or tab+space is a blank line.
    if (c.content === '\t') {
      const cells = [];
      while (cells.length < hdr.length) cells.push('');
      rows.push(cells);
      k++;
      continue;
    }
    if (isBlankFrom(c.content, 0)) break;
    // A line that starts a block (blockquote, heading, fence, ...) ends
    // the table; a bare line without `|` is still a one-cell row.
    if (startsInterruptingBlock(P, k, c.content, c.col, stack)) break;
    const cells = splitTableRow(c.content);
    while (cells.length < hdr.length) cells.push('');
    if (cells.length > hdr.length) cells.length = hdr.length;
    rows.push(cells);
    k++;
  }
  const parent = blockParent(stack);
  markLoose(parent, lastBlank, lastBlankDepth, stack);
  parent.children.push({ t: 'table', aligns: del, header: hdr, rows });
  return k;
}

// HTML block start, content-based (works on the container-stripped content
// string of the current line). Returns {type, endLine} or null. Lookahead
// lines are read through contentAt with the live stack, so blockquote/list
// markers are stripped before the closing-marker search. A line that does
// not continue the containers ends the block.
function htmlBlockAt(P, i, content, ccol, inPara, stack) {
  const ind = indentOf(content, 0, ccol);
  if (ind.col - ccol > 3) return null;
  const j = ind.idx;
  if (content[j] !== '<') return null;
  const rest = content.slice(j);
  // Scan subsequent lines for a substring; returns the line index where it
  // is found, or the last line that continues the containers.
  function scanFor(sub) {
    let last = i;
    for (let k = i; k < P.n; k++) {
      const c = k === i ? { content } : contentAt(P, k, stack);
      if (!c) return last;
      last = k;
      if (c.content.indexOf(sub) >= 0) return k;
    }
    return last;
  }
  function scanForRe(re) {
    let last = i;
    for (let k = i; k < P.n; k++) {
      const c = k === i ? { content } : contentAt(P, k, stack);
      if (!c) return last;
      last = k;
      if (re.test(c.content)) return k;
    }
    return last;
  }
  // Type 1 starts only with the OPENING tag <pre>/<script>/<style>/
  // <textarea>; a closing tag alone (</pre>) is paragraph text (cm-148).
  const m1 = /^<(script|pre|style|textarea)(?=[\s>\/]|$)/i.exec(rest);
  if (m1) {
    const tag = m1[1].toLowerCase();
    return { type: 1, endLine: scanForRe(new RegExp('</' + tag + '\\s*>', 'i')) };
  }
  if (rest.startsWith('<!--')) return { type: 2, endLine: scanFor('-->') };
  if (rest.startsWith('<?')) return { type: 3, endLine: scanFor('?>') };
  if (rest.startsWith('<!') && rest.length > 2 && /[A-Za-z]/.test(rest[2])) {
    return { type: 4, endLine: scanFor('>') };
  }
  if (rest.startsWith('<![CDATA[')) return { type: 5, endLine: scanFor(']]>') };
  // Type 6: the line begins with < or </ followed by a block tag name,
  // followed by whitespace, end of line, > or />. The tag need NOT close
  // on this line. Type 7: a complete non-block tag.
  const mTag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (mTag) {
    const name = mTag[1].toLowerCase();
    const after = rest[mTag[0].length];
    const afterOk = after === undefined || after === ' ' || after === '\t' ||
      after === '>' || (after === '/' && rest[mTag[0].length + 1] === '>');
    if (afterOk) {
      let k = i;
      while (k + 1 < P.n) {
        const c = contentAt(P, k + 1, stack);
        if (!c || isBlankFrom(c.content, 0)) break;
        k++;
      }
      if (BLOCK_TAG_SET.has(name)) return { type: 6, endLine: k };
      // Type 7: a complete non-block tag that is alone on the line (only
      // whitespace may follow it); otherwise it is inline HTML in a
      // paragraph, e.g. <del>*foo*</del>.
      if (!inPara) {
        const te = scanHtmlTag(content, j);
        if (te > 0 && isBlankFrom(content, te)) return { type: 7, endLine: k };
      }
    }
  }
  return null;
}

// Check whether s (starting at i) begins an autolink <scheme:...> or
// <email>. Returns {end, href, text} or null.
function matchAngleAutolink(s, i) {
  const n = s.length;
  const close = s.indexOf('>', i + 1);
  if (close < 0) return null;
  const inner = s.slice(i + 1, close);
  if (inner.length === 0 || inner.indexOf(' ') >= 0 || inner.indexOf('\n') >= 0 || inner.indexOf('<') >= 0) return null;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  const m = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
  if (m) return { end: close + 1, href: inner, text: inner };
  // Email: local@domain with a dot in the domain.
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(inner)) {
    return { end: close + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}
