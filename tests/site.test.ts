import { afterEach, describe, expect, it } from "vitest";
import { DICTIONARIES, LOCALES, translator } from "../src/lib/i18n";
import { DEFAULT_SITE_NAME, siteName } from "../src/lib/site";
import { googleCalendarUrl, icsContent, whatsappShareUrl } from "../src/lib/booking-links";

/**
 * One codebase, many names: the MySenam marketplace, and each venue business's
 * own copy under its own name.
 */

afterEach(() => delete process.env.SITE_NAME);

describe("the site's name", () => {
  it("is MySenam unless the install says otherwise", () => {
    expect(siteName()).toBe(DEFAULT_SITE_NAME);
    process.env.SITE_NAME = "  Arena Sports  ";
    expect(siteName()).toBe("Arena Sports");
    process.env.SITE_NAME = "   ";
    expect(siteName()).toBe(DEFAULT_SITE_NAME);
  });

  it("fills every phrase that names the site, in both languages", () => {
    process.env.SITE_NAME = "Arena Sports";
    for (const locale of LOCALES) {
      const t = translator(locale);
      expect(t.site).toBe("Arena Sports");
      expect(t("meta.title")).toContain("Arena Sports");
      expect(t("checkin.back")).toContain("Arena Sports");
      expect(t("privacy.metaTitle")).toContain("Arena Sports");
    }
  });

  it("is never written into a phrase directly", () => {
    for (const locale of LOCALES)
      for (const [key, text] of Object.entries(DICTIONARIES[locale]))
        expect(text, `${locale} ${key}`).not.toContain("MySenam");
  });

  it("can be handed to a translator in the browser, which cannot read the server's settings", () => {
    expect(translator("ms", "Arena Sports")("checkin.back")).toBe("Kembali ke Arena Sports");
  });

  it("names the site in what a customer shares", () => {
    const info = {
      siteName: "Arena Sports",
      code: "MS-ABC123",
      date: "2026-10-20",
      startHour: 10,
      endHour: 11,
      courtName: "Court 1",
      venueName: "Arena",
      totalPrice: 20,
    };
    expect(decodeURIComponent(whatsappShareUrl(info))).toContain("Court booked on Arena Sports!");
    expect(new URL(googleCalendarUrl(info)).searchParams.get("details")).toContain(
      "Arena Sports booking MS-ABC123"
    );
    expect(icsContent(info)).toContain("PRODID:-//Arena Sports//Booking//EN");
    // Without one, it is MySenam, as it always was.
    expect(decodeURIComponent(whatsappShareUrl({ ...info, siteName: undefined }))).toContain(
      "Court booked on MySenam!"
    );
  });
});
