// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTIVITY_CATEGORIES, BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { BUSINESS_TYPE_IDS } from "../src/lib/guide/business-types";
import {
  BUSINESS_TONES,
  GENERIC_GLYPHS,
  GLYPH_ATTRIBUTES,
  GLYPH_TONES,
  GLYPHS,
  glyphShapes,
  glyphSvg,
  isActivityGlyph,
  parseGlyph,
  type GlyphName,
  type GlyphShape,
} from "../src/lib/icons/glyphs";
import { readIcon } from "../src/lib/activities";

/**
 * MySenam's pictures keep one standard (docs/development/images.md): every
 * activity, kind of business and category has its glyph, and every glyph is
 * a plain line drawing on the 24-unit grid that a designer can replace
 * without anything else changing.
 */

const NAMES = Object.keys(GLYPHS) as GlyphName[];
/** Largest a glyph's markup may be: they all travel to the browser with the pages that draw them. */
const BUDGET = 700;

describe("the glyph registry", () => {
  it("has a glyph for every built-in activity, and the catalogue names it", () => {
    for (const a of BUILTIN_ACTIVITIES) {
      expect(a.icon, a.key).toBe(`activity/${a.key}`);
      expect(GLYPHS, a.key).toHaveProperty(a.icon);
    }
  });

  it("has a glyph and a tone for every kind of business", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      expect(GLYPHS, id).toHaveProperty(`business/${id}`);
      expect(GLYPH_TONES).toContain(BUSINESS_TONES[id]);
    }
    expect(Object.keys(BUSINESS_TONES).sort()).toEqual([...BUSINESS_TYPE_IDS].sort());
  });

  it("has a glyph for every category, each category a tone of its own", () => {
    for (const c of ACTIVITY_CATEGORIES) {
      expect(GLYPHS, c).toHaveProperty(`category/${c}`);
      expect(GLYPH_TONES).toContain(c);
    }
  });

  it("has the generic set for operators' own activities", () => {
    expect(GENERIC_GLYPHS).toEqual([
      "generic/ball",
      "generic/racket",
      "generic/goal",
      "generic/wave",
      "generic/weights",
      "generic/mat",
      "generic/target",
      "generic/wheel",
      "generic/mountain",
      "generic/whistle",
      "generic/stopwatch",
      "generic/court",
    ]);
    for (const g of GENERIC_GLYPHS) expect(GLYPHS).toHaveProperty(g);
  });

  it("names every glyph by its set and a slug, and nothing outside the sets", () => {
    for (const n of NAMES) expect(n).toMatch(/^(activity|business|category|generic|feature)\/[a-z0-9_-]+$/);
    // No glyph is drawn twice under two names.
    expect(new Set(NAMES.map((n) => GLYPHS[n])).size).toBe(NAMES.length);
  });

  it("lets an activity be drawn with a generic, an activity's or a category's glyph only", () => {
    expect(isActivityGlyph("generic/ball")).toBe(true);
    expect(isActivityGlyph("activity/padel")).toBe(true);
    expect(isActivityGlyph("category/team")).toBe(true);
    expect(isActivityGlyph("business/mixed")).toBe(false);
    expect(isActivityGlyph("feature/games")).toBe(false);
    expect(isActivityGlyph("generic/nothing")).toBe(false);
    expect(isActivityGlyph("toString")).toBe(false);
  });
});

/** Every point a path's commands reach (end points and control points), absolute. */
function pathPoints(d: string): [number, number][] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const pts: [number, number][] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  let i = 0;
  const num = () => Number(tokens[i++]);
  const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toLowerCase();
    if (c === "z") {
      x = sx;
      y = sy;
      continue;
    }
    if (ARITY[c] === undefined) throw new Error(`unknown command ${cmd}`);
    const v = Array.from({ length: ARITY[c] }, num);
    const px = (n: number) => (rel ? x + n : n);
    const py = (n: number) => (rel ? y + n : n);
    if (c === "h") x = px(v[0]);
    else if (c === "v") y = py(v[0]);
    else if (c === "a") {
      [x, y] = [px(v[5]), py(v[6])];
    } else {
      for (let k = 0; k + 1 < v.length - 2; k += 2) pts.push([px(v[k]), py(v[k + 1])]);
      [x, y] = [px(v[v.length - 2]), py(v[v.length - 1])];
    }
    pts.push([x, y]);
    if (c === "m") {
      [sx, sy] = [x, y];
      cmd = rel ? "l" : "L";
    }
  }
  return pts;
}

/** The furthest any shape's geometry reaches, as boxes to check against the grid. */
function extents(s: GlyphShape): [number, number][] {
  const n = (k: string) => Number(s.attrs[k]);
  switch (s.tag) {
    case "circle":
      return [
        [n("cx") - n("r"), n("cy") - n("r")],
        [n("cx") + n("r"), n("cy") + n("r")],
      ];
    case "ellipse":
      return [
        [n("cx") - n("rx"), n("cy") - n("ry")],
        [n("cx") + n("rx"), n("cy") + n("ry")],
      ];
    case "rect":
      return [
        [n("x"), n("y")],
        [n("x") + n("width"), n("y") + n("height")],
      ];
    case "line":
      return [
        [n("x1"), n("y1")],
        [n("x2"), n("y2")],
      ];
    case "polyline": {
      const v = s.attrs.points.trim().split(/[\s,]+/).map(Number);
      return v.flatMap((_, k) => (k % 2 === 0 ? [[v[k], v[k + 1]] as [number, number]] : []));
    }
    case "path":
      return pathPoints(s.attrs.d);
  }
}

