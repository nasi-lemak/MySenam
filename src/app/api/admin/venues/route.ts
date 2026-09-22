import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { createVenue } from "@/lib/store";
import { CLOSE_HOUR, OPEN_HOUR } from "@/lib/types";

export const dynamic = "force-dynamic";

const FIELDS = ["name", "area", "address", "phone"] as const;

export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
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

  const hours: { openHour?: number; closeHour?: number } = {};
  for (const field of ["openHour", "closeHour"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < OPEN_HOUR || (value as number) > CLOSE_HOUR)
      return NextResponse.json(
        { error: `Opening hours must be whole hours between ${OPEN_HOUR} and ${CLOSE_HOUR}.` },
        { status: 400 }
      );
    hours[field] = value as number;
  }

  const result = createVenue({
    name: input.name as string,
    area: input.area as string,
    address: input.address as string,
    phone: input.phone as string,
    ...hours,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ venue: result.venue }, { status: 201 });
}
