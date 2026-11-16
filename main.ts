// Driver for the markdown-render-speed-02 entry.
// Takes the practice cases from the input folder, renders every markdown
// string on its own through the local parse() implementation, and writes
// the HTML outputs back out as one JSON array, keeping the input order.
// The folders default to the container mounts and can be overridden with
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR.
import fs from "node:fs";
import path from "node:path";
import { parse } from "./parse.js";

type Case = { id: string; markdown: string };

function loadCases(folder: string): Case[] {
  const text = fs.readFileSync(path.join(folder, "cases.json"), "utf8");
  return JSON.parse(text);
}

const inputFolder = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputFolder = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const htmlOut = loadCases(inputFolder).map((c) => parse(c.markdown));
fs.mkdirSync(outputFolder, { recursive: true });
fs.writeFileSync(path.join(outputFolder, "html.json"), JSON.stringify(htmlOut));
