# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/argasap87/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/argasap87/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02) — referral code `1ae1r9cj`.

A quick, dependency-free replacement for marked 18.1.3: `parse.js` turns
CommonMark 0.31.2 + GFM into exactly the HTML marked produces with its
default options, using a hand-built one-pass parser in place of marked's
multi-pass regex lexer, so it runs noticeably faster.

## Layout

- `parse.js` — dependency-free ES module, exports `parse(markdown)`.
- `main.ts` — harness driver: reads `/input/cases.json`, writes
  `/output/html.json` (or `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`
  outside a container).
- `.makefun/owner.json` — payout wallet claim file.

## Design

Block parsing walks the lines a single time; inline parsing runs in one
sweep with a delimiter stack for emphasis, strong emphasis and
strikethrough; HTML goes straight into an array joined at the end. No
token objects, no per-character regexes on hot paths, no caching between
cases — every call to `parse` is stateless.
