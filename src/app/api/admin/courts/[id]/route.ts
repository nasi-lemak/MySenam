import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { updateCourt } from "@/lib/store";

export const dynamic = "force-dynamic";

const MAX_RATE = 1000;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const courtId = Number(id);
  if (!Number.isInteger(courtId) || courtId <= 0)
    return NextResponse.json({ error: "Invalid court id." }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { name, offPeakRate, peakRate } = (body ?? {}) as Record<string, unknown>;

  const changes: { name?: string; offPeakRate?: number; peakRate?: number } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length < 2)
      return NextResponse.json({ error: "Court name is too short." }, { status: 400 });
    changes.name = name;
  }
  for (const [key, rate] of [["offPeakRate", offPeakRate], ["peakRate", peakRate]] as const) {
    if (rate !== undefined) {
      if (!Number.isInteger(rate) || (rate as number) < 1 || (rate as number) > MAX_RATE)
        return NextResponse.json({ error: `${key} must be RM1–${MAX_RATE}.` }, { status: 400 });
      changes[key] = rate as number;
    }
  }
  if (Object.keys(changes).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const result = updateCourt(courtId, changes);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ court: result.court });
}
