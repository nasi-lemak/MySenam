import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, listAdmins, requireAdmin } from "@/lib/admin-auth";
import { siteName } from "@/lib/site";
import { sendPlainEmail } from "@/lib/transports";
import { markDetailsChecked } from "@/lib/setup";
import { getVenue, updateVenue } from "@/lib/store";
import { CLOSE_HOUR, MAX_CANCEL_CUTOFF_HOURS, MAX_EMERGENCY_INFO, OPEN_HOUR } from "@/lib/types";

export const dynamic = "force-dynamic";

const FIELDS = ["name", "area", "address", "phone"] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const changes: {
    name?: string;
    area?: string;
    address?: string;
    phone?: string;
    cancelCutoffHours?: number;
    openHour?: number;
    closeHour?: number;
    staffedFrom?: number | null;
    staffedTo?: number | null;
    emergencyPhone?: string | null;
    emergencyInfo?: string | null;
  } = {};
  for (const field of FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length < 2)
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
    changes[field] = value;
  }

  const cutoff = input.cancelCutoffHours;
  if (cutoff !== undefined) {
    if (!Number.isInteger(cutoff) || (cutoff as number) < 0 || (cutoff as number) > MAX_CANCEL_CUTOFF_HOURS)
      return NextResponse.json(
        { error: `Cancellation cutoff must be 0–${MAX_CANCEL_CUTOFF_HOURS} hours.` },
        { status: 400 }
      );
    changes.cancelCutoffHours = cutoff as number;
  }

  for (const field of ["openHour", "closeHour"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < OPEN_HOUR || (value as number) > CLOSE_HOUR)
      return NextResponse.json(
        { error: `Opening hours must be whole hours between ${OPEN_HOUR} and ${CLOSE_HOUR}.` },
        { status: 400 }
      );
    changes[field] = value as number;
  }

  // null on both ends means "always staffed", which is every venue by default.
  for (const field of ["staffedFrom", "staffedTo"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null) {
      changes[field] = null;
      continue;
    }
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 24)
      return NextResponse.json(
        { error: "A staffed hour must be a whole hour between 0 and 24." },
        { status: 400 }
      );
    changes[field] = value as number;
  }

  for (const field of ["emergencyPhone", "emergencyInfo"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string")
      return NextResponse.json({ error: `${field} must be text, or null.` }, { status: 400 });
    if (typeof value === "string" && value.length > MAX_EMERGENCY_INFO)
      return NextResponse.json(
        { error: `That is too long — keep it under ${MAX_EMERGENCY_INFO} characters.` },
        { status: 400 }
      );
    changes[field] = value as string | null;
  }

  if (Object.keys(changes).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const before = changes.name !== undefined ? await getVenue(venueId) : null;
  const result = await updateVenue(venueId, changes);
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "Venue not found." ? 404 : 400 }
    );
  // Saving the venue's details is the owner having looked at its hours.
  await markDetailsChecked(venueId);
  // A venue's name is what customers trust. An operator may change their own,
  // but the platform owner hears about it, so a venue cannot quietly become
  // "AAA Best Courts" or borrow a better-known name.
  if (!isOwner(admin) && before && before.name !== result.venue.name)
    await tellOwnersOfRename(before.name, result.venue.name, admin.email);
  return NextResponse.json({ venue: result.venue });
}

/** Email every platform owner that a venue has a new name. */
async function tellOwnersOfRename(from: string, to: string, by: string): Promise<void> {
  const owners = (await listAdmins()).filter((a) => a.venueId === null);
  for (const owner of owners)
    await sendPlainEmail(
      owner.email,
      `${from} is now called ${to}`,
      `${by} renamed "${from}" to "${to}" on ${siteName()}.\n\n` +
        "Nothing needs doing if that is right. If it is not, change it back under Venues & staff."
    );
}
