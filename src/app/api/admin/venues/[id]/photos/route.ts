import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { addPhoto, MAX_UPLOAD_BYTES, venuePhotos } from "@/lib/photos";
import { rateLimit } from "@/lib/rate-limit";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

async function staffVenue(req: NextRequest, rawId: string) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venue = await getVenue(Number(rawId));
  if (!venue) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const denied = denyVenue(admin, venue.id);
  if (denied) return denied;
  return { admin, venue };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffVenue(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ photos: await venuePhotos(found.venue.id) });
}

/** A photo, as a form upload: `file`, and `caption` if there is one. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffVenue(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const limited = rateLimit(req, "photoUpload");
  if (limited) return limited;
  // Refused before it is read, where the size is declared.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024)
    return NextResponse.json({ error: "That photo is over 15 MB. Send a smaller one." }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the photo as a form upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Choose a photo." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "That photo is over 15 MB. Send a smaller one." }, { status: 413 });
  const caption = form.get("caption");
  const result = await addPhoto(found.venue.id, Buffer.from(await file.arrayBuffer()), {
    caption: typeof caption === "string" ? caption : undefined,
    adminId: found.admin.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ photos: result.value }, { status: 201 });
}
