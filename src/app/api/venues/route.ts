import { NextResponse } from "next/server";
import { listVenues } from "@/lib/store";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ venues: listVenues() });
}
