import { NextRequest, NextResponse } from "next/server";
import { readMinute } from "@/lib/api";
import { isMinute } from "@/lib/interval";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { createVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

const FIELDS = ["name", "area", "address", "phone"] as const;

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  for (const field of FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length < 2)
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }

  // Usual hours: minutes of the day or HH:MM (openHour and closeHour, the older form); checked in lib/week-hours.ts.
  const hours: { openMin?: number; closeMin?: number } = {};
  for (const [field, older] of [["openMin", "openHour"], ["closeMin", "closeHour"]] as const) {
    if (input[field] === undefined && input[older] === undefined) continue;
    const value = readMinute(input, field, older);
    if (!isMinute(value))
      return NextResponse.json({ error: "Opening hours are times of day, from midnight to 4 AM the next morning." }, { status: 400 });
    hours[field] = value;
  }

  const result = await createVenue({
    name: input.name as string,
    area: input.area as string,
    address: input.address as string,
    phone: input.phone as string,
    ...hours,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ venue: result.venue }, { status: 201 });
}
