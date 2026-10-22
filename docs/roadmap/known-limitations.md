# Known limitations and gaps

Authoritative list of what is known to be wrong, missing or unverified, kept
apart from what works ([feature status](../product/feature-status.md)) and
from ideas ([roadmap](roadmap.md)). Recorded during the
[documentation audit](../documentation-audit.md) of October 2026 from reading
the code and running its tests; **no application code was changed by that
audit**, so every defect below is still open unless a later change says
otherwise.

Priorities:

- **P0** — critical security, data-integrity or financial-correctness issue.
- **P1** — required for a reliable production launch.
- **P2** — important for broader adoption or operational efficiency.
- **P3** — optional enhancement.

## Suspected defects

"Confirmed" means the cause was confirmed by reading the code (and, where
noted, reproduced); none has a failing test in the repository yet. Each has
the test that should be written before it is fixed.

### Operations and security (S)

| ID | Pri | What goes wrong | Evidence | Launch blocker | Recommended test |
| -- | --- | --------------- | -------- | -------------- | ---------------- |
| S3 | P2 | The scheduler lease (three minutes) is renewed when a tick starts, not during it; a long tick (large `pg_dump` plus upload) lets a second instance start the same work. Webhook deliveries have no per-delivery claim, so they could go out twice. | `src/lib/scheduler.ts`, `src/lib/webhooks.ts` | Only for several instances | Hold the lease, stall past it, assert a second instance does no work |
| S4 | P3 | Sessions stay valid until the end of the UTC day they expire: `expires_at` is ISO text compared as text with `datetime('now')`. | `src/lib/auth.ts`, `src/lib/admin-auth.ts` | No | Set `expires_at` an hour in the past; expect the session refused |
| S5 | P3 | Sign-in is limited per pair of address and email, so attempts on one account spread over many addresses are not limited together. | `src/lib/rate-limit.ts` | No | Many addresses, one email: expect a `429` |
| S6 | P2 | Several instances need the same `MYSENAM_SECRET`; without it each makes its own key and cannot read what another sealed. Documentation gap, now documented. | `src/lib/secrets.ts` | Only for several instances | — (configuration) |
| S7 | P3 | Session tokens are stored as they are, not hashed, and so are in every backup (reset tokens are hashed). | `src/lib/auth.ts` | No | — |
| S8 | P3 | Phone verification codes are deleted only when the next code is asked for, not by the retention run. | `src/lib/phone-check.ts` | No | Retention run removes codes older than a day |

Also: there is **no CSRF token or `Origin` check**; cross-site requests are
stopped by `SameSite=Lax` cookies alone (P3).

### Booking and availability (B)

| ID | Pri | What goes wrong | Evidence | Launch blocker | Recommended test |
| -- | --- | --------------- | -------- | -------------- | ---------------- |
| B1 | P2 | Two big courts over the same small one: booking one does not mark the other taken in the grid, search or any-court; booking it then fails as "filling up". The database still prevents the double booking. Blocks on one big court do not reach the other either. | `db/migrations/0072_linked_courts.sql` trigger shadows whole↔part only | No | Link W1→P and W2→P; book W1; assert W2 shows taken |
| B2 | P2 | Waiting-list holds are respected only by the grid and the booking path, not by search, any court, moving, rescheduling or the move picker, so a held place can be taken and the waiter's claim then fails. | `offerHolds` callers in `src/lib/store.ts` | No | Offer a slot; move or reschedule another booking into it; expect refusal |
| B3 | P3 | A partly blocked shared facility with a waiting-list hold can be booked past what the grid shows. | `freeSeat` vs `blockedOut` in `src/lib/store.ts` | No | Capacity 3, one blocked, one held, one booked: expect refusal |
| B4 | P2 | Creating an outage is not one transaction (check, cancel, insert), and classes on a linked court are not listed; a booking made meanwhile lands in the outage untold. Tournament clash checks are similarly outside their transaction. | `src/lib/outages.ts`, `src/lib/tournaments.ts` | No | On Postgres, create an outage and a booking at once; assert no confirmed booking inside it |
| B5 | P3 | Changing a venue's slot length can race a booking made with the old length. | `createBookingSeries` reads the step outside its transaction | No | — |
| B6 | P3 | Courts may allow bookings up to twelve hours, but search and waiting lists accept at most four. | `src/lib/store.ts`, `src/app/api/search/route.ts` | No | Search for a five-hour slot on a court that allows it |
| B7 | P3 | Moving and rescheduling check blocks and classes outside their transaction. | `moveBooking`, `rescheduleBooking` in `src/lib/store.ts` | No | Concurrent block and move |
| B8 | P3 | A booking of several courts is undone by compensating deletes rather than one transaction; an exception part-way leaves earlier courts booked. | `createGroupBooking` in `src/lib/store.ts` | No | Force a failure on the third court |

Also: cancelling a weekly series skips weeks inside the cancellation cutoff
silently rather than applying the late-cancel policy to them; rescheduling
does not check the target court's booking-length limits (P3, unconfirmed
whether intended).

### Money (M)