describe("every glyph keeps the standard", () => {
  it.each(NAMES)("%s", (name) => {
    const markup = GLYPHS[name];
    expect(markup.length, "size budget").toBeLessThanOrEqual(BUDGET);
    // Read strictly: only the allowed elements, attributes and paints.
    const shapes = parseGlyph(markup);
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) {
      for (const [k, v] of Object.entries(s.attrs)) {
        expect(GLYPH_ATTRIBUTES[s.tag]).toContain(k);
        if (k === "fill") expect(["currentColor", "none"]).toContain(v);
        if (k === "stroke") expect(v).toBe("none");
      }
      // On the grid, inside its 2-unit padding.
      for (const [x, y] of extents(s)) {
        expect(x, `${s.tag} x`).toBeGreaterThanOrEqual(1.95);
        expect(x, `${s.tag} x`).toBeLessThanOrEqual(22.05);
        expect(y, `${s.tag} y`).toBeGreaterThanOrEqual(1.95);
        expect(y, `${s.tag} y`).toBeLessThanOrEqual(22.05);
      }
    }
    expect(markup).not.toMatch(/<(text|style|script|image|use|a|foreignObject|linearGradient|radialGradient|filter|g)\b/i);
    expect(markup).not.toMatch(/href|url\(|#[0-9a-f]{3}|rgb|style=|on[a-z]+=|transform|opacity/i);

    // As a standalone file it is well-formed SVG with the standard's root.
    const doc = new DOMParser().parseFromString(glyphSvg(name), "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    const svg = doc.documentElement;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
    expect(svg.children).toHaveLength(shapes.length);
  });

  it("refuses what the standard does not allow", () => {
    const refused = [
      '<text x="2" y="12">A</text>',
      '<circle cx="12" cy="12" r="4" fill="red"/>',
      '<circle cx="12" cy="12" r="4" stroke="#000"/>',
      '<circle cx="12" cy="12" r="4" stroke="none"/>',
      '<path d="M2 2h4" style="stroke:red"/>',
      '<path d="M2 2h4" transform="rotate(4)"/>',
      '<path d="url(#x)"/>',
      '<image href="x.png"/>',
      '<script/>',
      '<g><path d="M2 2h4"/></g>',
      '<path d="M2 2h4">',
      'hello<path d="M2 2h4"/>',
      '<path d="M2 2h4" d="M3 3h4"/>',
    ];
    for (const bad of refused) expect(() => parseGlyph(bad), bad).toThrow();
    expect(parseGlyph('\n  <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>\n')).toHaveLength(1);
  });

  it("measures relative and absolute path commands alike (the grid check above relies on it)", () => {
    expect(pathPoints("M2 2l21 0")).toContainEqual([23, 2]);
    expect(pathPoints("M4 4h2v3H3z")).toEqual([
      [4, 4],
      [6, 4],
      [6, 7],
      [3, 7],
    ]);
    expect(pathPoints("M3 3c1 1 2 2 3 0s4 4 5 5")).toContainEqual([10, 7]);
    expect(pathPoints("M3 12q1.5 1.2 3 0t3 0")).toEqual([
      [3, 12],
      [4.5, 13.2],
      [6, 12],
      [9, 12],
    ]);
  });

  it("reads each glyph once and gives nothing for a name that is not one", () => {
    expect(glyphShapes("activity/tennis")).toBe(glyphShapes("activity/tennis"));
    expect(glyphShapes("activity/quidditch")).toBeNull();
    expect(glyphShapes("🏸")).toBeNull();
  });
});

describe("the tiles' tones", () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, "../src/app/globals.css"), "utf8");
  const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, "i"))?.[1];
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  it.each(GLYPH_TONES)("%s is a token with an ink that reads on its ground", (tone) => {
    const ground = token(`tile-${tone}`);
    const ink = token(`tile-${tone}-ink`);
    expect(ground).toBeDefined();
    expect(ink).toBeDefined();
    expect(contrast(ground!, ink!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the export for a designer", () => {
  it("writes every glyph as a standalone SVG file into the folder given", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glyphs-"));
    try {
      const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "../scripts/export-glyphs.mjs"), dir], { encoding: "utf8" });
      expect(out).toContain(`Wrote ${NAMES.length} glyphs`);
      const files = fs.readdirSync(dir).sort();
      expect(files).toHaveLength(NAMES.length);
      expect(files).toContain("activity-badminton.svg");
      expect(fs.readFileSync(path.join(dir, "generic-ball.svg"), "utf8").trim()).toBe(glyphSvg("generic/ball"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an activity's picture, as the server reads it", () => {
  it("takes a glyph an activity may use, or its category's when none is given", () => {
    expect(readIcon("generic/whistle", "team")).toEqual({ ok: true, icon: "generic/whistle" });
    expect(readIcon("activity/padel", "racket")).toEqual({ ok: true, icon: "activity/padel" });
    expect(readIcon(undefined, "studio")).toEqual({ ok: true, icon: "category/studio" });
    expect(readIcon("  ", "water")).toEqual({ ok: true, icon: "category/water" });
  });

  it("still takes a short emoji, as before glyphs, and refuses anything else", () => {
    expect(readIcon("🏑", "team")).toEqual({ ok: true, icon: "🏑" });
    expect(readIcon("🏋️", "fitness")).toEqual({ ok: true, icon: "🏋️" });
    for (const bad of ["business/mixed", "feature/games", "generic/unicorn", "abc", "12", "<svg/>", "🏑🏑🏑🏑🏑🏑🏑🏑🏑", 7, {}])
      expect(readIcon(bad, "team"), String(bad)).toEqual({ ok: false, error: "Choose a picture from the list." });
  });
});
