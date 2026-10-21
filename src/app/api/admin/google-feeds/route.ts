import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { availabilityFeed, merchantFeed, serviceFeed } from "@/lib/google-feeds";

export const dynamic = "force-dynamic";

/** `?feed=merchants|services|availability` → that Reserve with Google feed, as JSON to upload (platform owners). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const owner = requireOwner(admin);
  if (owner) return owner;
  const feed = req.nextUrl.searchParams.get("feed");
  const body =
    feed === "merchants" ? await merchantFeed() : feed === "services" ? await serviceFeed() : feed === "availability" ? await availabilityFeed() : null;
  if (!body) return NextResponse.json({ error: "feed is merchants, services or availability." }, { status: 400 });
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${feed}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
}
