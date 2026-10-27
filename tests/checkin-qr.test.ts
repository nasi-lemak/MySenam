import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import QRCode from "qrcode";
import { NextRequest } from "next/server";
import { GET as qr } from "../src/app/api/checkin/qr/route";

/**
 * The check-in QR image (`/api/checkin/qr?token=`): the booking's own
 * check-in link drawn as an SVG, for the door's scanner. The token is the
 * booking's secret, so the image is never kept in a shared cache, and nothing
 * but a well-formed token is drawn.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const ask = (query: string, origin = "https://book.example.my") => qr(new NextRequest(`${origin}/api/checkin/qr${query}`));

describe("the check-in QR image", () => {
  it("is the booking's check-in link on this site, as an SVG", async () => {
    const res = await ask(`?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
    // Exactly the code of the check-in link, in the check-in colours.
    const expected = await QRCode.toString(`https://book.example.my/checkin/${TOKEN}`, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f766e", light: "#ffffff" },
    });
    expect(svg).toBe(expected);
  });

  it("follows the address it was asked on, so a storefront's code opens the storefront", async () => {
    const svg = await (await ask(`?token=${TOKEN}`, "https://courts.abc.my")).text();
    const onStorefront = await QRCode.toString(`https://courts.abc.my/checkin/${TOKEN}`, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f766e", light: "#ffffff" },
    });
    expect(svg).toBe(onStorefront);
    expect(svg).not.toBe(await (await ask(`?token=${TOKEN}`)).text());
  });

  it("is kept out of shared caches, since the token is a secret", async () => {
    const res = await ask(`?token=${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("refuses anything but a 32-character lower-case hex token, drawing nothing", async () => {
    for (const bad of [
      "",
      "?token=",
      "?token=0123456789abcdef",
      `?token=${TOKEN}0`,
      `?token=${TOKEN.toUpperCase()}`,
      `?token=${encodeURIComponent("../../admin/aaaaaaaaaaaaaaaaaaaaaa")}`,
      `?token=${encodeURIComponent(`${TOKEN.slice(0, 31)}<`)}`,
    ]) {
      const res = await ask(bad);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("content-type"), bad).toContain("application/json");
      expect(await res.json(), bad).toEqual({ error: "A valid token is required." });
    }
  });
});
