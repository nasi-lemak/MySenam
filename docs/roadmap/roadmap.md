# Roadmap

Ideas not yet built. **Nothing on this page is operational.** What works is in
[feature status](../product/feature-status.md); what is broken or unverified
is in [known limitations](known-limitations.md), and fixing those comes before
anything here.

| Idea | Status | Why, and what it needs |
| ---- | ------ | ---------------------- |
| Per-person credentials through a smart-lock vendor (TTLock, Igloohome; Igloohome's offline algoPIN suits a door with no wifi), so an unstaffed resource issues one credential per person instead of one code per lock | BLOCKED | Vendor credentials. The induction record and the customer's entry screen are already the right shape for it. It is what 24-hour gym chains use, and the biggest gap in unstaffed access. |
| A turnstile rather than a door | DEFERRED | The only real answer to tailgating (one credential, one body); a hardware decision for each venue. |
| Reserve with Google's real-time Booking Server, and uploading the feeds | BLOCKED | Actions Center partner approval. The feeds exist as a draft ([external API](../integrations/external-api.md#reserve-with-google-readiness-only)). |
| Stripe Connect payouts to venues | DEFERRED | Venues take payment into their own accounts today ([ADR 0006](../architecture/decisions/0006-per-venue-payment-accounts.md)). |
| Singapore InvoiceNow (Peppol) e-invoicing | PLANNED | A Peppol access point; MyInvois covers Malaysia. |
| Web push notifications; LINE and Zalo messaging | PLANNED | Each needs its own provider account. |
| Pinning a webhook's resolved address for the connection itself | PLANNED | Webhook addresses are checked by looking them up just before sending; pinning needs a dedicated HTTP agent ([external API](../integrations/external-api.md)). |

Deliberate exclusions (surge pricing, referral credit) are recorded under
[known limitations](known-limitations.md#deliberately-unsupported), not here.
