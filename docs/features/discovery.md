# Finding venues

Authoritative for how customers find courts: the front page, search, courts near me, facilities and photos, reviews, notices, search engines and installing as an app.
Status: [feature status](../product/feature-status.md#marketplace-and-discovery).

## Finding a court from the front page

The home page starts the search: tap an activity (the eight most venues
offer are buttons, the rest a list), a day (today, tomorrow, or
another), a time of day (morning, afternoon, evening) and, if wanted, *Near
me*, then *Show free courts*. That opens the search with all of it filled in
— `/search?sport=badminton&date=…&from=17&to=23&near=…` — so a search can be
shared or bookmarked too. The venue list stays below for browsing.

The menu is four items — *Find a court*, *Classes*, *Play* (open games,
tournaments and leagues together, at `/play`) and *My Booking* — and a
venue's page puts its booking grid straight after its photos, with its
facilities, map and live crowd below.

The search page works the same way: the time of day is one tap — *Any time*,
*Morning*, *Afternoon*, *Evening* — and *Custom…* opens the from and until
hours for anyone who wants an exact window. The activities to pick from are
the ones somebody here has a court for, grouped by kind (racket sports, team
sports, the pool, the water, fitness, studios, specialist) and folded to the
chosen one's group when there are many; a box finds one by any of its names
or the words people use for it here (*takraw*, *ping pong*, *bulu tangkis*),
and `?q=` does the same in the address
([activities](activities.md#search-and-discovery)). How long is 30, 45, 60,
75, 90, 120, 150 or 180 minutes, or whole hours up to twelve, and picking an
activity asks for its usual length (padel's 90 minutes). A result is a start each court's
[booking rules](booking.md#booking-rules-starts-lengths-buffers) allow, for a
length they allow, free for all of it, buffers included. A resource whose
rules ask for a staff sign-off or a recorded certification first
([sign-offs](activities.md#sign-offs)) says so on the result
(*needs the venue's sign-off*), as on the venue's grid; for a signed-in
account that says who is taking part, it says each one's status instead
([who is taking part](#who-is-taking-part)).

**Kinds of kit under one heading** ([activities](activities.md#pricing-a-booking-with-places))
show in search under it: a result at a venue with *Kayaks* over *Single
kayak* and *Double kayak* says *Kayaks: pick a kind* and lists every kind
under it that takes the length asked for, each as itself: its own price for
that time (each, for one place), its own places left, *not free then* where
it is full or cannot start then, and what its rules ask for first. Nothing
adds the kinds up: two single kayaks and three doubles are never *5 kayaks*.
A heading shows only when one of its kinds is free at that time; the result
itself is still the venue's cheapest free resource, its others counted as
before, less the kinds already listed. A free kind goes straight to booking
it on the venue's page; *See all Kayaks here* opens the venue's page at
that date and time with the heading marked and every kind under it, each
with its own availability and price. The venue's page reads `heading=` from
the address for this, beside `court`, `start` and `minutes`. It costs the
search no queries: the kinds are worked out from the courts, claims and
prices it has already read (`searchAvailability` in `src/lib/store.ts`,
`tests/search-groups.test.ts`). On a phone, *Area* and the
must-haves (showers, parking and so on) fold under *More filters*, which says
how many are on; *Near me* stays in view.

**Returning guests.** After a booking, class or waiting-list place made without
an account, the name, phone and email are kept in that browser only
(`localStorage`), so the next booking on that device is filled in. *Not
Aisyah? Clear* forgets them. Nothing is sent anywhere for this, nothing is
kept on the server beyond the booking itself, and a browser that refuses
storage (private windows, blocked site data) just asks again.

### Who is taking part

Until a signed-in account says who is taking part, the badge on a resource
that needs approval is the same for everybody: the requirement
(*needs the venue's sign-off*, *needs a recorded certification*), never a
suggestion that anybody's eligibility was looked at. Signed in, the search
page offers *Who is taking part?*: *Myself* and each person the account
manages ([ADR 0023](../architecture/decisions/0023-participants-apart-from-accounts.md)),
any one of them or several. Nobody chosen, the account holder is not assumed
to be the one taking part: the badge stays the requirement and the page asks
them to choose. With somebody chosen, each badge names each one's status for
that activity there: *approved*; *approval required* (*certification
required*); *application pending*; *more information required*; *in-person
assessment due*; or *approval expired* (*certification expired*). One taken
back reads *approval required*. Several are each named (*Aisha: approved;
Ben: approval required*), and the badge is green only when every one of them
is approved, so a booking for several is never shown as possible when one of
them is not. The venue's grid labels its resources the same way, from the
same choice. The choice is kept for that browser tab only
(`sessionStorage`), never on the server or in the address, and forgotten
once the account is signed out (`src/components/WhoTakesPart.tsx`).

Statuses are worked out from what is already recorded, never stored
(`src/lib/eligibility.ts`). First, a sign-off or certification in force on
the day searched, by the rule booking uses for whose one counts
(`signOffWho` in `src/lib/sign-offs.ts`, shared by both): the account
holder's own, or a participant's own, online only for an account that acts
for them now; in the scope booking uses: the branch that gave it, or every
branch of its business where it was given for all of them; for that
activity (or anything there); of the kind the resource asks for (a sign-off
does not meet a certification). Otherwise an application still open at that
venue for that activity: for the account holder, one they made; for a
participant, the participant's own, whichever of their guardians made it.
The status follows the participant, not who applied: guardian A applies and
the venue approves, and guardian B, who acts for the same child, sees
*approved*; A's application still waiting reads *application pending* for B
too. Otherwise *expired* where one ran out before the day, and *required*.
Nothing from one venue counts at another, nothing for one activity counts
for another, and a participant the account does not act for now (another
family's; after a guardian's relationship was revoked or while it is paused
for review; or an adult whose request to become a guardian still waits)
gets no line at all. Who applied, who assessed, who holds the sign-off, who
may see the status and who may open the documents stay apart: the answer is
a status per person per resource only, never an application's details,
answers, declarations or documents, which stay the applicant's, the venue's
staff's and its named reviewers' ([sign-offs](activities.md#sign-offs)).

It is a guide. Booking, the door code and every other path check again at
the time, so a badge that said *approved* before the sign-off ran out or was
taken back books nothing.

What it costs: one query for the page, for the people chosen over the venues
on it whose resources ask for anything; none when nothing on the page asks or
nobody is chosen, and anonymous search reads nothing more than before.
Sign-offs are found by account, participant or proved number, each through an
index (migration 0150 added the number's), never by reading the table. A
personalised answer is sent `Cache-Control: private, no-store` with
`Vary: Cookie`, so no shared cache keeps it or gives it to anybody else; a
search without `taking` is the public one, as before
([HTTP API](../architecture/http-api.md)). Tests:
`tests/search-eligibility.test.ts` (every status, guardians and several
children, recognition by venue and business, a stale badge refused at
booking, cache isolation, query count and index use, on PGlite and
Postgres), `tests/guardian-eligibility.test.ts` (the other guardian sees
pending, more information, approved, expired and taken back on the first
one's application, on the grid and in search, privately, one query; never
the application or its documents; nothing for an adult whose request
waits, a stranger or an ended guardian) and
`tests/components/who-takes-part.test.tsx` (the choice and the badges, the
grid's label, each language).

## Courts near me

On the home page and the search page, *Near me* uses the phone's location,
or a place typed (Bangsar, KLCC, a postcode) is looked up on the map. The
venue list is then nearest first, with how far each is; search finds free
courts within 5, 10, 25 or 50 km, nearest first at each time. The address can
be shared: `/?near=3.146,101.67&km=10`, and `/api/venues` and `/api/search`
take the same `near` and `km`.

Search results can be sorted three ways (`sort=` on `/api/search`):

- **Soonest**, the default: by start time, the nearest venue first at each.
- **Nearest**, offered only once there is a place: one row per venue, the
  closest first, with every free start time under it as a button straight to
  booking — for "the closest place with anything tonight".
- **Cheapest**: one row per venue, the one with the cheapest booking first.

Each venue and time is still its cheapest court whichever way it is sorted.
Following a result or a card from a search near somewhere carries the place
along, so the venue's page says "6 km from Bangsar" (or "from you") beside
*Directions*. Distances are as the crow flies, not by road.

It uses each venue's pin. Venues that signed up place one; staff move it, or
add one to a venue that never had one, under *Venues & staff* (*Move the
pin*). A venue with no pin is not found by distance. A live venue moving its
pin more than 1 km is reported to the platform owner. Distances are worked out
in SQL, inside a box drawn around the circle first, so a search near KL never
looks at a venue in Johor.

## Facilities: what players compare

What a venue has besides its courts, and what each court is like, so players
can compare venues and search by it.

- **Worked out, never typed:** per sport, how many courts and the cheapest
  hour, and the opening hours — from the courts themselves, so they cannot
  go out of date.
- **Ticked by the venue, from a fixed list** under *Venue details →
  Facilities*: showers, changing rooms, lockers, toilets, free or paid
  parking, near LRT/MRT, surau, drinking water, café, pro shop, racket
  stringing, equipment rental, coaching, wheelchair access, first aid, Wi-Fi,
  spectator seating. A fixed list rather than free text, so two venues can be
  put side by side and searched; anything else belongs in a photo caption.
- **Per court**, under *Courts & rates*: indoor or outdoor, air-conditioned,
  floodlit, and for court sports the surface (wooden floor, court mat, hard
  court, clay, artificial turf, interlocking tiles, concrete). Saved as soon
  as it is changed.
- **Players see** a *Facilities* panel on the venue's page (per sport: courts,
  indoor/outdoor, air-con, surface, from-price; then the facilities), and up
  to four highlights on each card: air-con or indoor, floodlights, then
  showers, parking, surau and LRT/MRT, in that order.
- **Players filter** by *Must have* chips on the home page and in search:
  air-con, indoor, showers, parking (free or paid), surau, near LRT/MRT
  (`?has=aircon,showers`). In search the court chips are the ones that mean
  something for the chosen activity (outdoor and floodlit for football, none
  for kayaks); amenity chips are always offered. Court features apply to the same court as the
  sport asked for: air-con badminton finds venues with an air-conditioned
  badminton court, not any air-conditioned room. In search, only courts with
  the feature are offered.
- What a venue ticks is its own claim. Photos are what back it up.

## Venue photos

A cover and up to five more, under *Venue details → Photos*. All optional:
nothing waits on them, going live included, and the setup checklist only
suggests them.

- **Only real pictures.** JPEG, PNG or WebP, up to 15 MB and 50 megapixels,
  checked by what the file is rather than its name, and by the decoder as
  well as the first bytes. SVG — a program as much as a picture — GIF and
  everything else are refused. Thirty uploads an hour per address.
- **Drawn afresh, never kept as sent.** Each is turned the way the camera
  held it and re-encoded as WebP (quality 78) at 400, 800 and 1600 pixels
  wide, never enlarged. Only the pixels survive: no GPS position, no camera
  details, nothing a crafted file could carry. The original is not stored.
  WebP rather than AVIF, which is a fifth smaller but takes seconds of
  processor per photo on a small server.
- **Never in the way.** Every picture is lazy-loaded, sized by the browser
  from the three widths, and sits in a box of fixed shape filled with its own
  main colour until it arrives, so nothing jumps and the booking grid never
  waits for one. Search results get a small thumbnail; cards get the cover,
  and a venue without one gets its sports' icons in the same space, so no card
  looks lesser for having none. Photos play no part in the order venues are
  listed.
- **Where they are kept.** In their own bucket when `PHOTOS_S3_*` is set — not
  the backup bucket, which must stay private and whose key may only upload —
  served straight from `PHOTOS_PUBLIC_URL` when it is set (an R2 public
  bucket, or a domain in front of it), otherwise through `/photos/...` on this
  server. With no bucket, in `photos/` in the data folder. Either way they are
  not in the database, so backups do not grow with them. Every file name is
  new, so browsers and caches keep them for a year.
- **Looked at.** Going live asks the platform owner to confirm any photos show
  this venue. Photos added since are listed for the owner under *New photos*
  for 14 days, with *Remove*. A draft deleted for going stale takes its photo
  files with it.

## Reviews

Stars and a few words about a venue, from somebody who played there
(`src/lib/reviews.ts`, `venue_reviews`, migration 0058).

- **Only after playing.** A review is written from a booking that went ahead
  (not cancelled, not a no-show, and paid for or checked in: the desk's check-in, or a
  customer's own that staff confirmed, never a tap on a link alone), from when it
  ends until 60 days after,
  through a link signed for that booking (`/review/<code>?t=…`, no phone
  number in it). My Booking and the account page show *Rate your visit* on
  past bookings. Nobody can review a venue they have not booked.
- **Asked once.** A couple of hours after a customer's first visit to a venue
  (up to three days after), one email asks how it was, if the booking has an
  email address. It says it is the only time, and it is: never again for
  that venue, answered or not. Email only, never WhatsApp. A venue can turn
  it off under *Venues & staff → Reviews*. The email goes only for a booking
  the link will accept: the invitation and the link ask the same question
  (`reviewable`, one function: paid, or free, or attendance verified), so
  nobody is sent a link that refuses them. A booking the link would refuse
  (left unpaid, never checked in, or a customer's own check-in staff have not
  confirmed) gets no email and **does not use up the one invitation**: a later
  booking that counts is asked about, and so is this one once the desk marks
  it paid or confirms the arrival, while it is still within the three days
  ([ADR 0062](../architecture/decisions/0062-passes-memberships-and-concessions-decided-once-and-on-the-session-date.md);
  `tests/reviews.test.ts`).
- **One per number per venue.** Writing again replaces the earlier review,
  so a regular counts once, with what they think now.
- **The rules are said before posting:** what is shown (first name and
  initial, stars, the month played), no phone numbers, links or abuse, the
  venue can reply, and a review that breaks the rules can be removed. Links
  and phone numbers are refused outright.
- **Shown** on the venue's page, newest first, with the venue's replies and a
  line saying every review comes from a booking that went ahead. The average
  shows by the venue's name, and as `aggregateRating` in its structured
  data, only from three reviews up.
- **The venue** replies publicly (managers), and can report a review to the
  platform, saying which rule it breaks; it stays up until decided. The
  panel says negative reviews are not removed for being negative.
- **The platform's owners** see the reported ones, and hide a review (the
  venue is emailed why) or show it again. Hidden reviews do not count in the
  average.
- **Personal data:** reviews are in the customer's data export and in a
  venue's export for a phone number, and closing an account deletes the
  reviews written from it.

## Notices, and keeping the front page fair

The marketplace does not sell placement. No venue can pay, or post its way,
to the top of the front page or of search: venues are listed in a fair order
that changes by the day, or by distance when the customer asks for nearby.

- **A venue's own notices.** Under *Venue details → Put up a notice*, its staff
  put up a line for some days — an event, a promotion, a change of hours —
  with an optional link to a page on this site (their tournament, league or
  classes). It shows on the venue's own page, and on the home page of its
  storefront domain (up to three, for a business with branches). It never
  shows on the marketplace's front page or in search.
- **The site-wide notice.** Only the platform owner can set the one notice on
  the marketplace's front page (*Venues & staff → Site-wide notice*). It is
  for what concerns every player — a government programme, a large
  collaboration — never one venue's promotion.
- **Text only, links only inward.** 160 characters, up to 60 days at a time,
  and a link must be a path on this site, so a notice cannot send a customer
  to a page that pretends to be the venue. Staff can take theirs down; the
  platform owner can take down any.

## Search engines and installing as an app

**Search engines** are given what a visitor could find from the home page and
nothing else (`src/lib/seo.ts`):

- `/sitemap.xml` lists the public pages and every venue that is live and
  public, or members-only but kept in search. On a storefront it lists that
  storefront's venues under its own address.
- `/robots.txt` keeps crawlers out of `/admin`, the API, accounts, My Booking,
  receipts, acknowledgement and waitlist links, and sign-in pages, and points
  at the sitemap.
- Each venue page has its own title and description ("Arena — Badminton and
  Futsal in Petaling Jaya"), a canonical address, an Open Graph image from its
  first photo for shared links, and a schema.org `SportsActivityLocation`
  (address, map pin, opening hours, sports). A private venue, a members-only
  one kept out of search, a draft or a suspended one asks not to be indexed.

**Installing as an app**: `/manifest.webmanifest` lets a phone, or the front
desk's tablet, add the site to its home screen and open it full screen in the
site's teal. The icon is drawn at `/app-icon/192` and `/app-icon/512` from the
first letter of `SITE_NAME`, so an install under its own name gets its own
initial with no image files to make.
