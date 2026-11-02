#!/usr/bin/env node
/**
 * Write every glyph (src/lib/icons/glyphs.ts) as a standalone SVG file into a
 * folder, for a designer to open, edit and hand back
 * (docs/development/images.md#replacing-a-glyph). `activity/badminton`
 * becomes `activity-badminton.svg`. Nothing it writes is committed, and CI
 * does not run it.
 *
 * Usage: npm run glyphs:export -- <folder>
 */
import fs from "node:fs";
import path from "node:path";
import { GLYPHS, glyphSvg } from "../src/lib/icons/glyphs.ts";

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: npm run glyphs:export -- <folder>");
  process.exit(1);
}
fs.mkdirSync(folder, { recursive: true });
const names = Object.keys(GLYPHS);
for (const name of names) {
  fs.writeFileSync(path.join(folder, `${name.replace("/", "-")}.svg`), `${glyphSvg(name, 24)}\n`);
}
console.log(`Wrote ${names.length} glyphs to ${path.resolve(folder)}.`);
