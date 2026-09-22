import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";

export const dynamic = "force-dynamic";

/** The scannable check-in code for a booking, as an SVG. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || !/^[a-f0-9]{32}$/.test(token))
    return NextResponse.json({ error: "A valid token is required." }, { status: 400 });

  const url = new URL(`/checkin/${token}`, req.nextUrl.origin).toString();
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0f766e", light: "#ffffff" },
  });

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      // The token is a secret, so keep this out of shared caches.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
