# ADR 0056: Outbox reliability: messages survive provider outages and server stops, and urgent news is never written off

- **Status:** current, decided in audit round 9 (fix worker FX6, 2026-11-06). Built in migrations 0299 and 0300. What staff and customers see is in
  [messaging](../../integrations/messaging.md#when-a-provider-is-down-and-what-keeps-a-message-from-being-lost). Builds on the outbox
  ([lib/outbox.ts](../../integrations/messaging.md)) and [ADR 0003](0003-scheduler-lease.md) (the scheduler that ticks it).
- **Context:** the audit (G1, G7 to G11, G13, G14; C17) found the outbox's guarantees thinner than the documentation said. The fifth failure (about 2.6 hours of backoff)
  gave a message up for good, so one expired WhatsApp token overnight abandoned every confirmation, cancellation notice and waitlist offer waiting in it, and staff could resend
  only one message at a time. A reminder was keyed by the booking's code alone: it was sent for a booking cancelled while it waited, and none was written for a booking moved
  to another day. A venue's campaign queued ahead of a customer's confirmation, and consent withdrawn after queuing was not looked at again. The daily limit of 8 messages per
  recipient wrote off a venue's cancellation or a waitlist offer after a busy day. One failing step before the drain stopped every message on the install. A booking, a
  venue's cancellation or a customer's cancellation whose message a stopped request never wrote was never found again. The customer was never told a refund was made, failed or
  late. The platform's invoice to a venue was never emailed, and the first word was a warning a week after the due date.

## Decisions

1. **A failing provider is waited out; only the message itself can be given up on.** No count of tries gives a message up. The backoff grows to two hours and stays there, and
   the message is given up when it is older than `MYSENAM_MESSAGE_MAX_AGE_DAYS` (default 7), with the staff and the owners told. A transport marks a failure as permanent
   (`PermanentSendError`) only when sending again cannot help: an address that is not an address, a number WhatsApp says it cannot deliver to (a short list of Meta's codes), a
   message written for the other channel. Everything else, SES's account-level refusals included, is the provider's and waits. *Why the conservative list:* wrongly giving up a
   message that would have gone is worse than trying a bad one for seven days at a two-hour cadence.
2. **Staff can send again everything that failed in a window**, per venue, audited, with the same refusals as a single resend, and an account email (whose link is not kept) is
   never put back: the person asks for a new link, which every flow has.
3. **A message is looked at again as it is sent.** A reminder is for one booking at one time; a campaign needs the consent still standing. Queue order puts what somebody
   waits for ahead of bulk news.
4. **The urgent set is one list** (`URGENT_NEWS_KINDS`: the venue's cancellation, move and change, the waitlist offer, the guardian's notice, the refund notice). The daily
   limit of 8 does not hold them; a ceiling of their own does (`MYSENAM_URGENT_PER_RECIPIENT_PER_DAY`, default 30), so a stranger cannot flood a number with them. *Why not
   unlimited:* the audit's owner decision accepts the abuse risk of a guest booking typed with somebody else's number; a high bound costs nothing real and keeps the limit's purpose.
5. **A step before the drain cannot stop the drain** (`tickOutbox` isolates each step, raises an alert per failing step).
6. **A message owed to a customer is recorded with the fact it is about**, in the same transaction (`notices_owed`), and a sweep writes the message if the request that made
   the fact never did. *Why not write the message row itself in the transaction:* the confirmation's text depends on money settled after the booking commits (credit, a pass, a
   deposit, a hold), and a venue's cancellation's on a gateway call; building the text in the transaction would either say less than the request knows or move gateway calls into
   a transaction. The row says only that a message is owed; the request still writes the full message at once, and the sweep is the net. Only the paths that tell the customer
   owe the row (the booking route, the staff cancel route and closures, the customer's own cancel), so the sweep never starts telling people what no path told them.
7. **The customer is told what became of money paid back**, by email, once per change (`refund_notice`, keyed by payment, state and amount), read from the refund's own state, so
   a stop between the refund and the message is also found again.
8. **The platform's invoice is told to the venue's managers when issued and a few days before it falls due**, once each, told-then-stamped under the outbox's dedupe key (a crash
   repeats nothing and loses nothing); the overdue warning is made the same.

## What this does not change

The outbox is still at-least-once: a process that dies mid-send re-sends after ten minutes. The daily limit still holds marketing, reminders and confirmations. Safeguarding
notices, team decisions, tournament-day notices and staff alerts stay exempt from the limit. The money paths (refund claims, the reconciler, credit notes) are untouched; a
refund notice reads them and never writes. Neither is anything here a legal statement about consent, retention or the cross-border handling of messages: those stay with
[privacy](../privacy.md).

## Limits recorded

- A series cancelled in one go, and class enrolments, do not yet owe a recovery row; the booking's money is still recovered by the reconciler.
- A refund notice reaches only a customer who left an email: WhatsApp needs a template Meta has approved.
- A venue cancellation recovered by the sweep lacks the reason staff typed and how a counter payment was settled; a customer's cancellation recovered by the sweep says the
  fee kept as a share of the price, not to the sen.
- A business's invoice goes to its managers through its first branch; a venue with no manager is told nothing (the owners see the invoice on the billing page).
