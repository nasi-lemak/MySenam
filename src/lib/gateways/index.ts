import { baseUrl } from "../outbox";
import { region } from "../region";
import { billplz } from "./billplz";
import { stripe } from "./stripe";
import type { CheckoutPage, CheckoutRequest, GatewayAccount, PaymentGateway, ProviderId } from "./types";

export type * from "./types";

/**
 * The payment gateways this code can talk to, and which this install offers.
 *
 * Adding one is a file beside billplz.ts implementing `PaymentGateway`, and a
 * line here. Nothing else in MySenam knows which gateway a payment went
 * through: it opens pages with `openCheckout`, and callbacks arrive at
 * `/api/payments/<provider>/callback`.
 */
const GATEWAYS: Record<ProviderId, PaymentGateway> = { billplz, stripe };

export function gatewayFor(id: string): PaymentGateway | null {
  return Object.hasOwn(GATEWAYS, id) ? GATEWAYS[id as ProviderId] : null;
}

/**
 * What venues on this install may connect: `MYSENAM_PAYMENT_PROVIDERS`,
 * comma-separated, or the country's usual one (lib/region.ts).
 */
export function offeredGateways(): PaymentGateway[] {
  const fallback = GATEWAYS[region().gateway];
  const named = (process.env.MYSENAM_PAYMENT_PROVIDERS ?? fallback.id)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const offered = named.map(gatewayFor).filter((g): g is PaymentGateway => g !== null);
  return offered.length > 0 ? offered : [fallback];
}

export function allGateways(): PaymentGateway[] {
  return Object.values(GATEWAYS);
}

/**
 * The platform's own account, where venues pay their fees and WhatsApp packs:
 * `MYSENAM_PAYMENT_PROVIDER` (the first offered one by default), keyed from
 * that gateway's own environment variables.
 */
export function platformAccount(): GatewayAccount | null {
  const gateway = gatewayFor(process.env.MYSENAM_PAYMENT_PROVIDER?.trim().toLowerCase() ?? "") ?? offeredGateways()[0];
  return gateway.platformAccount(process.env);
}

/** Open a payment page through the account's gateway, reporting back to our callback for it. */
export async function openCheckout(
  account: GatewayAccount,
  request: Omit<CheckoutRequest, "callbackUrl" | "currency">
): Promise<CheckoutPage> {
  const gateway = gatewayFor(account.provider);
  if (!gateway) throw new Error(`No payment gateway called ${account.provider}.`);
  const { code, minorUnits } = region().currency;
  if (!gateway.currencies.includes(code)) throw new Error(`${gateway.name} does not take ${code}.`);
  return gateway.createCheckout(account, {
    ...request,
    currency: { code, minorUnits },
    callbackUrl: `${baseUrl()}/api/payments/${gateway.id}/callback`,
  });
}
