import { NextRequest, NextResponse } from "next/server";
import { verifyCallback } from "@/lib/billplz";
import { accountForBill, settleBill } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Billplz, server to server, saying what happened to a bill.
 *
 * This is the message that counts: the customer's browser may never come back.
 * It is believed only when its signature checks out under the key of the venue
 * whose bill it is. Billplz retries anything but a 200, so a forged or unknown
 * one is answered 400 and a real one 200 however many times it arrives.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a form." }, { status: 400 });
  const fields: Record<string, string> = {};
  for (const [k, v] of form) if (typeof v === "string") fields[k] = v;

  const account = fields.id ? accountForBill(fields.id) : null;
  const result = account ? verifyCallback(fields, account.xSignatureKey) : null;
  if (!result) return NextResponse.json({ error: "Unknown bill or bad signature." }, { status: 400 });

  settleBill(result);
  return new NextResponse("OK", { status: 200 });
}
