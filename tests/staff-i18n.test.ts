import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { STAFF_AREAS, STAFF_DICTIONARIES, STAFF_REFUSALS, staffRefusal, staffTranslator } from "../src/lib/staff-i18n";

/**
 * The staff dashboard in English, Malay and Chinese (lib/staff-i18n).
 *
 * Two checks. The dictionaries agree with each other: every key in all three
 * languages with the same placeholders, no key in two areas, Chinese in
 * simplified characters. And no screen shows English that bypasses them: the
 * dashboard's source is parsed and every piece of text a person would read is
 * listed, so a screen added in English fails here rather than in front of a
 * Malay-speaking manager.
 *
 * `STAFF_I18N_FILES=a.tsx,b.tsx` limits the second check to those files.
 */

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the staff dictionaries", () => {
  it("give every phrase in Malay and Chinese, with the same placeholders, and no key in two areas", () => {
    const owner = new Map<string, string>();
    for (const [area, dict] of Object.entries(STAFF_AREAS)) {
      for (const key of Object.keys(dict.en)) {
        expect(owner.get(key), `${key} is in ${owner.get(key)} and ${area}`).toBeUndefined();
        owner.set(key, area);
        const en = (dict.en as Record<string, string>)[key];
        for (const l of ["ms", "zh"] as const) {
          const said = (dict[l] as Record<string, string>)[key];
          expect(said, `${key} in ${l}`).toBeTruthy();
          expect(placeholders(said), `${key} in ${l}: placeholders`).toEqual(placeholders(en));
        }
      }
      for (const l of ["ms", "zh"] as const)
        for (const key of Object.keys(dict[l])) expect(key in dict.en, `${key} in ${l} but not in English`).toBe(true);
    }
  });

  it("give the server's English refusals in Malay and Chinese, with the same values in the same places", () => {
    const slots = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();
    for (const [en, said] of Object.entries(STAFF_REFUSALS))
      for (const l of ["ms", "zh"] as const) {
        expect(said[l], `${en} in ${l}`).toBeTruthy();
        expect(slots(said[l]), `${en} in ${l}: values`).toEqual(slots(en));
      }
    // A pattern fills the server's values back in.
    const pattern = Object.keys(STAFF_REFUSALS).find((en) => en.includes("{0}") && !en.includes("{1}"));
    if (pattern) {
      const sent = pattern.replace("{0}", "42");
      expect(staffRefusal(sent, "ms")).toBe(STAFF_REFUSALS[pattern].ms.replace("{0}", "42"));
    }
    expect(staffRefusal("Nothing the server ever says.", "zh")).toBeNull();
  });

  it("name an e-invoice whose outcome at LHDN is unknown as needing verification in all three languages, never as not sent (R10B)", () => {
    const words = { en: "Needs verification", ms: "Perlu pengesahan", zh: "待核实" } as const;
    for (const locale of ["en", "ms", "zh"] as const) {
      const t = staffTranslator(locale);
      expect(t("ei10.status.unknown")).toBe(words[locale]);
      // The badge, the box's heading and what to do next never say "not sent" (whose own words are `einv.status.failed`).
      const notSent = t("einv.status.failed");
      for (const key of ["ei10.status.unknown", "ei10.unknownTitle", "ei10.next.unknown", "ei10.explain", "ei10.explainLegacy", "ei10.alert.s"] as const)
        expect(t(key, { code: "X", when: "now" })).not.toContain(notSent);
      expect(t("ei10.alert.b", { code: "EI-1", venue: "Hall" })).toContain("EI-1");
      for (const event of ["claimed", "sent", "rejected", "not_sent", "outcome_unknown", "confirmed_not_at_lhdn", "recorded_from_portal"] as const)
        expect(t(`ei10.hist.${event}`)).not.toBe(`ei10.hist.${event}`);
    }
  });

  it("write Chinese in simplified characters", () => {
    // Common characters whose traditional form differs; none may appear.
    const traditional = /[們個會員價錢費號碼確認請與為對還開關門點東網頁帳顯場時間這預訂課練賽聯單設選擇區條約資訊應該現發記錄]/;
    for (const [key, text] of Object.entries(STAFF_DICTIONARIES.zh)) expect(traditional.test(text), `${key}: ${text}`).toBe(false);
    for (const [en, said] of Object.entries(STAFF_REFUSALS)) expect(traditional.test(said.zh), `${en}: ${said.zh}`).toBe(false);
  });

  it("fill placeholders, count, and say a refusal in the staff language", () => {
    const zh = staffTranslator("zh", "MySenam");
    expect(zh.plural("c.days", 3)).toBe("3 天");
    expect(staffTranslator("ms", "MySenam").plural("c.days", 1)).toBe("1 hari");
    expect(zh("c.via.qr")).toContain("/");
    // A refusal with a code reads in the staff language; one without stays as sent.
    expect(staffTranslator("ms", "MySenam").err({ error: "That time slot has already passed.", code: "SLOT_PAST" })).toBe("Waktu itu sudah berlalu.");
    expect(zh.err({ error: "Something only the server says." })).toBe("Something only the server says.");
    expect(zh.err(null)).toBe(zh("c.failed"));
    // The same object each time, so it can sit in a hook's dependencies.
    expect(staffTranslator("zh", "MySenam")).toBe(zh);
  });
});

