# Tenancy, businesses and staff roles

Authoritative for the boundaries between platform, business, branch and venue, and for what each staff role may do.

## Platform, business, branch and venue

- **Platform**: one install of MySenam, with its own database. Its
  **platform owners** (`admins` with no venue and no business) see and manage
  every venue on it.
- **Business**: on a marketplace, the company that runs one or more venues.
  Its **business managers** (`admins.business_id`) manage every branch of it.
- **Venue** (also **branch**, when it belongs to a business): one place with
  courts. Its **branch staff** (`admins.venue_id`) are a manager or front desk
  and see that venue only.
- **Customer**: a person who books, with or without an account (`users`).
  Customer accounts belong to the platform, not to a venue.

Money and records belong to a venue (bookings, payments, receipts, its own
gateway account), or to a business where they are shared across its branches
(stored credit, passes and memberships under business scope); see
[whose credit it is](../features/payments-and-credit.md#whose-credit-it-is).

## Managers and front desk

Branch staff are a **manager** or **front desk** (`src/lib/roles.ts`), chosen
when they are added under *Venues & staff* and changeable there by a business
manager or the platform owner. Staff who were there before this existed are
managers, so nobody lost anything; new ones default to front desk.

| | Front desk | Manager |
| - | :-: | :-: |
| Bookings: make, mark paid (and how), check in, move, change, cancel, no-show | ✓ | ✓ |
| Kit hire, passes, memberships and credit sold at the counter, blocking an hour | ✓ | ✓ |
| Courts and prices, classes, leagues and tournaments set up | | ✓ |
| Venue details, closures, outages, who it is for, house rules, pay to hold | | ✓ |
| Payment account, refunds, voiding passes, memberships and promo codes | | ✓ |
| Promo codes, notices, photos, WhatsApp, the marketplace invoice | | ✓ |
| Reports and the staff activity log | | ✓ |

The table summarises; the rule itself is one list of addresses and methods,
`MANAGER_ONLY` in `src/lib/roles.ts`, applied in `requireAdmin` for every
admin route, so a new route cannot forget it. Anything not on that list is
open to front desk, which includes the desk tools added since the table was
written (rain-outs, weekly blocks, charging bookings to company accounts,
marking their invoices paid, customer notes, paper waivers, answering hire
enquiries). `tests/roles.test.ts` checks each line names a real route, that
front desk is refused there and a manager is not.

## Businesses with several branches

On a marketplace, every venue belongs to a business, and a business can have
any number of branches. Approving an application creates the business, with
that venue as its first branch and the applicant as its manager.

- **Managers** sign in once for every branch. The day list, schedule,
  reports, classes, credit, messages and invoices cover all their branches,
  with a branch picker wherever a screen is about one. They add and remove
  their business's staff, and add branches under *Branches & staff → Add a
  branch*.
- **Branch staff** see their own branch and nothing else.
- **New branches** start as drafts the manager sets up, and go live like the
  first one did — on the platform owner's approval, or on their own where the
  install sets `MYSENAM_AUTO_APPROVE_BRANCHES=on` and the branch's pin and
  address agree (see *Checking a venue is real*).
- **Credit, passes and memberships** bought at any branch work at every
  branch of that business, and nowhere else. A member pays each branch's
  member rate wherever they play, and is not sold a second membership at
  another branch while the first runs. A customer sees one balance under the
  business's name, and the business, not a single branch, is shown as owing
  it.
- **Venues that joined one at a time**, before businesses existed, can be put
  together by the platform owner under *Venues & staff → Businesses*,
  choosing which of their staff become managers.

**One invoice a month per business**, with a line for each branch and its
fee. Its managers pay it, online or otherwise. A venue that is not in a
business is still invoiced on its own, and invoices issued before a venue
joined a business stay as they were.

## A venue business's own copy

The same code runs as the shared MySenam marketplace and as one business's own
booking site under its own name. An own copy is a separate install with its
own database, so its customers, credit and money never sit beside anybody
else's; its owner signs in as the platform owner and sees every one of their
branches, and only theirs.

Each copy is its own Droplet, set up with the same kit
([`deploy/digitalocean`](../../deploy/digitalocean/README.md)) and with `SITE_NAME`
set in its `/etc/mysenam/env`. Every copy deploys from the same repository, and
`mysenam-deploy` on each puts the new version live; a deploy restarts the app
for a second or two, so do it outside opening hours.

## How the boundaries are enforced

Every admin route calls `requireAdmin` (`src/lib/admin-auth.ts`), which also
turns front-desk accounts away from the routes in `MANAGER_ONLY`
(`src/lib/roles.ts`); a route that names a venue then calls `denyVenue`, so
staff get a `403` for another venue's data even by calling the API directly.

That is checked by tests rather than by care. `tests/routes.test.ts` globs
every route under `/api/admin` and `/api/my`, calls each exported method with
no cookie, and fails on anything that does not answer `401`, so an endpoint
added without `requireAdmin` fails CI. On top of that sweep, the venue
boundary and owner-only routes are checked with real sessions (own venue
`200`, another venue `403`, a venue's staff on a platform-wide route `403`),
`tests/roles.test.ts` checks every `MANAGER_ONLY` line against a real route,
and `tests/branches.test.ts` covers business managers across branches. The
sweep proves a session is required; whether a route that *does* check
compares the right venue is only as good as those per-route tests.
