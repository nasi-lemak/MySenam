import { NextRequest, NextResponse } from "next/server";
import { classTerm, getClass } from "@/lib/store";
import { mayShowVenue } from "@/lib/listing";

export const dynamic = "force-dynamic";

/** `?classId` → the sessions left in this weekly class that can still be joined, and what the term costs. */
export async function GET(req: NextRequest) {
  const classId = Number(req.nextUrl.searchParams.get("classId"));
  if (!Number.isInteger(classId) || classId <= 0) return NextResponse.json({ error: "classId is required." }, { status: 400 });
  const session = await getClass(classId);
  if (!session || !(await mayShowVenue(session.venueId, req)).show) return NextResponse.json({ term: null });
  const term = await classTerm(classId);
  return NextResponse.json({
    term: term ? { sessions: term.sessions.length, dates: term.sessions.map((c) => c.date), total: term.total, offPercent: term.offPercent } : null,
  });
}
