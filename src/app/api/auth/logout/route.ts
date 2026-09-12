import { NextRequest, NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
