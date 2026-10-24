import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listWaitlistForAccount } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  // Joined by this account, or on the number it has proved: not every entry on a number it only typed.
  return NextResponse.json({ entries: await listWaitlistForAccount(user.id) });
}
