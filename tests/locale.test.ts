import { describe, expect, it, vi } from "vitest";

/**
 * Which language a request is in.
 *
 * `cookies()` comes from Next and needs a request to read, so it is stubbed —
 * what is being checked is the decision made about its value, including the
 * ones a stale or hand-edited cookie can produce.
 */
const cookieValue = { current: undefined as string | undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ms_lang" && cookieValue.current !== undefined
        ? { name, value: cookieValue.current }
        : undefined,
  }),
}));

const { currentLocale, serverT } = await import("../src/lib/locale");

describe("the language of a request", () => {
  it("is English when nothing says otherwise", async () => {
    cookieValue.current = undefined;
    expect(await currentLocale()).toBe("en");
  });

  it("is whatever the cookie asked for", async () => {
    cookieValue.current = "ms";
    expect(await currentLocale()).toBe("ms");
  });

  it("falls back rather than trusting a cookie that says anything at all", async () => {
    for (const nonsense of ["fr", "", "EN", "ms-MY", "../../etc/passwd", "en,ms"]) {
      cookieValue.current = nonsense;
      expect(await currentLocale(), `accepted "${nonsense}"`).toBe("en");
    }
  });

  it("hands a server component a lookup in that language", async () => {
    cookieValue.current = "ms";
    expect((await serverT())("nav.classes")).toBe("Kelas");
    cookieValue.current = "en";
    expect((await serverT())("nav.classes")).toBe("Classes");
  });
});
