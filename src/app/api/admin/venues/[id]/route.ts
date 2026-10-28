import { NextRequest, NextResponse } from "next/server";
import { readMinute } from "@/lib/api";
import { isMinute } from "@/lib/interval";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { tellOwnersEach } from "@/lib/owner-alerts";
import { markDetailsChecked } from "@/lib/setup";
import { getVenue, setVenueAmenities, setVenuePin, updateVenue } from "@/lib/store";
import { isAmenity } from "@/lib/facilities";
import { formatDistance, inCountry, readPoint } from "@/lib/geo";
import { FAR_FROM_ADDRESS_M } from "@/lib/applications";
import { LATEST_CLOSE_HOUR, MAX_CANCEL_CUTOFF_HOURS, MAX_EMERGENCY_INFO } from "@/lib/types";
import { logFromRequest } from "@/lib/activity";
import { region } from "@/lib/region";

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
    openMin?: number;
    closeMin?: number;
    weekHours?: unknown;
    staffedFrom?: number | null;
    staffedTo?: number | null;
    partlyUnstaffed?: "code" | "counter";
    emergencyPhone?: string | null;
    emergencyInfo?: string | null;
    phoneWhatsapp?: boolean;
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

  // Usual hours: minutes of the day or HH:MM (openHour and closeHour, the older form); checked in lib/week-hours.ts.
  for (const [field, older] of [["openMin", "openHour"], ["closeMin", "closeHour"]] as const) {
    if (input[field] === undefined && input[older] === undefined) continue;
    const value = readMinute(input, field, older);
    if (!isMinute(value))
      return NextResponse.json({ error: "Opening hours are times of day, from midnight to 4 AM the next morning." }, { status: 400 });
    changes[field] = value;
  }
  // Weekdays with their own hours, or closed: checked in lib/week-hours.ts.
  if (input.weekHours !== undefined) changes.weekHours = input.weekHours;

  // null on both ends means "always staffed", which is every venue by default.
  for (const field of ["staffedFrom", "staffedTo"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null) {
      changes[field] = null;
      continue;
    }
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > LATEST_CLOSE_HOUR)
      return NextResponse.json(
        { error: "A staffed hour must be a whole hour between midnight and the latest close." },
        { status: 400 }
      );
    changes[field] = value as number;
  }

  // A booking staffed for only part of its time: the door code, or somebody stays on the desk.
  if (input.partlyUnstaffed !== undefined) {
    if (input.partlyUnstaffed !== "code" && input.partlyUnstaffed !== "counter")
      return NextResponse.json({ error: "partlyUnstaffed must be code or counter." }, { status: 400 });
    changes.partlyUnstaffed = input.partlyUnstaffed;
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

  // Whether customers may message the venue's number on WhatsApp (lib/venue-contact.ts).
  if (input.phoneWhatsapp !== undefined) {
    if (typeof input.phoneWhatsapp !== "boolean") return NextResponse.json({ error: "phoneWhatsapp must be true or false." }, { status: 400 });
    changes.phoneWhatsapp = input.phoneWhatsapp;
  }

  // Where it is on the map: both, or neither.
  let pin: { lat: number; lng: number } | null = null;
  if (input.lat !== undefined || input.lng !== undefined) {
    pin = readPoint(input.lat, input.lng);
    if (!pin) return NextResponse.json({ error: "Drop the pin on the map where the venue is." }, { status: 400 });
    if (!inCountry(pin)) return NextResponse.json({ error: `The pin is outside ${region().name}.` }, { status: 400 });
  }

  // What it offers, from the fixed list: replaced whole.
  let amenities: string[] | null = null;
  if (input.amenities !== undefined) {
    if (!Array.isArray(input.amenities) || !input.amenities.every(isAmenity))
      return NextResponse.json({ error: "Choose facilities from the list." }, { status: 400 });
    amenities = input.amenities;
  }

  if (Object.keys(changes).length === 0 && !pin && !amenities)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const before = await getVenue(venueId);
  const result = await updateVenue(venueId, changes);
  if (result.ok)
    await logFromRequest(req, { venueId, action: "settings.changed", detail: `Venue details: ${Object.keys(changes).join(", ")}` });
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "Venue not found." ? 404 : 400 }
    );
  if (amenities) await setVenueAmenities(venueId, amenities.filter(isAmenity));
  // Saving the venue's details is the owner having looked at its hours.
  await markDetailsChecked(venueId);
  // A venue's name is what customers trust. An operator may change their own,
  // but the platform owner hears about it, so a venue cannot quietly become
  // "AAA Best Courts" or borrow a better-known name.
  if (!isOwner(admin) && before && before.name !== result.venue.name)
    await tellOwnersEach((t) => ({
      subject: t("r9d.renamed.s", { old: before.name, name: result.venue.name }),
      body: t("r9d.renamed.b", { email: admin.email, old: before.name, name: result.venue.name }),
    }));
  if (pin) {
    const moved = await setVenuePin(venueId, pin);
    // Where a live venue says it is was checked when it went live. Moving the
    // pin a street is a correction; moving it across town is a different
    // place, and the platform owner hears of it.
    if (!isOwner(admin) && before?.publishedAt && moved !== null && moved > FAR_FROM_ADDRESS_M)
      await tellOwnersEach((t) => ({
        subject: t("r9d.pin.s", { venue: result.venue.name, distance: formatDistance(moved) }),
        body: t("r9d.pin.b", { email: admin.email, venue: result.venue.name, distance: formatDistance(moved), address: result.venue.address }),
      }));
    return NextResponse.json({ venue: (await getVenue(venueId)) ?? result.venue });
  }
  return NextResponse.json({ venue: amenities ? ((await getVenue(venueId)) ?? result.venue) : result.venue });
}
