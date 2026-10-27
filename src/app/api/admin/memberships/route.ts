import { NextRequest, NextResponse } from "next/server";
import { planById } from "@/lib/membership-plans";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, listMembershipsForVenue, sellMembership } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { money, region, isAmount } from "@/lib/region";
import { selectionAtVenue } from "@/lib/participant-bookings";
import { isRefusal } from "@/lib/participants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  return NextResponse.json({ memberships: await listMembershipsForVenue(venueId) });
}

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

  for (const field of ["holderName", "holderPhone", "startsOn", "expiresOn"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }
  if (!isAmount(input.price))
    return NextResponse.json({ error: `Price must be ${money(0)} or more, to the ${region().currency.minor}.` }, { status: 400 });


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

  // On one of the venue's plans, for its benefits (a tier): any plan offered here.
  let tierId: number | undefined;
  if (input.tierId !== undefined && input.tierId !== null) {
    const plan = Number.isInteger(input.tierId) ? await planById(input.tierId as number) : null;
    if (!plan || plan.venueId !== venueId) return NextResponse.json({ error: "That plan is not offered here." }, { status: 400 });
    tierId = plan.id;
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

  const result = await sellMembership({
    holderParticipantId: holder[0] ?? null,
    covers: covered,
    tierId,
    venueId: venueId as number,
    holderName: input.holderName as string,
    holderPhone: input.holderPhone as string,
    startsOn: input.startsOn as string,
    expiresOn: input.expiresOn as string,
    price: input.price as number,
    adminId: admin.id,
    userId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "membership.sold",
    detail: `${input.holderName as string}${
      holder.length > 0 ? ` for ${people.find((p) => p.id === holder[0])?.name ?? "a participant"}` : ""
    }${covered.length > 0 ? `, covering ${people.filter((p) => covered.includes(p.id)).map((p) => p.name).join(", ")}` : ""}, ${money(input.price as number)}, ${input.startsOn as string} to ${input.expiresOn as string}`,
  });
  return NextResponse.json({ membership: result.membership }, { status: 201 });
}
