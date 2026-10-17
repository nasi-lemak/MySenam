import { NextRequest, NextResponse } from "next/server";
import { isOwner, requireAdmin } from "@/lib/admin-auth";
import { recentPhotos } from "@/lib/photos";

export const dynamic = "force-dynamic";

/** Photos venues added in the last fortnight, for the platform owner to look over. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isOwner(admin)) return NextResponse.json({ error: "Only the platform owner can do that." }, { status: 403 });
  return NextResponse.json({ photos: await recentPhotos() });
}
