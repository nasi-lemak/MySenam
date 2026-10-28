import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createPassProduct, listPassProducts, retirePassProduct } from "@/lib/pass-products";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

function venueParam(req: NextRequest): number | null {
  const id = Number(req.nextUrl.searchParams.get("venueId"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `?venueId`: the passes the venue sells over the counter, each with its terms and price (lib/pass-products.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueParam(req);
  if (!venueId) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ products: await listPassProducts(venueId) });
}

/**
 * `{ venueId, name, kind?, entries, entryMinutes?, maxMinutes?, sport?, coachId?, scope?, price, validDays }`: a manager
 * adds a pass to the venue's list (lib/roles.ts).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = body?.venueId;
  if (!body || !Number.isInteger(venueId) || (venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const made = await createPassProduct(venueId as number, body, admin.id);
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  const p = made.product;
  await logAction(admin, {
    venueId: venueId as number,
    action: "pass_product.added",
    detail: `${p.name}: ${p.entries} ${p.kind === "time" ? "minutes" : "entries"}, ${p.validDays} days, ${money(p.price)}`,
  });
  return NextResponse.json({ product: p }, { status: 201 });
}

/** `?venueId=&id=`: stop selling one. Passes sold from it run their course. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueParam(req);
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!venueId || !Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const gone = await retirePassProduct(venueId, id);
  if (!gone) return NextResponse.json({ error: "That pass is not on the venue's list." }, { status: 404 });
  await logAction(admin, { venueId, action: "pass_product.retired", detail: `${gone.name}, ${money(gone.price)}` });
  return NextResponse.json({ ok: true });
}
