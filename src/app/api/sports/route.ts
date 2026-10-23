import { NextRequest, NextResponse } from "next/server";
import { sportsOfferedAt } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/** The sports somebody here offers, in the usual order; on a storefront, its venues'. */
export async function GET(req: NextRequest) {
  const sports = await sportsOfferedAt((await storefrontForRequest(req))?.venueIds);
  return NextResponse.json({ sports });
}
