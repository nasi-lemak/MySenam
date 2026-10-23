import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";

let lang: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && lang ? { value: lang } : undefined) }),
}));

import PrivacyPage from "../src/app/privacy/page";

/**
 * The privacy notice names who answers for the data, as PDPA expects, from
 * the same OPERATOR_* settings as the terms; until it can, it says so.
 */
const page = async () => renderToStaticMarkup(await PrivacyPage());

afterEach(() => {
  vi.unstubAllEnvs();
  lang = undefined;
});

describe("the privacy notice", () => {
  it("says there is nobody named to write to until the operator is set", async () => {
    vi.stubEnv("OPERATOR_NAME", "");
    vi.stubEnv("OPERATOR_EMAIL", "");
    const html = await page();
    expect(html).not.toContain("Who to write to");
    expect(html).toContain("there is still no named person to write to");
  });

  it("names the operator, their address and an email to write to", async () => {
    vi.stubEnv("OPERATOR_NAME", "Arena Sukan Sdn Bhd");
    vi.stubEnv("OPERATOR_ADDRESS", "12 Jalan Raja, 50000 Kuala Lumpur");
    vi.stubEnv("OPERATOR_EMAIL", "privacy@arena.my");
    const html = await page();
    expect(html).toContain("Who to write to");
    expect(html).toContain("Arena Sukan Sdn Bhd is responsible for what this site holds about you");
    expect(html).toContain("12 Jalan Raja, 50000 Kuala Lumpur");
    expect(html).toContain('href="mailto:privacy@arena.my"');
    // Still a draft for a lawyer, but no longer missing a contact.
    expect(html).not.toContain("no named person");
    expect(html).toContain("no lawyer has checked it");
  });

  it("does so in Malay too", async () => {
    vi.stubEnv("OPERATOR_NAME", "Arena Sukan Sdn Bhd");
    vi.stubEnv("OPERATOR_EMAIL", "privacy@arena.my");
    lang = "ms";
    const html = await page();
    expect(html).toContain("Siapa yang boleh dihubungi");
    expect(html).toContain("Arena Sukan Sdn Bhd bertanggungjawab");
  });
});
