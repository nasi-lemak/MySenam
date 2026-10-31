# Product overview

MySenam (*"gelanggang, gim dan kelas — satu tempahan"*) is online booking and
venue-management software for sports and activity venues in Malaysia and
Singapore: racket sports, team sports, pools, water sports hire, gyms,
studio classes and specialist activities such as climbing, archery and golf
simulators, from a catalogue operators can add to without code
([activities](../features/activities.md), with which are fully supported).

It runs in two shapes from one codebase
([ADR 0005](../architecture/decisions/0005-shared-marketplace-and-own-installs.md)):
a **marketplace** where independent venues list themselves and players book
across them, and a single business's **own install** under its own name.

What is implemented, and how well it is verified, is in
[feature status](feature-status.md). This page describes; that page is the
inventory.

## Who uses it

- **Customers** find a court or class, book it with a name and phone number
  (an account is optional for a single booking), pay online or at the
  counter, and manage their bookings with the booking code or their account.
- **Front desk** staff run the day: the day's bookings, payments at the
  counter, check-in, moving and cancelling, kit hire, counter sales.
- **Managers** set the venue up: courts and prices, hours, rules, classes,
  payment account, reports.
- **Business managers** do the same across every branch of a business.
- **Platform owners** run the install: approve venues, invoice them, and see
  backups, errors and alerts.

Every role as the code has it, and the main journeys through the app, are in
[users and journeys](users-and-journeys.md).

## What it does, in brief

| Area | Highlights | Authoritative document |
| ---- | ---------- | ---------------------- |
| Booking | Exclusive courts and shared facilities with places; linked courts; bookings to the minute within booking rules (starts, lengths, buffers, notice) set by court, sport, venue or business, which managers may go past on record; "any court"; several courts at once; weekly series (8 weeks, up to 26 where a venue allows); waitlists; opening hours by weekday; closures, outages, rain-outs and weekly blocks; moving and cancelling with late-cancel rules; public, members-only and private venues | [booking](../features/booking.md) |
| Pricing | Peak and off-peak bands by weekday, weekend and holiday; public holidays filled in; last-minute prices; per-player courts; concessions; promo codes; memberships with tiers; multi-visit passes; a free hour for regulars | [pricing](../features/pricing.md) |
| Money | Paying online into the venue's own gateway account; paying to hold, or a deposit; stored credit and gift vouchers; split costs; extras; counter sales; company and school accounts invoiced monthly; refunds, receipts and credit notes | [payments and credit](../features/payments-and-credit.md) |
| Classes and coaching | Classes and terms, one-to-one coaching, women-only and men-only sessions | [programmes](../features/programmes.md) |
| Tournaments and leagues | Tournaments and competitions with divisions for any sport, scored by data-configured rules; box leagues | [tournaments and leagues](../features/tournaments.md) |
| Open games and matchmaking | Players recruiting others to a booked court, suggested games and players, invitations, weekly games, community groups | [open games and matchmaking](../features/matchmaking.md) |
| The desk | Check-in and live crowd levels, unstaffed hours with door codes, equipment hire and deposits, notes on customers, waivers, private hire enquiries | [venue operations](../features/venue-operations.md) |
| Finding venues | Search across venues, courts near me, facilities and photos, reviews, notices, search engines and installing as an app | [discovery](../features/discovery.md) |
| Reports | Period and customer reports, spreadsheet exports, a sales journal, the staff activity log | [reporting](../features/reporting.md) |
| Messages | Email, WhatsApp and SMS confirmations, reminders and urgent news, with delivery tracking; venue alerts; marketing email with consent | [messaging](../integrations/messaging.md) |
| Marketplace | Self-service sign-up, checks before going live, monthly invoices, suspension, storefront domains, businesses with branches | [marketplace](marketplace.md), [tenancy](../architecture/tenancy.md) |
| Regions | Malaysia or Singapore per install; English, Bahasa Malaysia, Chinese and Tamil; SST/GST; MyInvois e-invoicing | [regions and tax](regions-and-tax.md) |
| Integrations | Billplz, Stripe, WhatsApp Cloud API, email (SMTP or Amazon SES), SMS, MyInvois, Google sign-in, a public API and webhooks, Reserve with Google feeds | [integrations](../index.md#integrations) |

## Terms used in this documentation

| Term | Meaning |
| ---- | ------- |
| **Platform** | One install, with its own database ([tenancy](../architecture/tenancy.md)). |
| **Business** | A company running one or more venues on a marketplace. |
| **Venue**, **branch** | One place with courts; a branch is a venue that belongs to a business. |
| **Court**, **resource** | Anything bookable. "Court" is used loosely for every resource. |
| **Shared facility** | A resource with capacity above 1 (a gym floor, a pool): several people hold the same hour. |
| **Equipment** | A resource that leaves the building against a deposit (a kayak). |
| **Linked courts** | Courts that share a floor: booking one blocks the others. |
| **Booking** | A customer's hold on court time, with a code such as `MS-8F3K2A`. |
| **Enrolment** | A place in a class; stored as a booking with a class attached. |
| **Payment hold** | A booking held for a few minutes while the customer pays online, released if they do not. |
| **Reservation** | Not a separate concept in MySenam; avoid the word. |
| **Payment** | Money taken online into a venue's gateway account, or marked at the counter. |
| **Stored credit** | A customer's balance at a venue, business or platform, spent on bookings ([ADR 0007](../architecture/decisions/0007-stored-credit-ownership.md)). |
| **Refund**, **credit note** | Money given back; the credit note is the document recording it. |
| **Deposit** | Either a share of the price paid online to hold a booking, or money held against hired equipment; the documents say which. |
| **Customer**, **operator** | Whoever books; "operator" means a venue's staff collectively. |
| **Manager**, **front desk** | The two branch staff roles ([tenancy](../architecture/tenancy.md#managers-and-front-desk)). |
| **Implemented**, **live-verified**, **planned** | As defined in [feature status](feature-status.md). |
