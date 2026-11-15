# markdown-render-speed-02

A fast, dependency-free drop-in for marked 18.1.3: `parse.js` renders
CommonMark 0.31.2 + GFM exactly the HTML marked renders with its default
options, but with a hand-written single-pass parser instead of marked's
multi-pass regex lexer, so it runs measurably faster.

## Layout

- `parse.js` — dependency-free ES module, exports `parse(markdown)`.
- `main.ts` — harness driver: reads `/input/cases.json`, writes
  `/output/html.json` (or `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` outside
  a container).
- `.makefun/owner.json` — payout wallet claim file.

## Design

Block parsing walks lines once; inline parsing runs in a single pass with
a delimiter stack for emphasis, strong emphasis and strikethrough; HTML is
emitted directly into an array joined at the end. No token objects, no
per-character regexes on hot paths, no caching between cases — each call to
`parse` is stateless.
