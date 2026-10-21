import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { consentsFor, withdrawFor } from "@/lib/marketing";

export const dynamic = "force-dynamic";

/** The venues this account agreed to hear from, and whether it still does. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ consents: await consentsFor(user.id, user.email) });
}

/** `{ id }` → stop hearing from that venue. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (!body || !Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (!(await withdrawFor(user.id, user.email, body.id as number))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ consents: await consentsFor(user.id, user.email) });
}
