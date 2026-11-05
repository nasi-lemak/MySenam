import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { myAttendance } from "@/lib/attendance";

export const dynamic = "force-dynamic";

/**
 * The signed-in customer's own attendance at classes and lessons, and a guardian's for the people they manage (lib/attendance.ts): the
 * date, the class or coach, the venue and the mark, newest first. Never the instructor's note, never anybody else's, never public.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ attendance: await myAttendance(user.id) }, { headers: { "Cache-Control": "no-store" } });
}
