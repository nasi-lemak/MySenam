import { NextRequest, NextResponse } from "next/server";
import { gatewayFor, platformAccount } from "@/lib/gateways";
import {
  accountForBill,
  accountForSubscription,
  gatewayAccounts,
  recordDispute,
  recordPlatformDispute,
  settleBill,
  settleSubscription,
} from "@/lib/payments";

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

  // A membership renewing itself: a later charge on its subscription, or its end.
  if (inbound.subscriptionId && inbound.verifySubscription) {
    const account = await accountForSubscription(gateway.id, inbound.subscriptionId);
    // Not one of ours: the venue's own Stripe business, answered so it is not retried.
    if (!account) return new NextResponse("OK", { status: 200 });
    const event = await inbound.verifySubscription(account);
    if (!event) return NextResponse.json({ error: "Bad signature." }, { status: 400 });
    await settleSubscription(gateway.id, event);
    return new NextResponse("OK", { status: 200 });
  }

  // A chargeback names no page of ours: whose it is shows by whose signing key it checks out under.
  if (inbound.dispute && inbound.verifyDispute) {
    for (const account of await gatewayAccounts(gateway.id)) {
      const event = await inbound.verifyDispute(account);
      if (!event) continue;
      const billId = await gateway.billForPayment?.(account, event.paymentRef);
      // On a payment that is not ours (the venue's other business): nothing to do.
      if (billId) await recordDispute(gateway.id, billId, event);
      return new NextResponse("OK", { status: 200 });
    }
    // On the platform's own account: a venue disputing its invoice or a WhatsApp pack.
    const platform = platformAccount();
    if (platform?.provider === gateway.id) {
      const event = await inbound.verifyDispute(platform);
      if (event) {
        const billId = await gateway.billForPayment?.(platform, event.paymentRef);
        if (billId) await recordPlatformDispute(gateway.id, billId, event);
        return new NextResponse("OK", { status: 200 });
      }
    }
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  const account = inbound.billId ? await accountForBill(gateway.id, inbound.billId) : null;
  const result = account ? await inbound.verify(account) : null;
  if (!result) return NextResponse.json({ error: "Unknown payment or bad signature." }, { status: 400 });

  await settleBill(result);
  return new NextResponse("OK", { status: 200 });
}
