import { NextRequest, NextResponse } from "next/server";
import { addMonths, planById, type MembershipPlan } from "@/lib/membership-plans";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, MEMBERSHIP_LIST_STATUSES, searchMembershipsForVenue, sellMembership } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { selectionAtVenue } from "@/lib/participant-bookings";
import { isRefusal } from "@/lib/participants";
import { asStaff } from "@/lib/acting-staff";
import { counterPrice, priceOverridesFor } from "@/lib/counter-prices";
import { paidVia } from "@/lib/documents";
import { readListQuery } from "@/lib/list-search";
import { addDays, isValidDateString } from "@/lib/time";
import { COUNTER_METHODS, PAID_VIA_LABELS, type CounterMethod } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * `?venueId&q?&status?&page?`: a venue's memberships, newest first, fifty at a time, found by code, name or number
 * and by status (`active`, `lapsing` within 30 days, `upcoming`, `expired`, `cancelled`; lib/list-search.ts), each
 * with the price a manager set where it was not the plan's.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const query = readListQuery(req.nextUrl.searchParams, MEMBERSHIP_LIST_STATUSES);
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });

  const found = await searchMembershipsForVenue(venueId, query);
  const set = await priceOverridesFor("membership", found.items.map((m) => m.id));
  return NextResponse.json({ memberships: found.items.map((m) => ({ ...m, priceSet: set.get(m.id) ?? null })), page: found.page, more: found.more });
}

/**
 * `{ venueId, holderName, holderPhone, startsOn, tierId?, expiresOn?, price?, priceReason?, via, accountEmail?,
 * holderParticipantId?, covers? }`: sell a membership on one of the venue's plans (`tierId`), at its fee and for its
 * months from `startsOn`; another price or term, or none of the plans, only by a manager with `priceReason`
 * (lib/counter-prices.ts). `via`: how the money was taken (cash, qr, transfer or card), required unless it is free.
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

  // On one of the venue's plans, for its benefits (a tier), its fee and its months: any plan offered here.
  let plan: MembershipPlan | null = null;
  if (input.tierId !== undefined && input.tierId !== null) {
    plan = Number.isInteger(input.tierId) ? await planById(input.tierId as number) : null;
    if (!plan || plan.venueId !== venueId) return NextResponse.json({ error: "That plan is not offered here." }, { status: 400 });
  }
  // The plan's term from the day it starts; the end may be left to it.
  const term = plan && typeof input.startsOn === "string" && isValidDateString(input.startsOn) ? addDays(addMonths(input.startsOn, plan.months), -1) : null;
  if (term && (input.expiresOn === undefined || input.expiresOn === null || input.expiresOn === "")) input.expiresOn = term;

  for (const field of ["holderName", "holderPhone", "startsOn", "expiresOn"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }

  // At the plan's fee and for its term; anything else is a manager's, with a reason (lib/counter-prices.ts).
  const priced = counterPrice({
    seller: admin,
    listPrice: plan ? plan.price : null,
    asked: input.price,
    termDiffers: plan !== null && input.expiresOn !== term,
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

  // Whose it is, and whom else it covers (ADR 0025): participants the venue knows, each with a
  // guardian on the holder's number, named as it is sold. Never inferred from a number or a surname.
  const named = (raw: unknown): number[] | null =>
    raw === undefined || raw === null ? [] : Array.isArray(raw) && raw.every((x) => Number.isInteger(x) && x > 0) ? (raw as number[]) : null;
  const holder = named(input.holderParticipantId === undefined || input.holderParticipantId === null ? null : [input.holderParticipantId]);
  const covered = named(input.covers);
  if (holder === null || covered === null)
    return NextResponse.json({ error: "holderParticipantId is a participant's id, and covers a list of them." }, { status: 400 });
  let people: { id: number; name: string }[] = [];
  if (holder.length + covered.length > 0) {
    const known = await selectionAtVenue(venueId as number, input.holderPhone as string, [...holder, ...covered], false);
    if (isRefusal(known)) return NextResponse.json({ error: known.error, code: known.code, ...(known.vars ? { vars: known.vars } : {}) }, { status: known.status });
    people = known.participants;
  }

  // As the member of staff selling it, so its receipt says who took the money (lib/acting-staff.ts).
  const result = await asStaff(admin, () =>
    sellMembership({
      holderParticipantId: holder[0] ?? null,
      covers: covered,
      tierId: plan?.id,
      venueId: venueId as number,
      holderName: input.holderName as string,
      holderPhone: input.holderPhone as string,
      startsOn: input.startsOn as string,
      expiresOn: input.expiresOn as string,
      price: priced.price,
      adminId: admin.id,
      userId,
      paidVia: paidVia(via as string | null) ?? undefined,
      priceOverride: priced.override,
    })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "membership.sold",
    detail: `${input.holderName as string}${
      holder.length > 0 ? ` for ${people.find((p) => p.id === holder[0])?.name ?? "a participant"}` : ""
    }${covered.length > 0 ? `, covering ${people.filter((p) => covered.includes(p.id)).map((p) => p.name).join(", ")}` : ""}${plan ? `, ${plan.name}` : ""}, ${money(priced.price)}${
      via ? ` by ${PAID_VIA_LABELS[via as CounterMethod]}` : ""
    }, ${input.startsOn as string} to ${input.expiresOn as string}`,
  });
  if (priced.override)
    await logAction(admin, {
      venueId: venueId as number,
      action: "sale.price_set",
      detail: `Membership ${result.membership.code}: ${money(priced.price)}${priced.override.listPrice !== null ? ` (plan ${money(priced.override.listPrice)})` : " (no plan)"}${
        term && input.expiresOn !== term ? `, until ${input.expiresOn as string} (plan ${term})` : ""
      }: ${priced.override.reason}`,
    });
  return NextResponse.json({ membership: result.membership }, { status: 201 });
}
