import { afterEach, describe, expect, it } from "vitest";
import { currencySymbol, isoOffset, money, region } from "../src/lib/region";
import { offeredLocales, translator } from "../src/lib/i18n";
import { PAID_VIA_LABELS } from "../src/lib/types";
import { inCountry } from "../src/lib/geo";
import { todayISO } from "../src/lib/time";

/** One install per country: what MYSENAM_COUNTRY changes. */

afterEach(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("Malaysia, the default", () => {
  it("is ringgit, Billplz, English and Malay", () => {
    expect(region().country).toBe("MY");
    expect(money(25)).toBe("RM25");
    expect(offeredLocales()).toEqual(["en", "ms"]);
    const t = translator("en");
    expect(t("pay.how")).toBe("FPX online banking or card, through Billplz. Or pay at the counter as usual.");
    expect(translator("ms")("pay.how")).toBe("Perbankan dalam talian FPX atau kad, melalui Billplz. Atau bayar di kaunter seperti biasa.");
    expect(t("home.fromRate", { rate: 15 })).toContain("RM15");
    expect(PAID_VIA_LABELS.qr).toBe("DuitNow QR / e-wallet");
  });
});

describe("Singapore", () => {
  it("is dollars, Stripe and English, on Singapore's map and clock", () => {
    process.env.MYSENAM_COUNTRY = "SG";
    expect(money(18.5)).toBe("S$18.50");
    expect(money(4.8 * 3)).toBe("S$14.40");
    expect(money(20)).toBe("S$20");
    expect(currencySymbol()).toBe("S$");
    expect(offeredLocales()).toEqual(["en"]);
    const t = translator("en");
    expect(t("pay.how")).toBe("Card or PayNow, through Stripe. Or pay at the counter as usual.");
    expect(t("home.fromRate", { rate: 15 })).toContain("S$15");
    expect(t("home.fromRate", { rate: 4.8 })).toContain("S$4.80");
    expect(t("footer.tagline")).toContain("courts, gyms and classes, one booking");
    expect(t("auth.phonePlaceholder")).toBe("9123 4567");
    expect(t("near.placeholder")).toContain("Tampines");
    expect(PAID_VIA_LABELS.qr).toBe("PayNow QR / e-wallet");
    expect(inCountry({ lat: 1.3, lng: 103.85 })).toBe(true);
    expect(inCountry({ lat: 3.14, lng: 101.69 })).toBe(false); // Kuala Lumpur
    expect(region().timeZone).toBe("Asia/Singapore");
    expect(isoOffset()).toBe("+08:00");
    expect(todayISO()).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(new Date()));
  });

  it("falls back to Malaysia for a country it does not know", () => {
    process.env.MYSENAM_COUNTRY = "XX";
    expect(region().country).toBe("MY");
  });
});

describe("the pricing suggestion", () => {
  it("is in the install's own currency", async () => {
    const { suggestedTiers } = await import("../src/lib/plans");
    expect(suggestedTiers().tiers[0].monthlyFee).toBe(19.9);
    process.env.MYSENAM_COUNTRY = "SG";
    expect(suggestedTiers().tiers.map((t) => t.monthlyFee)).toEqual([29, 59, 99, 149]);
  });
});
