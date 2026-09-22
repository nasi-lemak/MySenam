import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { paySeries, setPaymentStatus } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, seriesCode, paid } = (body ?? {}) as Record<string, unknown>;

  if (typeof seriesCode === "string" && seriesCode.trim() !== "") {
    const result = paySeries(seriesCode);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ paid: result.paid });
  }

  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code or seriesCode is required." }, { status: 400 });
  if (typeof paid !== "boolean")
    return NextResponse.json({ error: "paid must be true or false." }, { status: 400 });

  const result = setPaymentStatus(code, paid);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ booking: result.booking });
}
