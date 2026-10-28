# Payment gateways

Connecting Billplz and Stripe.

How payments behave is in [payments and credit](../features/payments-and-credit.md). None of this has been verified against a live gateway account; see [feature status](../product/feature-status.md).

Billplz is the first gateway, not the only one the code can have. Everything
gateway-specific sits behind one interface in `src/lib/gateways/`; the rest of
MySenam (what a payment is for, settling it once, money owed back, holds)
never knows which gateway a payment went through.

- **A gateway** implements `PaymentGateway` (`src/lib/gateways/types.ts`): the
  fields a venue types in to connect (and which are secret), a check on them,
  opening a hosted payment page, reading its server-to-server callback (raw
  body and headers, so JSON webhooks with a signature header fit as well as
  Billplz's signed form), reading the customer's redirect back, and the
  platform's own account from environment variables. Adding one is a file
  beside `billplz.ts` and a line in `src/lib/gateways/index.ts`.
- **Callbacks** arrive at `/api/payments/<gateway>/callback`. Billplz's address
  is unchanged, so payment pages already out keep reporting.
- **A report is checked only by the gateway the payment was made through**,
  under the key of the account it was made with. A Billplz page reported as if
  from another gateway is not checked at all.
- **A venue's account** is stored as that gateway's own fields in one JSON
  column, each secret sealed on its own. *Online payment* in the admin shows
  whatever fields the chosen gateway asks for, with a choice of gateway when
  the install offers more than one (`MYSENAM_PAYMENT_PROVIDERS`). Switching
  gateway means entering the new one's keys. Migration 0034 moved existing
  Billplz accounts across without unsealing anything.
- **The currency** comes from the install's country (`MYSENAM_COUNTRY`, see
  *Countries*), and a gateway that does not take it refuses to open a page
  (Billplz takes ringgit only).
- **Closing a page at a set time** is a gateway's own ability
  (`pageExpiry`): Stripe closes a Checkout Session 30 minutes to 24 hours
  after it is made; a Billplz bill stays payable until it is paid. What
  MySenam does with each is in
  [a membership paid online](../features/payments-and-credit.md#a-membership-paid-online)
  and [paying online to hold a booking](../features/payments-and-credit.md#paying-online-to-hold-a-booking).
- **Verification may ask the gateway.** A report's check can be a signature or
  a call to the gateway's own API, which is how a return address that carries
  no signature is checked.

### Stripe

The usual gateway for Singapore (cards, PayNow and the wallets a venue turns on
in its Stripe dashboard), through Stripe Checkout, into **the venue's own
Stripe account**.

- **Connecting**: the venue creates a *restricted key* in Stripe with Checkout
  Sessions set to Write, and a *webhook endpoint* pointing at the address the
  settings form shows (`/api/payments/stripe/callback`) for the
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed` and `checkout.session.expired`
  events — plus `invoice.paid` and `customer.subscription.deleted` for
  memberships that renew themselves, `charge.dispute.created`,
  `charge.dispute.updated` and `charge.dispute.closed` for chargebacks, and
  `charge.refunded` and `charge.refund.updated` for refunds made in Stripe's
  own dashboard ([refunds made in the gateway's dashboard](../features/payments-and-credit.md#refunds-made-in-the-gateways-dashboard)) — and
  pastes the key (`rk_live_…`) and the endpoint's signing secret
  (`whsec_…`). Unlike Billplz, Stripe has to be told where to report: a
  payment does not carry that.
- **Reports** are believed only with a valid `Stripe-Signature` under that
  venue's signing secret, no more than five minutes old. Other events on the
  venue's account are answered OK and ignored, so Stripe does not retry them.
- **Paid** means Stripe says the session's payment is `paid`. A method that
  confirms later (PayNow can) settles on
  `checkout.session.async_payment_succeeded`.
- **Coming back**: the customer returns to `/payments/return?stripe_session=…`.
  Nothing in that address is signed, so the page asks Stripe for the session
  with the venue's key rather than believing it.
- **The platform's own account** (venues' fees on a marketplace) is
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, with
  `MYSENAM_PAYMENT_PROVIDER=stripe`. Its webhook endpoint is the same address,
  for the four `checkout.session.*` events, the three `charge.dispute.*`
  ones and the two refund ones: a dispute or refund that checks out under no
  venue's secret is tried under the platform's, and goes to the platform owners
  ([chargebacks on what a venue paid the platform](../features/payments-and-credit.md#paying-online)).

Stripe Connect, where a venue presses *Connect with Stripe* instead of
creating a key and a webhook, would be easier for venues; it needs the platform
registered as a Connect platform, and would replace the two fields with a
connected account id.
