import { NextRequest, NextResponse } from "next/server";
import { googleOfferedAt } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/** Which ways of signing in this address offers, besides a password. */
export async function GET(req: NextRequest) {
  return NextResponse.json({ google: googleOfferedAt(req.headers.get("host")) });
}
