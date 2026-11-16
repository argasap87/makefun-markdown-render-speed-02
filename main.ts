// Entry driver for markdown-render-speed-02: loads the case list, renders
// each markdown input on its own through parse(), and stores the resulting
// HTML strings, in order, as a JSON array. Outside a container, the input
// and output folders come from MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// instead of the /input and /output mounts.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as renderMarkdown } from "./parse.js";

const srcDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const dstDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = fs.readFileSync(path.join(srcDir, "cases.json"), "utf8");
const entries = JSON.parse(raw) as Array<{ id: string; markdown: string }>;
const rendered: string[] = [];
for (const entry of entries) rendered.push(renderMarkdown(entry.markdown));
fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(path.join(dstDir, "html.json"), JSON.stringify(rendered));
