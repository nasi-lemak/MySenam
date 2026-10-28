import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { isSiteBusy, readJson, SITE_BUSY, siteBusySentence } from "../src/lib/read-response";
import { translateError, translator } from "../src/lib/i18n";
import { staffTranslator } from "../src/lib/staff-i18n";

/**
 * One way to read the app's answers (audit R8 X2-7): what the proxy or an
 * unhandled error sends instead of the app's JSON becomes a refusal said in
 * the reader's language, never "Unexpected token '<'".
 */

const html = (status: number) =>
  new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status, headers: { "Content-Type": "text/html" } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("readJson", () => {
  it("gives the app's own answer as it came, success or refusal", async () => {
    expect(await readJson(json(200, { booking: { code: "MS-ABC123" } }))).toEqual({ booking: { code: "MS-ABC123" } });
    expect(await readJson(json(409, { error: "That time was just taken.", code: "SLOT_TAKEN" }))).toEqual({
      error: "That time was just taken.",
      code: "SLOT_TAKEN",
    });
    // A server error that says something of its own is the app's: a payment page that would not open.
    expect(await readJson(json(502, { error: "The payment page could not be opened." }))).toEqual({ error: "The payment page could not be opened." });
  });

  it("turns the proxy's HTML page into a refusal with a code, not a parser error", async () => {
    for (const status of [502, 503, 504]) {
      const body = await readJson(html(status));
      expect(body).toEqual({ error: siteBusySentence("en"), code: SITE_BUSY });
      expect(isSiteBusy(body)).toBe(true);
    }
    // A 5xx with nothing of the app's to say, or no body at all, is the same.
    expect(isSiteBusy(await readJson(json(500, { ok: false })))).toBe(true);
    expect(isSiteBusy(await readJson(new Response("", { status: 502 })))).toBe(true);
    expect(isSiteBusy(await readJson(new Response("Internal Server Error", { status: 500 })))).toBe(true);
  });

  it("throws, as Response.json() did, where a success status carries no JSON: no caller goes on with an empty body", async () => {
    await expect(readJson(new Response("<html></html>", { status: 200 }))).rejects.toThrow(siteBusySentence("en"));
    await expect(readJson(new Response("", { status: 200 }))).rejects.toThrow(siteBusySentence("en"));
  });

  it("is said in each customer language by its code, and on the staff screens", async () => {
    const body = await readJson(html(502));
    for (const locale of ["en", "ms", "zh", "ta"] as const) {
      const said = translateError(translator(locale), body);
      expect(said).toBe(translator(locale)("err.SITE_BUSY"));
      expect(said).not.toMatch(/Unexpected token|JSON/);
    }
    expect(translateError(translator("ms"), body)).toContain("cuba lagi");
    // Staff read it in their own language through t.err, by the same code.
    expect(staffTranslator("zh").err(body)).toBe(translator("zh")("err.SITE_BUSY"));
    expect(staffTranslator("en").err(body)).toBe(siteBusySentence("en"));
  });
});

describe("every page and staff screen reads answers through it", () => {
  it("no client file parses a response with Response.json() by hand", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const files = ["src/app", "src/components"].flatMap((dir) =>
      fs
        .readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
        .map((e) => path.join(e.parentPath, e.name))
    );
    const byHand = files
      .filter((f) => fs.readFileSync(f, "utf8").startsWith('"use client";'))
      .flatMap((f) =>
        fs
          .readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${path.relative(root, f)}:${i + 1}` }))
          .filter(({ line }) => /\b(?!req\b|request\b)\w+\.json\(\)/.test(line))
          .map(({ at }) => at)
      );
    expect(byHand).toEqual([]);
  });
});
