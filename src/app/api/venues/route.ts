import { NextRequest, NextResponse } from "next/server";
import { listVenues } from "@/lib/store";
import { shows, storefrontForRequest } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/** Every venue, or on a storefront, its own. */
export function GET(req: NextRequest) {
  const storefront = storefrontForRequest(req);
  return NextResponse.json({ venues: listVenues().filter((v) => shows(storefront, v.id)) });
}
