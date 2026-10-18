import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { phoneStatus } from "@/lib/phone-check";
import { playerGender } from "@/lib/who";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  return NextResponse.json({
    user,
    phone: user ? await phoneStatus(user.id) : null,
    gender: user ? await playerGender(user.id) : null,
  });
}
