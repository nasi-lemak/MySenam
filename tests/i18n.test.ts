import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { DICTIONARIES, LOCALES, translator } from "../src/lib/i18n";

const EN = DICTIONARIES.en;
const MS = DICTIONARIES.ms;
const keys = Object.keys(EN) as (keyof typeof EN)[];

/** The {placeholders} a phrase expects, in no particular order. */
function slots(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("the two languages", () => {
  it("has something to say in both", () => {
    expect(keys.length).toBeGreaterThan(200);
    for (const key of keys) {
      expect(MS[key], `${key} is missing from Bahasa Malaysia`).toBeTruthy();
      expect(MS[key].trim(), `${key} is blank in Bahasa Malaysia`).not.toBe("");
    }
  });

  it("was actually translated, not copied", () => {
    // Proper nouns, codes and a handful of loanwords are the same either way;
    // anything beyond a few words should not be.
    const copied = keys.filter(
      (k) => EN[k] === MS[k] && EN[k].split(" ").length > 3
    );
    expect(copied, `these are still English: ${copied.join(", ")}`).toEqual([]);
  });

  it("fills the same holes in both", () => {
    for (const key of keys) {
      expect(slots(MS[key]), `${key} has different placeholders`).toEqual(slots(EN[key]));
    }
  });

  it("gives every counted phrase both forms", () => {
    for (const key of keys) {
      if (key.endsWith("_one")) {
        const other = key.replace(/_one$/, "_other") as keyof typeof EN;
        expect(EN[other], `${key} has no _other beside it`).toBeTruthy();
      }
    }
  });
});

describe("the lookup", () => {
  it("fills placeholders", () => {
    const t = translator("en");
    expect(t("home.fromRate", { rate: 20 })).toBe("from RM20/hr");
  });

  it("picks the singular and the plural", () => {
    const t = translator("en");
    expect(t.plural("home.courts", 1)).toBe("1 court");
    expect(t.plural("home.courts", 4)).toBe("4 courts");
  });

  it("says the same thing in Malay", () => {
    const t = translator("ms");
    expect(t.plural("home.courts", 4)).toBe("4 gelanggang");
    expect(t("home.fromRate", { rate: 20 })).toBe("dari RM20/jam");
  });

  it("falls back to English for an unknown language", () => {
    // @ts-expect-error — deliberately not a Locale, which is what a stale
    // cookie or a hand-edited request actually looks like.
    expect(translator("fr")("nav.classes")).toBe("Classes");
  });

  it("knows every language it offers", () => {
    for (const locale of LOCALES) expect(translator(locale).locale).toBe(locale);
  });
});
