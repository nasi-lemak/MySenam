# ADR 0006: Each venue takes payment into its own gateway account

- **Status:** current.
- **Context:** a marketplace that collected customers' money and paid venues
  out would be a payments business, needing a licence and reconciliation.
- **Decision:** each venue connects its own Billplz or Stripe account
  (`venue_payment_accounts`, keys encrypted with `MYSENAM_SECRET`). Customer
  payments and refunds go through the venue's account. The platform's own
  account (`BILLPLZ_*` / `STRIPE_*` variables) is used only for what venues pay
  the platform: invoices and WhatsApp packs.
- **Consequences:** no payouts to build; each venue sees its own money in its
  own gateway dashboard; a venue without a gateway takes payment at the
  counter.
- **Known limitations:** no gateway integration has been verified against a
  live account; Stripe Connect payouts are not built
  ([feature status](../../product/feature-status.md)).
