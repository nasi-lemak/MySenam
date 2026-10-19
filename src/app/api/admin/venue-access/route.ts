import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import {
  ACCESS_KINDS,
  accessList,
  accessSettings,
  addAccess,
  parseAccessLines,
  removeAccess,
  setAccessSettings,
  type AccessKind,
  type VenueAccess,
} from "@/lib/access";
import { phoneChecksOn } from "@/lib/phone-check";
import { logFromRequest } from "@/lib/activity";

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
    // Whether a number on the list has to be checked before it counts.
    phoneChecks: phoneChecksOn(),
  });
}

/**
 * `{ venueId, action: "settings", access, listed, note }`,
 * `{ venueId, action: "add", phone, name, label, kind, expiresOn }`,
 * `{ venueId, action: "import", text, kind, expiresOn }` (one `phone, name, unit` a line),
 * `{ venueId, action: "remove", id }`.
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

  if (body.action === "settings") {
    const result = await setAccessSettings(venueId, {
      access: body.access as VenueAccess,
      listed: body.listed !== false,
      note: str(body.note),
    });
    if (!result.ok) return NextResponse.json(result, { status: 400 });
  } else if (body.action === "add") {
    const result = await addAccess(
      venueId,
      [{ phone: str(body.phone) ?? "", name: str(body.name), label: str(body.label), kind, expiresOn: str(body.expiresOn) }],
      admin.id
    );
    if (!result.ok) return NextResponse.json(result, { status: 400 });
  } else if (body.action === "import") {
    const people = parseAccessLines(str(body.text) ?? "", kind, str(body.expiresOn));
    if (people.length === 0) return NextResponse.json({ error: "No phone numbers found." }, { status: 400 });
    const result = await addAccess(venueId, people, admin.id);
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    return NextResponse.json({ ...result, settings: await accessSettings(venueId), list: await accessList(venueId) });
  } else if (body.action === "remove") {
    if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
    await removeAccess(venueId, body.id as number);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: body.action === "settings" ? `Who it is for: ${String(body.access)}` : `Access list: ${String(body.action)}${typeof body.phone === "string" ? ` ${body.phone}` : ""}`,
  });
  return NextResponse.json({ settings: await accessSettings(venueId), list: await accessList(venueId) });
}
