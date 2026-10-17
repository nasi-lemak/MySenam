import { NextRequest, NextResponse } from "next/server";
import { photoStore } from "@/lib/photo-store";

export const dynamic = "force-dynamic";

/** Only names this install makes: anything else is not a photo. */
const KEY = /^venues\/\d+\/[a-f0-9]{16}-(400|800|1600)\.webp$/;

/**
 * A stored photo, when there is no public address for the bucket, or no
 * bucket. Every name is unique and never reused, so browsers and any cache
 * in front may keep it for a year.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.join("/");
  if (!KEY.test(key)) return new NextResponse("Not found", { status: 404 });
  const data = await photoStore().get(key).catch(() => null);
  if (!data) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