// ------------------------------------------------------------------ the scan

const ROOTS = ["src/components/admin", "src/app/admin"];
/** Names and marks that read the same in every language. */
const SAME_EVERYWHERE = new Set(["WhatsApp", "Billplz", "Stripe", "MyInvois", "DuitNow", "PayNow", "Google", "Backblaze", "QR", "SST", "GST", "PDF", "CSV", "iCal", "OK", "ID", "TIN", "URL", "API", "SMS", "MySenam"]);
const USER_ATTRIBUTES = new Set(["placeholder", "title", "aria-label", "alt", "label"]);
const USER_PROPERTIES = new Set(["label", "title", "hint", "help", "description", "placeholder", "text", "note", "summary", "message", "notice", "heading", "blurb", "explain", "why"]);
const USER_CALLS = /^(confirm|alert|prompt|set(Error|Notice|Message|Info|Warning|Done|Result|Status|Saved|Flash|Feedback|Problem|Hint))$/;

function files(): string[] {
  const only = process.env.STAFF_I18N_FILES?.split(",").map((f) => f.trim()).filter(Boolean);
  if (only?.length) return only;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) out.push(p);
    }
  };
  ROOTS.forEach(walk);
  return out.sort();
}

/** Whether a piece of text is something a person reads, rather than a class name, a key or a code. */
function readable(text: string): boolean {
  const t = text.trim();
  if (!/[A-Za-z]{2,}/.test(t)) return false;
  if (SAME_EVERYWHERE.has(t)) return false;
  if (/^(\/|https?:|mailto:|tel:|#)/.test(t)) return false;
  // Tailwind classes, identifiers, keys and codes.
  if (/^[a-z0-9:_./[\]-]+( [a-z0-9:_./[\]!-]+)*$/.test(t) && !/^[a-z]+( [a-z]+){2,}$/.test(t)) return false;
  if (/^[A-Z0-9_]+$/.test(t)) return false;
  return /\s/.test(t) || /^[A-Z][a-z]/.test(t) || /^[a-z]{3,}$/.test(t);
}

function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
  return null;
}

/** Up through ?:, ||, ?? and brackets: where a literal ends up. */
function landing(node: ts.Node): ts.Node {
  let n = node.parent;
  while (n && (ts.isConditionalExpression(n) || ts.isBinaryExpression(n) || ts.isParenthesizedExpression(n) || ts.isTemplateSpan(n) || ts.isTemplateExpression(n))) n = n.parent;
  return n;
}

function shown(node: ts.Node): boolean {
  const at = landing(node);
  if (!at) return false;
  if (ts.isJsxExpression(at)) {
    const holder = at.parent;
    if (ts.isJsxAttribute(holder)) return USER_ATTRIBUTES.has(holder.name.getText());
    return true;
  }
  if (ts.isJsxAttribute(at)) return USER_ATTRIBUTES.has(at.name.getText());
  if (ts.isCallExpression(at)) {
    const callee = at.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    return USER_CALLS.test(name);
  }
  if (ts.isPropertyAssignment(at)) return USER_PROPERTIES.has(at.name.getText().replace(/["']/g, ""));
  return false;
}

function scan(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split("\n");
  const ignored = (pos: number) => {
    const line = ts.getLineAndCharacterOfPosition(sf, pos).line;
    return /staff-i18n-ignore/.test(lines[line] ?? "") || /staff-i18n-ignore/.test(lines[line - 1] ?? "");
  };
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isJsxText(node)) text = node.text.replace(/\s+/g, " ").trim();
    else if ((text = staticText(node)) !== null && !shown(node)) text = null;
    if (text && readable(text) && !ignored(node.getStart(sf))) {
      const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf));
      found.push(`${file}:${line + 1}: ${text.slice(0, 80)}`);
    }
    // A template's parts are judged as the whole template.
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("the staff screens", () => {
  it("show no text that bypasses the staff dictionaries", () => {
    const found = files().flatMap(scan);
    if (found.length) console.log(`${found.length} untranslated:\n${found.join("\n")}`);
    expect(found).toEqual([]);
  });
});
