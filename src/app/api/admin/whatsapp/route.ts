import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { platformAccount } from "@/lib/billing";
import { chatRepliesOn } from "@/lib/outbox";
import {
  creditBalance,
  creditsApply,
  grantCredit,
  listPacks,
  orderPack,
  packById,
  packPrice,
  packSize,
  payPackOnline,
  setWhatsappOn,
  settlePack,
  voidPack,
  whatsappAvailable,
  whatsappOn,
} from "@/lib/whatsapp-credit";
import { usageOf } from "@/lib/whatsapp-usage";

export const dynamic = "force-dynamic";

async function state(venueId: number) {
  return {
    on: await whatsappOn(venueId),
    available: whatsappAvailable(),
    prepaid: creditsApply(),
    balance: await creditBalance(venueId),
    pack: { messages: packSize(), price: packPrice() },
    packs: await listPacks(venueId),
    usage: await usageOf(venueId),
    chatReplies: chatRepliesOn(),
    canPayOnline: platformAccount() !== null,
  };
}

/** `?venueId=` — whether the venue sends WhatsApp, and what it has left to send with. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json(await state(venueId));
}

/**
 * `{ venueId, action }`:
 * - `"on"` / `"off"` — the venue's staff;
 * - `"buy"` — order a pack, then `"pay", packId` to pay it online;
 * - `"grant", messages` / `"markPaid" | "void", packId` — the platform owner.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  if (b.action === "on" || b.action === "off") {
    await setWhatsappOn(venueId, b.action === "on");
    return NextResponse.json(await state(venueId));
  }
  if (b.action === "buy") {
    if (!creditsApply()) return NextResponse.json({ error: "Nothing to buy: this install pays Meta itself." }, { status: 400 });
    const pack = await orderPack(venueId, admin.id);
    return NextResponse.json({ ...(await state(venueId)), ordered: pack });
  }
  const pack = Number.isInteger(b.packId) ? await packById(b.packId as number) : null;
  if (b.action === "pay") {
    if (!pack || pack.venueId !== venueId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const paid = await payPackOnline(pack.id, { name: admin.name, email: admin.email });
    if (!paid.ok) return NextResponse.json({ error: paid.error }, { status: paid.status });
    return NextResponse.json({ url: paid.url });
  }

  if (!isOwner(admin)) return NextResponse.json({ error: "Only the platform owner can do that." }, { status: 403 });
  if (b.action === "grant") {
    const granted = await grantCredit(venueId, Number(b.messages), admin.id);
    if (!granted.ok) return NextResponse.json({ error: granted.error }, { status: 400 });
    return NextResponse.json(await state(venueId));
  }
  if (b.action === "markPaid" || b.action === "void") {
    if (!pack || pack.venueId !== venueId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = b.action === "markPaid" ? await settlePack(pack.id, "manual", admin.id) : await voidPack(pack.id);
    if (!done) return NextResponse.json({ error: "That pack is not waiting to be paid." }, { status: 409 });
    return NextResponse.json(await state(venueId));
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
