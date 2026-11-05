# Users and journeys

Who uses MySenam and how they get through it, from the code as it is on
24 October 2026. Each step links to the document that specifies it; whether
it is built and tested is in [feature status](feature-status.md). This page
does not repeat the rules: it shows the path, and where the path has gaps.

## Who uses it

Two kinds of account exist: **staff** (`admins`, signing in at `/admin`) and
**customers** (`users`). Everybody else on this page acts through one of
those, or through a private link, or not at all.

| Person | How they exist in the code | What they may do |
| ------ | -------------------------- | ---------------- |
| **Platform owner** | A staff account with no venue and no business | Everything on the install: approve venues going live, invoices, suspensions, reports of players, errors and alerts ([marketplace](marketplace.md)) |
| **Venue owner** | Not a role of its own. Whoever signs a venue up becomes its **business manager** | As business manager, below |
| **Business manager** | A staff account with a business (`admins.business_id`) | Every branch of their business: settings, staff, branches, reports ([tenancy](../architecture/tenancy.md)) |
| **Venue manager** | Branch staff with the manager role | Their venue only: courts, prices, policies, payment account, refunds, classes, tournaments, leagues, reports, and its front-desk staff ([tenancy](../architecture/tenancy.md#managers-and-front-desk)) |
| **Front desk** | Branch staff with the desk role | The day's work: bookings, payments at the counter, check-in, hire; not prices, refunds or set-up, which it sees read-only ([what the front desk is shown](../architecture/tenancy.md#what-the-front-desk-is-shown)) |
| **Coach** | Not an account: a name the venue lists, with a private link | Their own hours, time off and lessons on the link's page; a calendar feed ([programmes](../features/programmes.md#one-to-one-coaching)); their own guide at the same link, saying what they can and cannot see ([venue guide](../features/venue-guide.md#the-operating-playbook)) |
| **Class instructor** | A name on a class | Nothing in the app |
| **Tournament organiser** | Not a role of its own: a venue manager | Set up, draw, correct and resolve ([tournaments](../features/tournaments.md)) |
| **Tournament official** | Not an account: a private link for one tournament | Enter results for that tournament's matches still to be decided ([tournaments](../features/tournaments.md#results)) |
| **Customer** | A person who books, with or without an account (`users`) | Book, pay, change and cancel their own bookings; with an account, everything below |
| **Player** | A customer with an account | Games, tournaments, leagues, groups, a playing profile ([matchmaking](../features/matchmaking.md)) |
| **Open-game host** | A player who opened a game on their own booking | Decide who joins, invite, move or call off the game ([matchmaking](../features/matchmaking.md#hosting-and-joining)) |
| **Participant** | Not an account: somebody who takes part where that is not the account holder (a child a parent books for, a person staff add at the counter): `participants`, by id ([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)) | Nothing themself; their eligibility (sign-offs, inductions, waivers) is theirs alone. May later be linked to their own login, which then holds their history and eligibility |
| **Guardian of a participant** | A customer account with a declared relationship to a participant (`participant_guardians`), or a name and number a venue's staff recorded at the counter | Book, apply, agree to waivers and be told for them; give a second guardian or the participant's own login a code; stop being their guardian ([applying for somebody you manage](../features/activities.md#applying-for-somebody-you-manage)) |
| **Guardian on a tournament entry** | Not an account: a name and a tick on a minor's tournament entry, as the entrant declared them | Nothing in the app ([tournaments](../features/tournaments.md#setting-one-up)) |

A venue's staff and coaches each have a guide to their own part of running the venue, written from that venue's saved configuration and held to what their role may do: a manager's, the front desk's (`How to run it` in the dashboard's *Guide* tab) and the coach's own page ([venue guide](../features/venue-guide.md#the-operating-playbook)).

**The account holder, the booker, the payer and the participant are not
assumed to be one person.** An adult booking for themself is all four, as
before. A parent booking two children is the account holder, booker and
payer; the children are the participants, each taking a place, and the
parent takes one only if booked as taking part. Staff booking at the
counter act for whoever is in front of them, and are recorded as acting.
No separate emergency contact is collected for a participant: a guardian is
reached on their own number, and the emergency number on the door screen
is the venue's. Every eligibility check is about the person
taking part: the account holder's own records when they take part, a
participant's own when they do, never borrowed through the account, number
or email used to book ([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)).

## Journeys

Each step is **built** (with a link), **partly built** or **not built**.
Tested in a browser means an end-to-end check or an acceptance scenario
drives it ([testing](../development/testing.md#visual-acceptance-scenarios));
most steps are tested only by route and unit tests.

### A venue operator: from sign-up to the first busy evening

| Step | Status | Where |
| ---- | ------ | ----- |
| Sign up at `/list-your-venue`, confirm the email | Built; signing up tested in a browser on an install that sends no email, so the account opens at once and the emailed link is not followed | [Marketplace](marketplace.md#running-the-marketplace) |
| Set up the draft: courts from templates, opening hours, staff | Built; a banner lists what is missing; adding a court with its rates and checking the hours from the checklist tested in a browser | [Activities](../features/activities.md), [booking](../features/booking.md) |
| Prices, peak bands, booking rules, cancellation policy | Built | [Pricing](../features/pricing.md), [booking](../features/booking.md#booking-rules-starts-lengths-buffers) |
| Connect the venue's own Billplz or Stripe account | Built; live accounts never verified | [Payment gateways](../integrations/payment-gateways.md) |
| Ask to go live; the platform owner checks and approves | Built; tested in a browser | [Marketplace](marketplace.md#checking-a-venue-is-real) |
| Take bookings, see them on the day list | Built; tested in a browser | [Booking](../features/booking.md) |
| Daily work: check-in, counter payments, moving and cancelling, hire, notes | Built; changing a booking's time tested in a browser | [Venue operations](../features/venue-operations.md) |
| Reports, exports, the monthly invoice | Built | [Reporting](../features/reporting.md), [marketplace](marketplace.md) |

Gaps: on the staff dashboard, in Malay or Chinese, text the
server composes still reads in English ([known limitations](../roadmap/known-limitations.md#languages)).

### A player booking a court

| Step | Status | Where |
| ---- | ------ | ----- |
| Find a venue: search, near me, by activity and time | Built; tested in a browser | [Discovery](../features/discovery.md) |
| Choose the activity, day and a free time | Built; tested in a browser | [Booking](../features/booking.md) |
| Book, with or without an account (a phone check for a new number) | Built; tested in a browser | [Booking](../features/booking.md), [authentication](../architecture/authentication.md#checking-a-customers-phone-number) |
| Pay online, or at the counter | Built; the online leg is never verified against a live gateway | [Payments and credit](../features/payments-and-credit.md) |
| Confirmation by email with a calendar invite | Built; delivery never verified | [Messaging](../integrations/messaging.md) |
| Attend: check in at the desk or by QR | Built | [Venue operations](../features/venue-operations.md#check-in-and-live-crowd-levels) |
| Change the time, cancel, book again, from `/my-booking` | Built; changing the time (and its refusals) and cancelling tested in a browser | [Booking](../features/booking.md#changing-the-date-or-time) |
| A taken time or a full class: join its waiting list; leave it, or turn an offer down, by its link | Built; component and route tests, not walked in a browser | [Booking](../features/booking.md#leaving-and-turning-an-offer-down) |

### A tournament organiser

| Step | Status | Where |
| ---- | ------ | ----- |
| Create a tournament, or a competition with divisions | Built | [Tournaments](../features/tournaments.md#setting-one-up) |
| Choose the sport's template and rules; who may enter | Built | [Tournaments](../features/tournaments.md#setting-one-up) |
| Players enter and pay; a waiting list | Built; entering tested in a browser | [Tournaments](../features/tournaments.md) |
| Make the draw; fixtures scheduled on the courts held | Built | [Tournaments](../features/tournaments.md#the-draw-and-the-schedule) |
| Results by staff, officials or the players; disputes settled by staff | Built; reporting, confirming and a dispute tested in a browser | [Tournaments](../features/tournaments.md#results) |
| Corrections after the knockout began | Built | [Tournaments](../features/tournaments.md#corrections-after-the-knockout-has-begun) |
| Finish; the courts left over go back on sale | Built | [Tournaments](../features/tournaments.md#court-time) |

Gaps: setting up and drawing a tournament, and corrections, are not driven in
a browser; nothing announces the next match on the day
([roadmap](../roadmap/roadmap.md)).

### An open-game host

| Step | Status | Where |
| ---- | ------ | ----- |
| Open a game on their own booking | Built | [Matchmaking](../features/matchmaking.md#hosting-and-joining) |
| Recruit: the public list, invitations, a link, a group, players suggested | Built; tested in a browser | [Matchmaking](../features/matchmaking.md#invitations-links-and-private-games) |
| Review requests, accept or decline | Built; tested in a browser | [Matchmaking](../features/matchmaking.md#where-somebody-stands-in-a-game) |
| Manage players: remove, mark a no-show, the waiting list | Built; the waiting list tested in a browser | [Matchmaking](../features/matchmaking.md) |
| Move the game to another time, with the players' agreement | Built; tested in a browser | [Matchmaking](../features/matchmaking.md#moving-a-game-to-another-time) |
| Call it off, keeping the court, or end a weekly game | Built; tested in a browser | [Matchmaking](../features/matchmaking.md#weekly-games) |

Gaps: hosts and players cannot write to each other in the app ([roadmap](../roadmap/roadmap.md)).

### A player looking for a game

| Step | Status | Where |
| ---- | ------ | ----- |
| Set preferences: area, distance, days, level, price | Built; tested in a browser | [Matchmaking](../features/matchmaking.md#suggested-games-and-players) |
| See suggested games with their reasons, or emails of them | Built; suggestions tested in a browser | [Matchmaking](../features/matchmaking.md#emails-of-suggested-games) |
| Ask to join; hear the answer | Built; tested in a browser | [Matchmaking](../features/matchmaking.md#hosting-and-joining) |
| Pay a share, online or at the counter | Built; at the counter tested in a browser, online needs a live gateway | [Matchmaking](../features/matchmaking.md#hosting-and-joining) |
| Play; answer if the game moves | Built | [Matchmaking](../features/matchmaking.md#moving-a-game-to-another-time) |

Gaps: levels are self-declared, not earned from results
([roadmap](../roadmap/roadmap.md)).

### A coach

| Step | Status | Where |
| ---- | ------ | ----- |
| Be listed by the venue, with sports, hours and fees | Built (by the venue) | [Programmes](../features/programmes.md#one-to-one-coaching) |
| See their own lessons; set their own hours and time off, by their link | Built | [Programmes](../features/programmes.md#a-coachs-own-week-and-time-off) |
| Customers book lessons; lesson packs | Built | [Programmes](../features/programmes.md#lesson-packs) |
| What they are owed | Built, as a report for the venue; nothing is paid | [Programmes](../features/programmes.md#what-coaches-are-owed) |
| Take attendance at their own lessons, by their link | Built: a roll call per lesson (present, absent, late, excused, walk-ins) on the lesson's day; a class's instructor is still a name, so classes are marked by the desk | [Programmes](../features/programmes.md#attendance-registers) |
| Run classes, enrol participants | **Not built for coaches.** Classes are run by the venue's staff; a class's instructor is a name, not the coach | [Programmes](../features/programmes.md#classes) |

## What the journeys show

**Missing for real use** (proposed, not committed; the
[roadmap](../roadmap/roadmap.md) decides):

- Coaches cannot see or manage the classes they teach, or take attendance:
  classes and coaching are separate.
- No messages between players.
- On the staff dashboard, text the server composes is English in every language.

**Not driven in a browser** (journeys covered by route and unit tests only):
following the emailed link that confirms a venue's sign-up; a tournament's
replay of matches after a correction, moving a fixture, taking an entrant out
after the draw, and performance events (heats and finals). A venue's set-up
from sign-up to its first booking, changing a booking's time (by the customer
and by the venue's staff), a venue's change of an open game's time, and a
tournament's whole run — a competition and its divisions set up from a
sport's template, entries, closing them and the draw, results by the front
desk and an official, the final and the third-place match, and a correction
that opens a progression issue resolved by letting the results stand — are
driven by acceptance scenarios
([testing](../development/testing.md#visual-acceptance-scenarios)).
