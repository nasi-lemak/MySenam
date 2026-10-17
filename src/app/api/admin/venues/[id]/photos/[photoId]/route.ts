import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { changePhoto, removePhoto } from "@/lib/photos";

export const dynamic = "force-dynamic";

async function staff(req: NextRequest, params: Promise<{ id: string; photoId: string }>) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id, photoId } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return { venueId, photoId: Number(photoId) };
}

/** `{ cover: true }`, `{ move: -1 | 1 }`, or `{ caption }`. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; photoId: string }> }) {
  const found = await staff(req, params);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const result = await changePhoto(found.venueId, found.photoId, {
    cover: body.cover === true,
    move: body.move === -1 || body.move === 1 ? body.move : undefined,
    caption: typeof body.caption === "string" || body.caption === null ? (body.caption as string | null) : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ photos: result.value });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; photoId: string }> }) {
  const found = await staff(req, params);
  if (found instanceof NextResponse) return found;
  const result = await removePhoto(found.venueId, found.photoId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ photos: result.value });
}
