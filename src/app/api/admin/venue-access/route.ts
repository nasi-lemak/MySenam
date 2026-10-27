import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import {
  ACCESS_KINDS,
  accessEntryId,
  accessList,
  accessSettings,
  addAccess,
  findAccountToLink,
  linkAccess,
  parseAccessLines,
  removeAccess,
  setAccessSettings,
  unlinkAccess,
  type AccessKind,
  type VenueAccess,
} from "@/lib/access";
import { phoneChecksOn } from "@/lib/phone-check";
import { logFromRequest } from "@/lib/activity";
import { guestPolicy, setGuestPolicy } from "@/lib/guest-invites";

export const dynamic = "force-dynamic";

/** `?venueId` → who the venue is for, and its list. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({
    settings: await accessSettings(venueId),
    list: await accessList(venueId),
    // Whether customers can prove a number here; without it, only an entry linked to an account counts online.
    phoneChecks: phoneChecksOn(),
    guests: await guestPolicy(venueId),
  });
}

/**
 * `{ venueId, action: "settings", access, listed, note }`,
 * `{ venueId, action: "add", phone, name, label, kind, expiresOn, account? }` (`account`: an email or number to link the entry to),
 * `{ venueId, action: "import", text, kind, expiresOn }` (one `phone, name, unit` a line),
 * `{ venueId, action: "remove", id }`,
 * `{ venueId, action: "link", id, account }` (the account's email or number: the entry then counts online for it),
 * `{ venueId, action: "unlink", id }`,
 * `{ venueId, action: "guests", perResident, days }` (residents inviting their own guests).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const kind = (ACCESS_KINDS.includes(body.kind as AccessKind) ? body.kind : "resident") as AccessKind;
  let detail: string | null = null;

  if (body.action === "settings") {
    const result = await setAccessSettings(venueId, {
      access: body.access as VenueAccess,
      listed: body.listed !== false,
      note: str(body.note),
    });
    if (!result.ok) return NextResponse.json(result, { status: 400 });
  } else if (body.action === "add") {
    const account = str(body.account)?.trim() || null;
    // The account first, so a wrong one adds nobody.
    const found = account ? await findAccountToLink(account) : null;
    if (found && !found.ok) return NextResponse.json(found, { status: 400 });
    const result = await addAccess(
      venueId,
      [{ phone: str(body.phone) ?? "", name: str(body.name), label: str(body.label), kind, expiresOn: str(body.expiresOn) }],
      admin.id
    );
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    if (account) {
      const entryId = await accessEntryId(venueId, str(body.phone) ?? "");
      if (entryId !== null) {
        const linked = await linkAccess(venueId, entryId, account, admin.id);
        if (linked.ok) detail = `Access list: add ${str(body.phone) ?? ""}, linked to account ${linked.account.id}`;
      }
    }
  } else if (body.action === "link") {
    if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
    const linked = await linkAccess(venueId, body.id as number, str(body.account) ?? "", admin.id);
    if (!linked.ok) return NextResponse.json({ error: linked.error }, { status: linked.status ?? 400 });
    detail = `Access list: entry ${String(body.id)} linked to account ${linked.account.id}`;
  } else if (body.action === "unlink") {
    if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
    if (!(await unlinkAccess(venueId, body.id as number)))
      return NextResponse.json({ error: "That person is not on this venue's list." }, { status: 404 });
    detail = `Access list: entry ${String(body.id)} unlinked`;
  } else if (body.action === "import") {
    const people = parseAccessLines(str(body.text) ?? "", kind, str(body.expiresOn));
    if (people.length === 0) return NextResponse.json({ error: "No phone numbers found." }, { status: 400 });
    const result = await addAccess(venueId, people, admin.id);
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    return NextResponse.json({ ...result, settings: await accessSettings(venueId), list: await accessList(venueId) });
  } else if (body.action === "guests") {
    const result = await setGuestPolicy(venueId, { perResident: body.perResident, days: body.days });
    if (!result.ok) return NextResponse.json(result, { status: 400 });
  } else if (body.action === "remove") {
    if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
    await removeAccess(venueId, body.id as number);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: detail ?? (body.action === "settings"
      ? `Who it is for: ${String(body.access)}`
      : body.action === "guests"
        ? `Residents' guests: ${String(body.perResident)} at a time, up to ${String(body.days)} days`
        : `Access list: ${String(body.action)}${typeof body.phone === "string" ? ` ${body.phone}` : ""}`),
  });
  return NextResponse.json({
    settings: await accessSettings(venueId),
    list: await accessList(venueId),
    guests: await guestPolicy(venueId),
  });
}
