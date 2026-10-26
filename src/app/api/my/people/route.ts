import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { addManaged, editManaged, listManaged, type ManagedRefusal } from "@/lib/managed-people";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * People the signed-in adult manages from their own account, a child most
 * often (lib/managed-people.ts; ADR 0022): `?archived=1` includes those no
 * longer managed. Only this account's, never anybody else's.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const people = await listManaged(user.id, { archived: req.nextUrl.searchParams.get("archived") === "1" });
  return NextResponse.json({ people }, { headers: { "Cache-Control": "no-store" } });
}

const refusal = (r: ManagedRefusal) => NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });

/**
 * Add somebody: `{ displayName, birthYear?, relationship: "parent" |
 * "guardian" | "other", authority: true }`. Anything else (an email, a phone,
 * a photo, a school, an identity number) is refused, never stored.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "managed-people");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const made = await addManaged(user.id, body);
  if (!made.ok) return refusal(made);
  return NextResponse.json({ person: made.person }, { status: 201 });
}

/**
 * Change one: `{ id, displayName?, birthYear?, relationship?, authority?,
 * archived? }`. A changed relationship needs `authority: true` again;
 * `archived: true` stops managing them (nothing is deleted), `false` brings
 * them back.
 */
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "managed-people");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const { id, ...fields } = body;
  const done = await editManaged(user.id, id, fields);
  if (!done.ok) return refusal(done);
  return NextResponse.json({ person: done.person });
}