| ID | Pri | What goes wrong | Evidence | Launch blocker | Recommended test |
| -- | --- | --------------- | -------- | -------------- | ---------------- |
| M1 | P1 | A game player who leaves after the host has paid the rest online is refunded, but the booking stays paid and nobody owes the share: the venue is short by it, and the sales journal still shows the full price. | `unpayShare` in `src/lib/games.ts` keeps the booking paid when the host's payment exists | For open games with online shares | Share paid → host pays rest → player leaves → assert the share is owed again |
| M2 | P2 | A lost chargeback on a deposit is not unwound, and the whole payment is taken back even when the dispute is for part of it. | `disputeLost` / `takeBackWhatItBought` in `src/lib/payments.ts` | Before taking deposits through Stripe | Deposit paid → dispute lost → expect deposit cleared, full price due |
| M3 | P2 | Marking a whole series paid at the counter can overwrite an online payment that lands at the same moment, losing the record that money came online and is owed back. | `paySeries` in `src/lib/store.ts` reads outside its transaction | No | Concurrent settlement and `paySeries` |
| M4 | P2 | Two copies of a lost-dispute notice arriving together can debit stored credit twice. | `recordDispute` in `src/lib/payments.ts` has no claim | No | Two `charge.dispute.closed` events at once on a top-up |
| M5 | P2 | The Stripe set-up text in the venue's settings form omits the `charge.dispute.*` events, so venues following it never receive disputes. | `src/lib/gateways/stripe.ts` (set-up text vs `DISPUTE_EVENTS`) | Before taking Stripe payments | Assert the set-up text names every handled event |
| M6 | P2 | The sales journal is rebuilt from bookings as they are now: after a lost dispute marks a booking unpaid, its receipt drops out of past periods while the credit note stays, reversing the sale twice. | `src/lib/accounting.ts` | For accounting use | Lost dispute → original month still shows the receipt |
| M7 | P2 | Cancelling one week of a weekly series paid by deposit issues a credit note for the whole deposit. | `noteOnlineRefundDue` in `src/lib/store.ts` | No | Two-week deposit series, cancel one week |
| M8 | P3 | Refunds to stored credit are written to the venue regardless of `MYSENAM_CREDIT_SCOPE`, so on a marketplace set to `platform` one venue's money becomes credit spendable anywhere. | `refundToCredit` in `src/lib/payments.ts` | No (non-default setting) | — |

Also: if a manual "refunded" mark and a Stripe one-click refund race, money
can go back twice at the gateway (reported, not prevented); deposit receipts
are categorised as *Other* in the sales journal; disputes on the platform's
own Stripe account (venue invoices) are ignored.

### Fixed since the audit

IDs are not reused. Each fix came with the test recommended above.

| ID | Fixed by | Test |
| -- | -------- | ---- |
| S1 | Script-loaded modules import with file extensions | `tests/backup-scripts.test.ts` |
| S2 | Erasure takes the account off waiting lists before deleting it | `tests/privacy.test.ts` |

## Integrations awaiting live verification or a partner

Implemented and tested against fakes only. Each needs one real check before it
is relied on ([launch checklist](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)).

| Integration | State | Blocks launch |
| ----------- | ----- | ------------- |
| Billplz (FPX, cards, callbacks, X-Signature) | Needs sandbox verification | Yes, for online payment in Malaysia |
| Stripe Checkout, webhooks, refunds, disputes, renewals | Needs test-mode verification | Yes, for online payment in Singapore and renewals |
| WhatsApp Cloud API (templates must be approved by Meta) | Needs approval and a live send | No: email works without it |
| Email (SMTP), including SPF/DKIM and calendar invites | Needs a live send | Yes: confirmations go by email |
| SMS (Twilio or HTTP gateway) for phone codes | Needs a live send | Only where phone checks use SMS |
| LHDN MyInvois | Needs sandbox (preprod) verification | Only for venues that must e-invoice |
| Google sign-in | Needs a registered redirect URI | No: password sign-in works |
| S3-compatible off-site backups and photo storage | Needs a real bucket | Off-site backups: yes, for production |
| Reserve with Google | Feeds only; needs Actions Center partner approval and a booking server that is **not built** | No |
| Smart locks (TTLock, Igloohome) | Not built; blocked on vendor credentials | No |
| Stripe Connect payouts, Singapore InvoiceNow, web push, LINE, Zalo | Not built; each needs a partner or contract | No |

## Deliberately unsupported

- **Demand-based ("surge") pricing.** Raising prices when busy teaches regulars
  to wait and reads as a trick where a court is a known price. Venues have
  fixed peak and off-peak bands, holidays, an opt-in last-minute discount and
  a free hour for regulars instead.
- **Referral credit** ("give RM10, get RM10"): with bookings by phone number
  and no proof two numbers are two people, it pays people to refer themselves.
- **One country per install.** Malaysia and Singapore are separate installs
  ([regions](../product/regions-and-tax.md)).
- **Storefront domains are not data separation.** A business needing its own
  customers and database gets its own install
  ([ADR 0005](../architecture/decisions/0005-shared-marketplace-and-own-installs.md)).
- **No turnstile or per-person door credentials**: unstaffed access is one
  code per lock, and software can attribute an entry but not prevent
  tailgating ([venue operations](../features/venue-operations.md)).

## Gaps in verification and documentation

| Gap | Consequence | Priority |
| --- | ----------- | -------- |
| No automated browser (end-to-end) tests | Pages are checked by hand only | P2 |
| No ESLint configuration; `npm run lint` is not a working check | Style and some bug classes unchecked | P3 |
| `.env.example` lists about half the variables | New installs miss settings; [configuration](../development/configuration.md) is complete | P3 |
| [HTTP routes](../architecture/http-api.md) lists a subset of routes | Developers read the `route.ts` files for the rest | P3 |
| `/terms` and `/privacy` are drafts that describe the software; not reviewed by a lawyer; PDPA expects a Malay notice and a named contact | Legal exposure | P1 before public launch |
| Cross-venue `403` checks are tested on about a dozen routes; the rest rely on the `401` sweep plus code review | A wrong venue comparison in an untested route would not be caught | P2 |
