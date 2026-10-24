import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { addOfficial, listOfficials } from "@/lib/match-reports";
import { staffTournament } from "@/lib/tournament-access";
import { baseUrl } from "@/lib/outbox";

export const dynamic = "force-dynamic";

/** The officials who may enter this tournament's results through a link. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ officials: await listOfficials(found.id) });
}

/** `{ name, expiresOn? }` — a link for an official to enter results, shown this once; it works until the last day unless an earlier one is given. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const made = await addOfficial(found.id, String(body.name ?? ""), found.admin.id, typeof body.expiresOn === "string" && body.expiresOn ? body.expiresOn : null);
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  await logAction(found.admin, { venueId: null, action: "tournament.official_added", detail: `Tournament ${found.id}: ${made.value.official.name}` });
  return NextResponse.json({ official: made.value.official, link: `${baseUrl()}/officials/${made.value.token}` }, { status: 201 });
}
