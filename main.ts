// Entry point for the markdown-render-speed-02 submission.
// Every case in the input directory is rendered on its own with the
// bundled parse() implementation; the resulting HTML strings are kept in
// input order and written out as a single JSON array. The directories
// default to the container mounts /input and /output and may be changed
// through MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

type Entry = { id: string; markdown: string };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const entries: Entry[] = JSON.parse(readFileSync(join(inDir, "cases.json"), "utf8"));
const html: string[] = [];
for (let n = 0; n < entries.length; n++) html.push(parse(entries[n].markdown));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "html.json"), JSON.stringify(html));
