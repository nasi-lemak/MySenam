import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { exportCustomerData } from "@/lib/privacy";

export const dynamic = "force-dynamic";

/**
 * Everything held about the signed-in customer, as a file they keep.
 *
 * Behind a session rather than behind code-and-phone: a booking lookup shows
 * one booking to somebody holding its code, while this is a person's whole
 * history, and a phone number is not a secret.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  const data = await exportCustomerData(user.id);
  if (!data) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const stamp = data.takenAt.slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="mysenam-my-data-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
