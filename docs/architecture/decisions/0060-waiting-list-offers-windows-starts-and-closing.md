# ADR 0060: Waiting-list offers have a window of the venue's own, never run past the start, hold only their own time and are told when they lapse; a class called off closes its list and tells its coach

- **Status:** current, decided in the ninth audit round (findings B6, B7, B13, E5, E6, E12 and H9). Built in migration 0306. What people see is in
  [waitlists](../../features/booking.md#waitlists) (and *how long an offer lasts* beneath it) and [classes](../../features/programmes.md). Builds on
  [ADR 0016](0016-matchmaking-on-open-games.md) (no learned ranking: first come, first offered), [ADR 0010](0010-interval-booking.md) (an offer is a claim on court time),
  [ADR 0002](0002-database-enforced-concurrency.md) and [ADR 0053](0053-a-closure-is-written-first-and-what-has-been-played-is-left-alone.md) (a closed day is never offered).
- **Context:** an independent audit found that one live offer anywhere on a court and day stopped every other waiter being offered their own, unrelated time, and that a
  claimed offer never led to the next being offered; that an offer was made for a class that had already started (and for a time minutes from its start, held 20 minutes
  into the session, the claim then refused) and held a class place the desk could have filled; that the 30 minutes were fixed for every venue and hour and an offer that ran
  out vanished without a word; that two ways a class place is freed (a term's weeks cancelled one by one, an unpaid claimed place let go) were offered as court time and so
  never reached the class's waiting list; and that calling a class off left its waiting list "waiting" for ever on the customers' accounts and told neither them nor the
  instructor.

## Decision 1: a live offer holds only its own time

`offerSlotPlace` no longer stops at any live offer on the court and day. It walks the queue and offers every waiting entry whose own time is free; the time an offer
holds is a claim, so an overlapping time is not free (`slotTimeFree`, and the claim's constraints), and several offers for different times, or for places of a shared
facility that still fit, stand together. One person still holds **one place at a time** on a court and day: somebody with a live offer is not offered a second. A taken-up
offer sweeps the day (and the class) again (`offerFreedPlace`), and the scheduler also offers again the places of offers that lapsed in the last hour (offers let go while
somebody was reading a list or claiming something else were never passed on). A **class** keeps its one live offer at a time (several places freed are offered one after
the other, as the programme documentation says and `tests/waitlist.test.ts` holds); offering several places at once is left as an option for the owner.

## Decision 2: no offer for what has begun, and no offer past the start

An offer is given the venue's offer window or the time left to the start, whichever is less (`offerMinutesFor`); the minutes granted are kept on the entry
(`waitlist.offer_minutes`) and are what expiry, the live-offer count of a class (`classOfferHolds`), the offer's page and the offer message all use, so a change of the
setting moves no offer already made and a court hold (`claims.expires_at`) ends with its offer. Nothing is offered for something that has started, or with fewer than
**5 minutes** left (`WAITLIST_OFFER_LEAST_MINUTES`): the entry is passed over (court time: the next waiter, whose time may be later) or nobody is offered (a class), and the
place stays open for the desk. The scheduler closes entries still waiting for a class or time that has begun (`expired`, quietly: they were never offered anything).
The 5 minutes is a choice of ours, not the owner's; it is a constant, not a setting.

## Decision 3: the offer window is the venue's own setting

`venues.waitlist_offer_minutes`, 5 to 120, default **30** (what it always was), set beside *Pay online to hold a booking* (`holdPolicy().offerMinutes`,
`POST /api/admin/hold-policy` `offerMinutes`, not given: as it was) and copied with a branch's settings. The audit's further idea of pausing offers overnight, or
extending them to the next morning for sessions far away, was **not** built: it is a business policy with several reasonable answers; the setting and the automatic
shortening near the start are the owner's recommended default (option (a) in the audit notes without the overnight pause).

An offer that runs out unclaimed is told **once**: the person is told the place has passed to the next and that they are off the list for it (kind `waitlist_ended`, in
their language in the four customer dictionaries, keyed by the entry; by email where they gave an address, because there is no WhatsApp template for it, so a person with only a
phone number is not told: a known limit). The offer message (`msg.offer`) now carries `{minutes}` instead of a fixed "30 minutes", in the four languages and in the WhatsApp
template document: **the approved WhatsApp template `mysenam_waitlist_offer` changes (one more parameter) and must be resubmitted to Meta** before the WhatsApp offer is live-verified.

## Decision 4: every way a class place is freed reaches the class's list

`offerFreedPlace({classId, courtId, date})` offers a freed place to the class's list when it is a class place and to the court time's otherwise. `cancelSeries` (a term's
weeks), `releaseExpiredHolds` (an unpaid claimed place lapsing), a place withdrawn from a booking (`place-withdrawals.ts`) and a taken-up offer use it; a class place was
previously offered as court time on the class's court and day, which no class waiter ever matched.

## Decision 5: a class called off closes its list and tells its coach

`cancelClassSession` ends the class's waiting and offered entries (`cancelled`, link dead, unsent offer message given up) in the same transaction, after the class row lock
(joining takes the same lock, so a join is closed with the rest or refused `CLASS_CANCELLED`); the telling of the cancellation (`tellClassCancelled`, which every route
shares) tells each of them once and the class's coach once (`coach_lesson`, by email, keyed by entry and class, so a retry writes nothing twice). Changing a class's coach
(`changeClass`) tells the coach who stops and the coach who starts. Sibling paths were looked at and not changed: lesson (coaching) waiting lists and open-game waiting
lists have their own queues and are not in this code.

## Consequences

- Offers outlive nothing: a live offer never holds a court or a class place past the start of the session it is for.
- A person offered a place late is told how long it holds; a person whose offer lapsed is told it did.
- Two behaviours the audit proposed were not built: offering several class places at once, and an overnight pause (above).
- Customer text (four languages) and staff text (three) are in the dictionaries under the prefix `fx2.` and `hold.offer*`.
