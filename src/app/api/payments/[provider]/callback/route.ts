import { NextRequest, NextResponse } from "next/server";
import { gatewayFor } from "@/lib/gateways";
import { accountForBill, settleBill } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * A gateway, server to server, saying what happened to a payment page:
 * `/api/payments/billplz/callback`, and the like for any other gateway.
 *
 * This is the message that counts: the customer's browser may never come back.
 * It is believed only when it checks out under the key of the account the
 * page was made through, at that same gateway. Gateways retry anything but a
 * 200, so a forged or unknown one is answered 400 and a real one 200 however
 * many times it arrives.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const gateway = gatewayFor((await params).provider);
  if (!gateway) return NextResponse.json({ error: "No such payment gateway." }, { status: 404 });
  const body = await req.text().catch(() => "");
  const inbound = gateway.readCallback(body, req.headers);
  if (inbound.ignored) return new NextResponse("OK", { status: 200 });
  const account = inbound.billId ? await accountForBill(gateway.id, inbound.billId) : null;
  const result = account ? await inbound.verify(account) : null;
  if (!result) return NextResponse.json({ error: "Unknown payment or bad signature." }, { status: 400 });

  await settleBill(result);
  return new NextResponse("OK", { status: 200 });
}
