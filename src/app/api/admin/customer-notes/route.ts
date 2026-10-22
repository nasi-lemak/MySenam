import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { customerNote, setCustomerNote } from "@/lib/customer-notes";
import { phoneKey } from "@/lib/phone";

export const dynamic = "force-dynamic";

async function staffAt(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? { admin, venueId };
}

/** `?venueId&phone` → the venue's note on that customer (lib/customer-notes.ts). */
export async function GET(req: NextRequest) {
  const at = await staffAt(req, req.nextUrl.searchParams.get("venueId"));
  if (at instanceof NextResponse) return at;
  return NextResponse.json(
    { note: await customerNote(at.venueId, req.nextUrl.searchParams.get("phone") ?? "") },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** `{ venueId, phone, note }`: write it; an empty note takes it away. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const at = await staffAt(req, body.venueId);
  if (at instanceof NextResponse) return at;
  const phone = typeof body.phone === "string" ? body.phone : "";
  const saved = await setCustomerNote(at.venueId, phone, body.note, at.admin.id);
  if (!saved.ok) return NextResponse.json(saved, { status: 400 });
  await logAction(at.admin, {
    venueId: at.venueId,
    action: "customer.note",
    detail: `${saved.note ? "Note on" : "Note taken off"} a number ending ${phoneKey(phone).slice(-4)}`,
  });
  return NextResponse.json({ note: saved.note });
}
