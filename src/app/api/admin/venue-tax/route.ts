import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { region } from "@/lib/region";
import { setVenueTax, venueTax } from "@/lib/tax";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → the venue's own tax, and the country's usual one to start from. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ tax: await venueTax(venueId), usual: region().tax });
}

/** `{ venueId, registered, name, rate, regNo }`. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const result = await setVenueTax(venueId, { registered: body.registered, name: body.name, rate: body.rate, regNo: body.regNo });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: result.tax.registered ? `${result.tax.name}: ${result.tax.rate}%, no. ${result.tax.regNo}` : "Not registered for tax",
  });
  return NextResponse.json({ tax: result.tax });
}
