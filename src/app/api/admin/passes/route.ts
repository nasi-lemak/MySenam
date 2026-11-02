import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, issuePass, PASS_LIST_STATUSES, searchPassesForVenue } from "@/lib/store";
import { COUNTER_METHODS, MAX_PASS_ENTRIES, MAX_PASS_MINUTES, PAID_VIA_LABELS, Sport, type CounterMethod } from "@/lib/types";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { asStaff } from "@/lib/acting-staff";
import { counterPrice, priceOverridesFor } from "@/lib/counter-prices";
import { paidVia } from "@/lib/documents";
import { readListQuery } from "@/lib/list-search";
import { passProductAt, productExpiry, type PassProduct } from "@/lib/pass-products";
import { todayISO } from "@/lib/time";
import { isScope, PASS_SCOPES } from "@/lib/entitlements";
import { selectionAtVenue } from "@/lib/participant-bookings";
import { isRefusal } from "@/lib/participants";

export const dynamic = "force-dynamic";

/**
 * `?venueId&q?&status?&page?`: passes issued by one venue, newest first, fifty at a time, found by code, name or
 * number and by status (lib/list-search.ts), each with the price a manager set where it was not the product's.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const query = readListQuery(req.nextUrl.searchParams, PASS_LIST_STATUSES);
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });

  const found = await searchPassesForVenue(venueId, query);
  const set = await priceOverridesFor("pass", found.items.map((p) => p.id));
  return NextResponse.json({ passes: found.items.map((p) => ({ ...p, priceSet: set.get(p.id) ?? null })), page: found.page, more: found.more });
}

/**
 * `{ venueId, holderName, holderPhone, accountEmail?, holderParticipantId?, via, productId? | (name, kind?, entries,
 * entryMinutes?, maxMinutes?, sport?, coachId?, scope?, expiresOn), price?, expiresOn?, priceReason? }`: sell a pass.
 * From one of the venue's pass products (lib/pass-products.ts) at its price and for its term; another price or term,
 * or a pass that is not on the list, only by a manager with `priceReason` (lib/counter-prices.ts). `via`: how the
 * money was taken (cash, qr, transfer or card), required unless it is free.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const venueId = input.venueId;
  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;

  // From the venue's list: its terms and price, the term running from today.
  let product: PassProduct | null = null;
  if (input.productId !== undefined && input.productId !== null) {
    product = Number.isInteger(input.productId) ? await passProductAt(venueId as number, input.productId as number) : null;
    if (!product) return NextResponse.json({ error: "That pass is not on the venue's list." }, { status: 400 });
  }
  const term = product ? productExpiry(product, todayISO()) : null;
  if (product && (input.expiresOn === undefined || input.expiresOn === null || input.expiresOn === "")) input.expiresOn = term;

  for (const field of [...(product ? [] : (["name"] as const)), "holderName", "holderPhone", "expiresOn"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }
  // A session pass sells entries; a time pass, minutes of court time (`entries` either way).
  const kind = product ? product.kind : input.kind === undefined || input.kind === null || input.kind === "" ? "session" : input.kind;
  if (kind !== "session" && kind !== "time")
    return NextResponse.json({ error: "kind must be session or time." }, { status: 400 });
  const entries = product ? product.entries : input.entries;
  const most = kind === "time" ? MAX_PASS_MINUTES : MAX_PASS_ENTRIES;
  if (!Number.isInteger(entries) || (entries as number) < 1 || (entries as number) > most)
    return NextResponse.json(
      { error: kind === "time" ? `Court time must be 1–${most} minutes.` : `Entries must be 1–${most}.` },
      { status: 400 }
    );
  // Minutes an entry covers (null: a whole booking), and the longest booking it pays for (null: any).
  const optionalMinutes = (v: unknown): number | null | undefined | false =>
    v === undefined ? undefined : v === null || v === "" ? null : Number.isInteger(v) ? (v as number) : false;
  const entryMinutes = product ? product.entryMinutes : optionalMinutes(input.entryMinutes);
  const maxMinutes = product ? product.maxMinutes : optionalMinutes(input.maxMinutes);
  if (entryMinutes === false || maxMinutes === false)
    return NextResponse.json({ error: "entryMinutes and maxMinutes are whole minutes, or null." }, { status: 400 });

  let sport: Sport | null = product ? (product.sport as Sport | null) : null;
  if (!product && input.sport !== undefined && input.sport !== null && input.sport !== "") {
    if (!(await isActivity(input.sport)))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
    sport = input.sport as Sport;
  }

  // At the product's price and for its term; anything else is a manager's, with a reason (lib/counter-prices.ts).
  const priced = counterPrice({
    seller: admin,
    listPrice: product ? product.price : null,
    asked: input.price,
    termDiffers: product !== null && input.expiresOn !== term,
    reason: input.priceReason,
  });
  if (!priced.ok) return NextResponse.json({ error: priced.error, code: priced.code }, { status: priced.status });
  // How the money was taken: asked for anything not free.
  const via = input.via === undefined || input.via === null || input.via === "" ? null : input.via;
  if (via !== null && !COUNTER_METHODS.includes(via as CounterMethod))
    return NextResponse.json({ error: `via must be one of ${COUNTER_METHODS.join(", ")}.` }, { status: 400 });
  if (via === null && priced.price > 0) return NextResponse.json({ error: "Say how it was paid.", code: "P8B_VIA_REQUIRED" }, { status: 400 });


  // Optionally tie the sale to an account, so it shows on that customer's own
  // page. Staff key it on an email the person just gave them, standing there —
  // a phone number would let whoever registered it first claim the pass.
  let userId: number | undefined;
  if (typeof input.accountEmail === "string" && input.accountEmail.trim() !== "") {
    const account = await findAccountByEmail(input.accountEmail);
    if (!account)
      return NextResponse.json(
        { error: "No account has that email address. Leave it blank to sell without one." },
        { status: 400 }
      );
    userId = account.id;
  }

  // What one use covers (lib/entitlements.ts): the booking as a whole unless said.
  const scope = product ? product.scope : input.scope === undefined || input.scope === null || input.scope === "" ? "booking" : input.scope;
  if (!isScope(scope, PASS_SCOPES))
    return NextResponse.json({ error: "scope must be booking, resource, participant or places." }, { status: 400 });
  // One person's pass, held for a participant the venue knows, with a guardian on the holder's number.
  let holderParticipantId: number | null = null;
  if (input.holderParticipantId !== undefined && input.holderParticipantId !== null) {
    if (scope !== "participant")
      return NextResponse.json({ error: "Only a pass for one person's place is held for somebody else." }, { status: 400 });
    const known = await selectionAtVenue(venueId as number, input.holderPhone as string, [input.holderParticipantId as number], false);
    if (isRefusal(known)) return NextResponse.json({ error: known.error, code: known.code, ...(known.vars ? { vars: known.vars } : {}) }, { status: known.status });
    holderParticipantId = known.participants[0].id;
  }

  // As the member of staff selling it, so its receipt says who took the money (lib/acting-staff.ts).
  const result = await asStaff(admin, () =>
    issuePass({
      scope,
      holderParticipantId,
      venueId: venueId as number,
      sport,
      name: product ? product.name : (input.name as string),
      kind,
      entries: entries as number,
      entryMinutes,
      maxMinutes,
      price: priced.price,
      holderName: input.holderName as string,
      holderPhone: input.holderPhone as string,
      expiresOn: input.expiresOn as string,
      adminId: admin.id,
      userId,
      coachId: product ? product.coachId : Number.isInteger(input.coachId) ? (input.coachId as number) : null,
      paidVia: paidVia(via as string | null),
      productId: product?.id ?? null,
      priceOverride: priced.override,
      dayPass: product?.dayPass ?? false,
    })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logAction(admin, {
    venueId: result.pass.venueId,
    action: "pass.sold",
    detail: `${input.holderName as string}, ${product ? `${product.name}, ` : ""}${entries as number} ${kind === "time" ? "minutes" : "entries"}, ${money(priced.price)}${via ? `, by ${PAID_VIA_LABELS[via as CounterMethod]}` : ""}`,
  });
  if (priced.override)
    await logAction(admin, {
      venueId: result.pass.venueId,
      action: "sale.price_set",
      detail: `Pass ${result.pass.code}: ${money(priced.price)}${priced.override.listPrice !== null ? ` (list ${money(priced.override.listPrice)})` : " (not on the list)"}${input.expiresOn !== term && term ? `, until ${input.expiresOn as string} (list ${term})` : ""}: ${priced.override.reason}`,
    });
  return NextResponse.json({ pass: result.pass }, { status: 201 });
}
