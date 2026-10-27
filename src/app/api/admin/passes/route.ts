import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, issuePass, listPassesForVenue } from "@/lib/store";
import { MAX_PASS_ENTRIES, MAX_PASS_MINUTES, Sport } from "@/lib/types";
import { logAction } from "@/lib/activity";
import { money, region, isAmount } from "@/lib/region";
import { isScope, PASS_SCOPES } from "@/lib/entitlements";
import { selectionAtVenue } from "@/lib/participant-bookings";
import { isRefusal } from "@/lib/participants";

export const dynamic = "force-dynamic";

/** Passes issued by one venue. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  return NextResponse.json({ passes: await listPassesForVenue(venueId) });
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

  for (const field of ["name", "holderName", "holderPhone", "expiresOn"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }
  // A session pass sells entries; a time pass, minutes of court time (`entries` either way).
  const kind = input.kind === undefined || input.kind === null || input.kind === "" ? "session" : input.kind;
  if (kind !== "session" && kind !== "time")
    return NextResponse.json({ error: "kind must be session or time." }, { status: 400 });
  const most = kind === "time" ? MAX_PASS_MINUTES : MAX_PASS_ENTRIES;
  if (!Number.isInteger(input.entries) || (input.entries as number) < 1 || (input.entries as number) > most)
    return NextResponse.json(
      { error: kind === "time" ? `Court time must be 1–${most} minutes.` : `Entries must be 1–${most}.` },
      { status: 400 }
    );
  // Minutes an entry covers (null: a whole booking), and the longest booking it pays for (null: any).
  const optionalMinutes = (v: unknown): number | null | undefined | false =>
    v === undefined ? undefined : v === null || v === "" ? null : Number.isInteger(v) ? (v as number) : false;
  const entryMinutes = optionalMinutes(input.entryMinutes);
  const maxMinutes = optionalMinutes(input.maxMinutes);
  if (entryMinutes === false || maxMinutes === false)
    return NextResponse.json({ error: "entryMinutes and maxMinutes are whole minutes, or null." }, { status: 400 });
  if (!isAmount(input.price))
    return NextResponse.json({ error: `Price must be ${money(0)} or more, to the ${region().currency.minor}.` }, { status: 400 });

  let sport: Sport | null = null;
  if (input.sport !== undefined && input.sport !== null && input.sport !== "") {
    if (!(await isActivity(input.sport)))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
    sport = input.sport as Sport;
  }


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
  const scope = input.scope === undefined || input.scope === null || input.scope === "" ? "booking" : input.scope;
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

  const result = await issuePass({
    scope,
    holderParticipantId,
    venueId: venueId as number,
    sport,
    name: input.name as string,
    kind,
    entries: input.entries as number,
    entryMinutes,
    maxMinutes,
    price: input.price as number,
    holderName: input.holderName as string,
    holderPhone: input.holderPhone as string,
    expiresOn: input.expiresOn as string,
    adminId: admin.id,
    userId,
    coachId: Number.isInteger(input.coachId) ? (input.coachId as number) : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logAction(admin, {
    venueId: result.pass.venueId,
    action: "pass.sold",
    detail: `${input.holderName as string}, ${input.entries as number} ${kind === "time" ? "minutes" : "entries"}, ${money(input.price as number)}`,
  });
  return NextResponse.json({ pass: result.pass }, { status: 201 });
}
