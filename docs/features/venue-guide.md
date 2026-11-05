# The venue guide: how MySenam fits a business, the setup journey and the operating playbook

Authoritative for the three connected guides an operator meets: the public
*How MySenam fits your business*, the adaptive setup journey inside the
dashboard, and the personalised operating playbook, with the contextual help
and the discovery of further capabilities that go with them. The decision
behind them is [ADR 0028](../architecture/decisions/0028-venue-guide-as-read-models-over-real-configuration.md).
Status: [feature status](../product/feature-status.md); planned work is in the
[roadmap](../roadmap/roadmap.md).

This page says what is built. What it does not yet say is not yet built.

## What exists

The shared model all three guides are built on, in `src/lib/guide/`:

| Piece | File | What it is |
| ----- | ---- | ---------- |
| Capability registry | `capabilities.ts` | Every thing the guide may say MySenam can do, and every thing it must say it cannot, each tied to its row of [feature status](../product/feature-status.md) |
| Business types | `business-types.ts` | The thirteen kinds of business, their activities, models, illustrative profile, capabilities and workflow ids; `composeTypes` for several at once; `activityFacts` for what the catalogue says |
| Venue profile | `profile-types.ts`, `profile.ts` | `readVenueProfile(venueId)`: a read model of the venue's real saved configuration, and the same shape for illustrative examples |
| Discovery answers | `answer-schema.ts`, `answers.ts` | What a manager says about their business, validated and versioned; saved with a revision; reviews and dismissals (`venue_guide`, migration 0261) |
| Setup plan | `plan.ts`, `steps.ts` | The step registry and `buildSetupPlan`: ordered, grouped, conditional, with each step's state read from saved state |
| Launch readiness | `readiness.ts` | `launchReadiness`: six kinds of thing, no single score |
| Discoveries | `discover.ts` | Up to three capabilities that suit the venue and that it does not use |
| Routes and shell | `http.ts`, `shell.ts`; `GuideTab.tsx` | Three routes, the dashboard's `guide` tab, roles |
| Operating playbook | `playbook/` | `buildPlaybook`, the modules and topics, the coach's page ([below](#the-operating-playbook)) |
| Public guide | `public/` (`workflows.ts`, `steps.ts`, `view.ts`, `select.ts`, `present.ts`); `src/components/fit/`; `src/app/for-venues/` | *How MySenam fits your business*: [the public guide](#the-public-guide) |
| Contextual help | `help.ts`, `HelpTip.tsx`, `playbook/topics.ts`; `GET /api/admin/guide/topic` | The "?" beside a control: a topic of the playbook, read on demand ([below](#contextual-help-and-discovery)) |
| Discovery view | `help-catalogue.ts`, `DiscoverView.tsx` | Suggestions with their reasons, and everything MySenam can do, marked in use, available or not currently supported ([below](#contextual-help-and-discovery)) |

The tab's setup view is [the setup journey](#the-setup-journey) and its
playbook view is [the operating playbook](#the-operating-playbook). Its discover
view is [contextual help and discovery](#contextual-help-and-discovery). The
checklist at the top of the dashboard is unchanged, with one added line that
opens the guide; the plan's first three steps are its three steps, read from
the same answers (`venueSetup`), not recomputed.

## The venue profile

`readVenueProfile(venueId, { today? })` (`src/lib/guide/profile.ts`) reads
what the venue has, through the lookups that already own each fact: the rates
in force on a date by `ratesOn` and the usual hours by `hoursFor`, with those
set from a later date apart as *scheduled*; the cancellation terms by
`cancelPolicy`; the checklist's answers by `venueSetup`; what stops a draft
asking to go live by `goLiveStatus`; test bookings by `standingTestBookings`
and `paidStandingTests`; and the rest by counting the tables that hold them.
It writes nothing (it does not apply a change whose date has come: it reads the
one in force). It is computed on each request: there is no store, so nothing to
invalidate and nothing that can be shown to another venue. It costs a few dozen
small indexed queries per request; a route that needs the profile for the
plan, the readiness and the discoveries reads it once.

Its sections: `identity` (draft, live, suspended; visibility; the install's
country, currency and languages), `history` (real bookings, paid bookings,
online payments, receipts; test bookings apart), `activities` (each with its
support level read from the catalogue; `null` for an operator's own),
`resources` (by model; shared, linked, with buffers, priced, per person,
unmanned), `hours` and `rates` (in force, and `scheduled`), `policies`,
`channels`, `payments`, `staff`, `people` (coaches, classes, lessons),
`commerce` (plans, passes, concessions, promo codes, extras, hire deposits,
company accounts), `programmes`, `guardians`, `access`, `compliance`
(e-invoicing, deduction-tax review, booking alerts), `branches` (venues in
the business; started from another's set-up, read from the staff log, so
unknown once that entry is past its retention), `install` (an email service
and WhatsApp are configured, never how), `setup` and `goLive`.

It holds **counts and settings, never a key, a credential, a tax
identifier, or the name, number or address of a person**
(`tests/guide-profile.test.ts` scans it for each). The pure helpers
`isEmptyVenue`, `hasHistory`, `usesOnlinePayments`, `takesCounterPayments`,
`usesEInvoicing`, `hasCoaching`, `hasMultipleBranches`, `hasProgrammes`,
`offersActivity`, `modelsInUse` and `hasScheduledChanges` are beside the type
(`profile-types.ts`, browser-safe). An established venue is told from an empty
one by `hasHistory`: real bookings, payments or receipts.

*Today's* policy is never the scheduled one: a price or hours change from a
later date is in `rates.scheduled` / `hours.scheduled`, and `lowest` /
`highest` / `hours` are those in force on `today`.

## The capability registry

`CAPABILITIES` (`src/lib/guide/capabilities.ts`, browser-safe) is the one list
of what the guide may say MySenam can do. A `Capability` has an `id`; a
`group` (booking, pricing, memberships, programmes, access, people, money,
communication, compliance, multi-branch, reporting, integrations, platform);
a `status` (`available` or `unsupported`); `titleKey` and `blurbKey` (and, for
an unsupported one, `alternativeKey`: what to do instead) in the customer
dictionaries as `gcap.<id>.title`, `.blurb`, `.alt`, in all four languages;
`requires` (`configuration`, `integration`, `approval`) with `integrations`
(`billplz`, `stripe`, `email`, `whatsapp`, `myinvois`) when it needs one;
`featureRow`, `limitation`, `activityNote`; `configure` (the dashboard tab
that has it); `staffAction` (who may use that screen); and `models`.

The rules, held by `tests/guide-capabilities.test.ts`, which parses
[feature status](../product/feature-status.md) and the register:

- **An available capability names the exact row it rests on**, and that row is
  `IMPLEMENTED_AND_TESTED`, or `INTEGRATION_VERIFICATION_REQUIRED` with
  `requires` listing `integration`. A row that pays or messages through a
  service and is otherwise implemented still lists its integration and names it
  in the row's gaps. A capability whose row is partial, planned, blocked or
  unsupported cannot be `available`: if it is not found in feature status, it
  is not available.
- **An unsupported capability says what it is and what to do instead**, and
  rests on one of: a feature-status row that says it is not built or blocked,
  an anchor in [known limitations](../roadmap/known-limitations.md), or the
  `supportNote` of an activity in the catalogue (`activityNote`). Where the
  register has no line for one, say so in the capability's own words and no
  more.
- **Every title, blurb and alternative is in all four customer languages**
  (English first and authoritative; Malay, Chinese and Tamil are
  machine-assisted and await native review, like the rest of the app's). Staff
  screens read them through `t.customer`.
- **Who may use the screen is always stated**: a `STAFF_ACTIONS` name
  (`src/lib/roles.ts`), or `null` for a screen the front desk uses too. A link
  is shown only to a role `staffMay` allows.
- The guide's five words for what a capability needs come from
  `availabilityOf`: available now; available with configuration; requires an
  external integration; requires the operator's approval; not currently
  supported.

The registry also keeps the guide honest about the activity catalogue: what an
activity's support level and `supportNote` say is read from
`src/lib/activity-catalogue.ts` (`activityFacts`), never copied.
A WhatsApp number of the venue's own, web push, a
store app, demand pricing, referral credit, Billplz refunds, booking from
Google, smart locks and per-person door credentials are registered as
unsupported, each with what to do instead. A range officer, lifeguard or
instructor on a roster (`range-officer`, resting on the feature-status row
*Supervisor rosters and supervision rules*, not tied to an activity) is an
available capability, and archery, whose one gap it was, is fully supported.
Selling bowling by the game, with
the lane given on arrival, is an available capability tied to its activity
(`activityNote`): choosing bowling lists it. Where a venue's lanes are given on
arrival, the playbook's check-in steps say how the desk gives the lane. Gym entry without
booking a session (`gym-walk-in`, tied to the gym) and day passes with no set
time (`open-day-pass`, tied to climbing) are available capabilities resting on
the feature-status rows *Entry with no set time* and *Day passes*
([entry](venue-operations.md#entry-with-no-set-time)); where any resource
takes entries, the playbook's `during.entry` topic says how the desk admits
and checks people out, and the setup journey's `entry` step offers it where
the venue has climbing, bouldering or a gym floor with places.

## Business types

`BUSINESS_TYPES` (`src/lib/guide/business-types.ts`, browser-safe): badminton
and pickleball; futsal and football; tennis and padel; multi-sport; gym and
fitness; swimming; climbing and bouldering; coaching academy; equipment
rental; archery and other supervised sports; club and community; school and
corporate; mixed. A type is a *starting point*, not an engine: its catalogue
`activities`, the resource `models` they use, an **illustrative** `profile`
(of the profile's own shape, `illustrative: true`, never read from a venue),
the `capabilities` typical for it (available and unsupported alike, so a gym
shows its warning), and its `workflows` by id (`WORKFLOW_IDS`; the workflow's
own content is written where it is shown). Its name is `gbt.<id>` in the
customer dictionaries. `composeTypes(ids)` is the union of several, with the
types each activity, capability and workflow came from, and an illustrative
profile whose counts add and whose features are on if any type has them.

## Discovery answers

What no saved state can show yet (`src/lib/guide/answer-schema.ts`,
browser-safe; `GuideAnswers`, version 1): `types`, `activities` (catalogue
keys), `customersDo` (reserve, classes, memberships, hire), `resources` (one,
few, several, many), `branches` (one, several), `staffing` (staffed, partial,
unattended), `channels` (online, counter), `memberships` (memberships,
passes; an empty list is *answered: neither*), `coaching`, `children`,
`audience` (public, members, both), and, added for the setup journey without
changing the version (both optional), `competitions` (wants tournaments or
leagues) and `discounts` (wants concessions or promo codes). A fact the profile already shows is never
asked again.

`validatePatch` refuses unknown keys and values and over-long lists rather
than dropping them; a `null` takes an answer back; `readStored` reads a stored
row defensively (an unknown key is left out, never thrown over).

Saved in `venue_guide` (migration 0261): `answers`, `acknowledged`
(`{ stepId: { at, byAdminId, byName } }`), `dismissed`
(`{ id: { at } }`), `rev`, `updated_at`, `updated_by`. `readGuide(venueId)`
answers an empty state at revision 0 for a venue that never saved.
`saveAnswers(venueId, patch, expectedRev, actor?)` applies the patch only if
the venue is at `expectedRev`; otherwise it refuses with the current state, so
two people saving at once never overwrite each other unseen: one wins, the
other is told what it lost to and saves again on top (tested on PGlite and
Postgres with many concurrent saves). `acknowledge` and `dismiss` add one
entry each atomically and move `rev`. A review is recorded with who and when;
it is shown as "reviewed on…" with the date and time on the venue's own clock, and nothing infers it from a click on *Next*.

### What a visitor chose

The public guide's choice travels in the address to the application form and,
only when somebody applies, is sent as `fit` (`POST /api/venue-applications`):
business types and activities (any discovery answer) that exist, at most 2000
characters, validated by `normaliseFit` (`400` for one that does not exist). It
is kept in `venue_applications.fit` and, when the application opens the venue
(`openAccount`, or approving an application made before drafts), copied once
into `venue_guide.answers` as the venue's starting intent (`seedFromFit`); it
never replaces answers a manager has saved. A branch added to an existing
business, with or without copying another's set-up, gets no row: its intent is
its own. Public pages write nothing: exploring the guide creates no record.

## The setup plan

`buildSetupPlan(ctx, registry?)` (`src/lib/guide/plan.ts`) turns the step
registry, the venue's real profile, its answers, what it acknowledged and the
role (`ctx = { profile, answers, acknowledged, role }`) into a `SetupPlan`:
items in group order (identity, resources, pricing, policies, people,
payments, programmes, launch), each with its state, why it is shown, whether
it is required for going live, what it opens and whether the role may use
that, and counts by state (no percentage).

Rules the plan keeps, held by `tests/guide-model.test.ts` and
`tests/guide-profile.test.ts`:

- **Conditional.** A step shows only when its `applies(ctx)` returns the
  sentence saying which answer or fact brought it. A venue that does not offer
  coaching is shown no coach step; one location, no branch step; counter only,
  no online payment step (unless an account already exists); no tournament step
  until a venue has a programme.
- **Done only from saved state.** A step is `done` from the profile (the
  checklist's own answers for courts, details and the test booking; an enabled
  account for online payment, shown *connected, not yet proven* until a real
  payment has been taken). A `review` step is done only when a manager has
  acknowledged it, and says when and by whom.
- **An existing venue is never overwritten.** A step's `effect` is `open`,
  `add`, `review` or `defaults`; there is no reset. For a venue with history,
  `defaults` steps (which would write starting values) are left out of the plan
  and what the venue already has reads `done`.
- **Consequential choices say so first.** A step may carry a `consequence`
  phrase, said before the choice as the application does it (the cancellation
  review: *if customers cancel within the cutoff, your configured cancellation
  policy decides whether a refund or a charge applies*).
- **A link grants no authority.** `allowed` is `staffMay(role)[staffAction]`;
  the screens show a link only where it is true.

### Setup steps

`SETUP_STEPS` (`src/lib/guide/steps.ts`) is the one list of steps; the setup
journey ([below](#the-setup-journey)) lists each, with when it is shown, what
it opens and what it runs. Required for going live are the checklist's three
(`details`, `courts`, `test-booking`); `cancellation-terms` becomes required
once money is taken online. A step may also carry `action` (the existing
editor it runs in the journey), `after` (the steps it waits for) and
`platformRule` (a rule MySenam always enforces there); `buildSetupPlan` adds
`nature` (recommendation, saved setting or the operator's choice) and, given a
`focus`, narrows the plan to a capability or group with what it waits for.

## The setup journey

The dashboard's `setup` view (`?tab=guide&view=setup`), built into
`SetupPlanView.tsx` with `SetupDiscovery.tsx`, `SetupStepCard.tsx`,
`SetupReadiness.tsx`, `SetupTryIt.tsx` and `setup/` (`actions.tsx`, `say.ts`,
`api.ts`, `tabs.ts`); the plan it draws is `buildSetupPlan`'s, the questions
are `src/lib/guide/setup-questions.ts`, and what it reads beside the plan is
`journeyView` (`src/lib/guide/setup-journey.ts`, `GET
/api/admin/guide/setup/journey`). Staff text is in `guide-setup.ts` (`gs.`).
It owns no setting: what it saves is the manager's answers and reviews
(`venue_guide`), and every setting goes through the existing editor's or
route's own request, so the same validation, permission, log entry and
effective-dating apply, and its refusals are shown as the application words
them.

### Two stages

- **Questions** (`SetupDiscovery`), on a first visit to a venue with nothing
  set up and nothing said (`rev` 0, no bookings), or from *Review my
  business*; `?stage=questions|plan` is in the address. One question at a time,
  in this order, each an answer key of `GuideAnswers`: kinds of business,
  activities, what customers do, how many facilities, branches, staffing,
  how customers book, memberships or passes, discounts, coaching, children,
  tournaments and leagues, who the venue is for. A question the saved
  settings already answer is not asked but shown as a fact "from your
  settings" (courts exist, activities offered, a business with several
  locations, hours with nobody at the desk, online and counter payments both
  in use, plans or passes sold, concessions or promo codes, coaches, children
  or approvals, tournaments or leagues, a members-only or private venue); one
  earlier answers make irrelevant is left out (no memberships question when
  customers neither buy memberships nor join classes; no coaching question for
  kinds of business without coaching when customers do not join classes; no
  tournaments question for one facility). Every answer is saved with the
  revision it was given on, as it is given: a phone and a computer agree, a
  stale save is refused with *Somebody saved answers since you opened this*,
  the answers now saved are shown, and what was entered stays on screen to be
  saved again on top. *Back* saves the answer on screen as *Next* does, so
  going back loses nothing; *Not sure: skip* leaves a question unanswered, to
  come back to ("n questions are still open"). The activity picker lists the
  catalogue, those of the chosen kinds first, each with its support level and,
  where something is not built, the catalogue's own note as *Limitation* (a gym
  is told that entry on a membership without booking a session is not built).
- **The plan**: a counts line ("3 of 7 required steps done"; never a
  percentage), a list of steps (sticky beside the plan, a button that opens it
  on a phone, `aria-current="step"` on the step the journey is on, focus moved
  to a step's heading when it is chosen, the step kept in the address as
  `step=`), and a card for each step, in groups.

### A step's card

Title; **why it is shown** (the answer or the fact); its state in words and an
icon (done, to do, optional, to review, waiting on another step, and what it
waits for); whether it is required for going live; what it proposes, as a typed
label, never colour alone: **Recommendation** (the step says it is not a saved
setting: nothing changes until the manager saves), **Saved setting** (the
step's state is done from saved state) or **Your choice**; a **Platform rule**
where MySenam always enforces something there (bookings never overlap; the
cancellation cutoff; guardians declared, not verified); a short explanation
with the longer one folded away (`gs.more.<step id>`); **Before you save**,
the consequence of a financial or consequential choice as the application does
it; and the action. A recommendation comes only from the activity catalogue's
own `policy` (a booking length) and the platform's own defaults (the peak
window of `DEFAULT_PEAK`, the payment provider the install's region offers
first); none is invented, and none is ever saved by the journey.

### The steps

| Step | Group | Shown when | What it does |
| ---- | ----- | ---------- | ------------ |
| `details` | venue | always (required) | **Runs** `PATCH /api/admin/venues/:id` for the usual hours (the checklist's *details checked* is set by that route; refused, with the bookings in the way listed, where hours would leave one outside them) and `POST /api/admin/setup` (*they are right as they are*); `HoursFromDate` for a later date |
| `copied-branch`, `branches` | venue | a branch started from another's; several locations | Review (acknowledged); link to Venue details |
| `activities` | resources | activities were chosen | Link; done when each chosen activity is offered by a resource |
| `courts` | resources | always (required) | **Runs** `AddResourcesForm` (`POST /api/admin/courts`, the activity's template) |
| `equipment`, `shared-resources` | resources | hire chosen or hire resources; shared or linked resources, or kinds of business that share space | Link to Courts & rates |
| `entry` | resources | climbing, bouldering or a gym floor with places, or a gym or climbing business; done once a resource takes entries, else optional | Link to Courts & rates (booking rules) |
| `prices` | pricing | always; waits for a court | **Runs** `PATCH /api/admin/courts/:id` for each court's rates, from now; read-only where the venue has bookings, which are pointed to `price-dates` |
| `peak-hours` | pricing | always; waits for a court | **Runs** `PeakHoursEditor` (`/api/admin/peak-rules`, `/holidays`) and shows the example price |
| `price-dates` | pricing | rates or hours scheduled, or the venue has bookings | **Runs** `CourtChangesFromDate` and `HoursFromDate` (ADR 0027) |
| `discounts` | pricing | concessions or promo codes exist, or discounts wanted | Link to Courts & rates |
| `booking-rules` | policies | always; waits for a court | **Runs** `BookingPolicyEditor` (`/api/admin/booking-policies`) with an example of what cleaning time does to the next time offered |
| `cancellation-terms` | policies | always (required once money is taken online) | **Runs** `CancelPolicyEditor` (`/api/admin/cancel-policy`) and the cutoff (`PATCH /api/admin/venues/:id`), then a review the manager acknowledges |
| `guardians`, `participant-requirements`, `unattended` | policies | children, approvals or coaching; staffing | Review; links |
| `communications` | policies | always | Review: email, optional WhatsApp, and what MySenam cannot check |
| `staff` | people | always, unless the venue is unattended | **Runs** `POST /api/admin/admins` (an emailed invitation, or an account with a typed password where this install cannot email) |
| `coaches`, `coach-hours` | people | coaching | Links to Classes; the hours step waits for a coach |
| `counter-payments` | payments | counter payments in use or chosen | Review |
| `online-payment` | payments | online payment chosen, in use, or not yet said | Link to Venue details (credentials are never collected in the journey); *connected, not yet proven* until a payment is taken |
| `einvoicing` | payments | on, or a tax-registered Malaysian venue | Link; the compliance notice stays in readiness whatever |
| `classes`, `memberships`, `tournaments` | programmes | classes, plans or passes, or competitions wanted or run | Links |
| `test-booking` | going live | always (required) | **Runs** *Try it* |
| `launch` | going live | always | **Runs** the readiness summary |

Every embedded action is an existing component or route, so no setting has a
table or route of the journey's own. A venue with bookings is shown what it has
as done and is never offered a step that writes starting values; the rates are
read-only for it.

### Existing venues and targeted journeys

A venue with bookings, payments or receipts (`hasHistory`) is told that the
guide reviews and adds and never changes a saved setting unless it saves one
in its own screen, and is offered *Add an activity*, *Add a programme or class*,
*Add a branch*, *Invite staff* and *Review a policy*. Each opens a targeted
journey, `?view=setup&focus=<group or capability id>`: the steps of that group
or capability (`focusIds`) shown whether or not the answers asked for them, with
the steps they wait for (`after`), and no others; *Show the whole plan* leaves
it. Reading the journey, saving answers and saying a review was done change no
setting (held by `tests/guide-setup.test.ts`).

A link to another screen keeps the step in the address, so the browser's Back
button and the guide tab (always in the tab bar) return to it. The other
screens do not show their own *back to the guide* control.

### Try it, and launch readiness

*Try it* is the `test-booking` step's panel: make a test booking on the venue's
public page, see it on the staff schedule, check the price, change it, cancel it
and read the terms, take a counter payment where used, check the customer
messages, and, where online payment is on, see what is and is not verified.
Each check is ticked only from saved state where state exists (a booking made
while the venue was a draft is a test, a counter payment is on one, one was
cancelled by staff and not cleared by the banner) and says *Not checked by
MySenam* where it cannot know (a price compared by eye, a booking changed, a
message arriving). The price example is one hour at 8 pm on the next Saturday,
worked out by `quoteFor`, the function a booking is priced by, from the
venue's saved rates and peak hours. A live venue is told it is live and that a
booking made now is real; it is never encouraged to make a pretend one.
Simulated tests are not provider verification: the panel says MySenam's own
tests use stand-in payment services and that only a real payment through the
venue's own account proves the provider.

The `launch` step holds the readiness summary: the six groups of
`launchReadiness`, each item with why it is on the list and where to fix it (a
link the role may use, or *Ask whoever runs this install*), and no score. It is
not an item of its own summary.

### The checklist and the journey

`SetupChecklist.tsx` is unchanged and links into the journey; its three steps
are the journey's first three, read from the same answers (`venueSetup`), and
`tests/guide-setup.test.ts` fails if the checklist and the plan disagree about
whether a venue is set up at any stage.

### Language and accessibility

All text is in the staff dictionaries (`guide-setup.ts`: English first and
authoritative; the Malay and Chinese are machine-assisted and await review by
native speakers); money, times and dates use the staff language's own helpers.
One column, large type, folded detail, no drag-and-drop and no animation that
carries meaning; every field has a name (`tests/form-labels.test.ts`), controls
are 32 px or more, and the step list collapses on a phone.

### Not built

A step that is only a link (equipment, discounts, classes, memberships,
tournaments, coaches, online payment, the guardians settings) opens the screen
that has it. Weekday-by-weekday hours, holidays and closed days are edited in
Venue details. The journey does not connect a payment provider (credentials are
never taken here) and cannot tell whether a message arrived.

## Launch readiness

`launchReadiness(profile, plan?)` (`src/lib/guide/readiness.ts`) answers
whether the venue is ready to open in six groups, never as one number:

| Group | What is in it |
| ----- | ------------- |
| `configurationComplete` | Steps whose saved state says done |
| `optionalEnhancements` | Optional steps still open; test bookings left over after going live |
| `requiredMissing` | Required steps not done; what the application already refuses a draft for (`goLiveStatus`, as phrases in the reader's language); a test booking with a payment on it; an online payment account that is needed and not enabled |
| `unverifiedExternal` | An online account connected but with no payment taken (or in test mode); an install with no email service; e-invoicing when it is on |
| `legalPrerequisite` | For a Malaysian venue, always, that whether it must e-invoice is for it and its accountant; the deduction tax review where deposits or kept fees exist |
| `featureSpecific` | What a feature in use needs: emergency details for unstaffed hours; weekly hours for each coach |

It is built from the plan, the profile and the rules the application already
has, not a second set of requirements. A venue that does not take online
payments is asked nothing of them; turning them on makes them appear. A venue
that does not use e-invoicing is not shown its checks, but the compliance notice
stays. A branch started from another's set-up is read for itself: what is not
copied (its payment account, staff, coaches, test booking) reads as missing. Nothing
here says a provider is verified: only a payment really taken does, and
MySenam's own provider checks are in
[feature status](../product/feature-status.md#integrations).

## Discoveries

`discover(profile, answers, dismissed)` (`src/lib/guide/discover.ts`) returns
at most three capabilities that suit the venue and that it does not use, each
with the sentence giving its reason, from `DISCOVERY_RULES`: deterministic
rules over the profile and the answers, in order of preference. Never an
unsupported capability, never one the venue already uses, never one it
dismissed (`venue_guide.dismissed`), and courts-only venues are not offered
tournaments until they have several courts, a record of bookings and no
programme yet. Nothing is learned or ranked by behaviour.

## Routes

All under `/api/admin/guide`, all with `Cache-Control: no-store`, all reading
their body with `jsonObject`:

- `GET /setup?venueId=` (or the admin's own): `{ venueId, role, profile,
  answers, rev, acknowledged, dismissed, plan, readiness, discoveries }`, read
  afresh. Manager-only (the front desk is refused with `MANAGER_ONLY`); a
  branch manager reads their own branches, a business manager their business's,
  the platform owner any, others `403`.
- `POST /setup` with `action`: `answers` (`answers` as a patch, `rev`):
  validated (`400`), refused with `409` and the *current* view if the revision
  is stale, else saved; `acknowledge` (`step`, which must be a review step);
  `dismiss` (`id`, which must be a suggestion MySenam makes). Each answers with
  the setup view and writes one staff-log entry, `guide.answers` (the keys
  changed, never their values), `guide.acknowledged` or `guide.dismissed`, in
  the three staff languages.

### The playbook route

`GET /playbook?venueId=&as=` answers `{ venueId, role, ownRole, roles, playbook }`:
the venue's [operating playbook](#the-operating-playbook) for the role. The role
a guide is *for* is the session's own (`manager` or `desk`); `as` may name
`manager`, `desk` or `coach`, and only a role at or below the caller's
(`mayViewAs`): a desk asking `as=manager` gets `403`, an unknown role `400`. It
is every role's, the front desk included, and is built afresh from the saved
configuration on each request.

## The operating playbook

The guide to running *this* venue day to day, for the person doing it: a
manager, the front desk, or a coach. It is built from the venue's saved
configuration (the [venue profile](#the-venue-profile)) and nothing else, by
`buildPlaybook(profile, role, ctx)` (`src/lib/guide/playbook/index.ts`): a pure
function with no language model, no service and no store. It is computed on each
request, so a change to a rate, a cutoff, the hours, the activities or the
payment set-up shows in the very next one, and nothing is kept that could be
stale or could be served to another venue (`tests/guide-playbook.test.ts`,
`tests/guide-playbook-venues.test.ts`). The decision is
[ADR 0028](../architecture/decisions/0028-venue-guide-as-read-models-over-real-configuration.md).

### What it is made of

A `Playbook` is `{ venue, role, summary, sections, toc, scheduled, modules }`
(`src/lib/guide/playbook/types.ts`). Its content is **typed blocks**, never
English and never a string built in code: `heading`, `paragraph`, `steps`
(ordered; a step may carry a link), `facts`, `callout` (`note`, `warning`,
`policy`, and `scheduled` for what is coming), `link` and `table`. Each block
holds `Words`: a staff-dictionary phrase (`gp.`, `src/lib/staff-i18n/guide-playbook.ts`,
or the dashboard's own title for a screen, so a step names a screen as the
screen names itself) with values that stay typed until they are said: money,
a time of day, a date, an activity, a list, or a nested phrase. `say` in
`src/lib/guide/playbook/render.ts` writes them in the reader's language with the
dashboard's own helpers (`money`, `minuteClock`, `shortDate`, `activityName`);
what the venue typed is said as typed. The screen, the print view, the search
index and the tests all read the same words through it.

Content is **modules** (`PlaybookModule`: `id`, `section`, `roles`, `applies(profile)`,
`blocks(context)`), one file per area in `src/lib/guide/playbook/modules/`. A module
that does not apply to the venue, or is not for the role, is simply absent, so a
guide is the venue's own and not a manual with every feature switched on.

| Section | Modules, and when each is there |
| ------- | -------------------------------- |
| Getting started | `start.overview` (what the venue is: resources, activities, today's hours and rates, the booking page, payment and counter methods, staff for a manager); `start.draft` (a draft venue); `start.scheduled` (anything coming, below); `start.features` (what the profile shows the venue uses); `start.where` (the screens, as links); `start.roles` (manager) and `start.deskLimits` (desk) |
| Before opening | `before.day`, `before.attention`; `before.owed` where the counter takes money; `before.classes` with classes to come; `before.unstaffed` with unstaffed hours |
| Handling a customer booking | `booking.counter`, `booking.behalf`, `booking.eligibility` (why somebody cannot reserve, and memberships, discounts and passes for the desk where the venue has them), `booking.changes`, `booking.payments`; `booking.online` for a live venue; `booking.availability` where there are buffers, shared or linked facilities; `booking.prices` once rates are set |
| During operations | `during.checkin`, `during.entry` where a resource takes entries with no set time, `during.walkins`, `during.noshows` (the venue's strike limit, or none), `during.requests`; `during.outage` once there are resources; `during.hire` where hire is against a deposit; `during.classes`; `during.coaching` |
| Cancellations and refunds | `cancel.policy` (the venue's actual cutoff, late share, strike limit, what its online-refund setting governs and the refund period), `cancel.venue` (the venue-wide policy), `cancel.staff`, `cancel.reschedule`, `cancel.obligations`; `cancel.partial` with shared, per-person, guardian or class places; `cancel.manual` (manager) and `cancel.manualDesk` (desk) where money is paid online |
| End of day | `eod.cashup`, `eod.unpaid`, `eod.exceptions`; `eod.owedCounter` where the counter takes money; `eod.owedOnline` and `eod.reports` (manager) |
| Manager responsibilities | `manager.pricesHours`, `manager.staff`, `manager.overrides`, `manager.incidents`, `manager.finance`, `manager.future`; `manager.commerce` and `manager.memberships` where the venue has promotions, passes, concessions or memberships; `manager.testBookings` for a draft or while tests stand |
| Specialised workflows | `spec.coaching` and `spec.classes` where there are coaches or classes; `spec.tournaments`, `spec.leagues` (manager) and `spec.competitionsDesk` (desk) where there are any; `spec.openGames`; `spec.family`; `spec.guardians`; `spec.unstaffed`; `spec.accounts`; `spec.branches` (manager, several branches). A court-only venue has none of them |
| Quick reference cards | Create a booking; handle a cancellation; collect payment; resolve an unpaid booking; check in a customer; respond to an outage; invite staff (manager); handle an approval request (where approvals or sign-offs are used), each step by step with the screen's link |
| Your lessons and schedule | The coach's guide (below) |

Every statement is one the feature documents make
([booking](booking.md), [pricing](pricing.md), [payments and credit](payments-and-credit.md),
[venue operations](venue-operations.md), [programmes](programmes.md),
[activities](activities.md), [tournaments](tournaments.md),
[matchmaking](matchmaking.md)). What the application does not do is not in
the guide: there is no staff rota, so nothing is said of staff assignments; the
coach's page has no attendance control, so the coach's guide has none; waiting
lists, notes on a customer, waivers, private-hire enquiries and booking alerts
are not yet written up.

### Current and scheduled

What the profile says is in force today is described as in force. A change of
opening hours or of rates set from a later date (`hours.scheduled`,
`rates.scheduled`) is never merged into today's text: it is its own
*Coming on <date>* callout, with the words *Coming later*, under *Coming
changes* in Getting started, and a `scheduled` entry in the answer. The
callout says that until the date today's hours or rates stand, and that a
booking already made keeps the price it was sold at. A coach's guide has none.

### Roles

The role a guide is *for* is the session's own (`ownRole` in `http.ts`); a
manager may ask for the front desk's or a coach's to train them (`as`, held to
`mayViewAs`), never the reverse. The three guides:

- **Manager**: configuration, policies, approvals, financial operations,
  exceptions and reporting, with a link to each screen.
- **Front desk**: daily reservations, check-in, attendance, customers'
  questions, counter payments, the refunds the desk may give (today's counter
  takings; an earlier day's is a manager's) and when to ask a manager. It
  contains no manager-only instruction and no manager-only link: modules of
  the manager section are for the manager alone, and a desk's guide never names
  a screen only a manager has.
- **Coach**: their own lessons and schedule, their hours and days off, and what
  they can and cannot see, as the coach's page already works. Nothing about money
  and nothing about the venue's other people; no links, because a coach has no
  dashboard.

Every link is `{ tab, view?, label, staffAction? }` and is added only if
`linkAllowed(role, tab, staffAction)` (`dsl.ts`) is true: a coach has none; the
desk only the tabs it has (not Reports, Courts & rates or Venue details) and only
actions `staffMay("desk")` allows, which is `MANAGER_ONLY`'s answer; a manager
what `staffMay` allows. `tests/guide-playbook.test.ts` iterates every link of
every role over every fixture venue against the real rules. A link grants
nothing: the screen and the server ask again.

### Topics, for contextual help

The explanations the application gives in more than one place are written once, as
**topics** (`src/lib/guide/playbook/topics.ts`): booking buffers
(`buffers`), shared and linked facilities (`shared-linked`), peak and off-peak
rates and prices from a date (`peak-dated`), concessions, promo codes and
stacking (`discounts`), memberships: booking privileges and taking part
(`memberships`), what a membership covers (`membership-covers`), passes
(`passes`), guardians and approvals (`guardians`), who refunds what
(`refunds`), why a customer cannot reserve (`cannot-reserve`: the reasons the
application gives, only those that apply to the venue), assigning another coach
(`another-coach`), unattended access (`unattended`) and test bookings
(`test-bookings`). `buildTopic(id, profile, role)` returns the topic's title,
blocks and related topics, or null for a role it is not written for (the coach
has none); `TOPIC_IDS` lists them. The playbook's sections use the same
function, so the text in a section is the topic's own, unchanged and once per
guide (`topicBlocks`; held by a test), and the contextual help beside a screen
can say the same words. A topic tells a manager where to change the setting
(with a link) and the desk that a manager does.

### Reading it

`PlaybookView` (`src/components/admin/guide/PlaybookView.tsx`) reads the route and
draws `PlaybookDocument`: a table of contents (with the quick-reference cards under
their section), a search box over the text already loaded (it shows the matching
topics, opens them and counts them), collapsible sections (real buttons with
`aria-expanded`), numbered steps, callouts labelled with a word as well as a
colour, links that open the dashboard's tab, and for a manager *View as*
front desk or coach, with a note saying whose guide it is. *Print this guide*
uses the browser's own print: the print stylesheet shows the guide alone on A4,
every section and topic open whatever was folded or searched, nothing split
inside a step, no controls or links, with the venue's name and *Printed on
<date> from the current settings*. Nothing is uploaded or stored. It works at
360 px, with 24 px targets, labelled fields and a keyboard.

### The coach's page

`/coach/<token>/guide` (`src/app/coach/[token]/guide/page.tsx`) is the coach's
guide, at the same private link as their schedule, checked as it is: a wrong,
lapsed or withdrawn link is the same *not found*. It is built from the coach's
venue (a coach record belongs to one) and the coach's own counts (their
lessons coming, whether their hours are set, their days off), links back to the
schedule, is print-friendly, and is linked from the schedule page. It is
written in the coach's own language where the staff dictionaries have it
(English, Malay, Chinese), else the install's first staff language: the staff
dictionaries have no Tamil.

### Languages and formats

All text is in the staff dictionaries, English, Malay and Chinese
(`guide-playbook.ts`, prefix `gp.`, one row per phrase with the three side by
side): English is written first and is authoritative; the Malay and Chinese are
machine-assisted and await native review, like the rest of the dashboard's.
`tests/guide-playbook.test.ts` checks that every phrase is in all three with the
same values, that none is unused or missing, and that a whole guide in each
language has no value left unfilled.

### Adding to it

- **A module**: add a `PlaybookModule` to the file for its section in
  `src/lib/guide/playbook/modules/` and its phrases to `guide-playbook.ts`.
  Say in `applies` which profiles it is true of and in `roles` who is shown it;
  write only what a feature document says; take links from `c.go(tab, action)`
  so a role that may not use the screen is not given one.
- **A role**: add it as under [adding a role](#adding-a-role), give modules
  `roles` that include it, and a section title if it has its own.
- **A topic**: add its id to `TOPIC_IDS`, a row in `topics.ts` and its
  `gp.t.<id>.*` phrases; use `topicBlocks` where a section explains it.
- A topic or module never states a rule twice: put the rule in a topic and
  use it.

### What it does not say

No secret, key, tax identifier or person's name, number or address is in a
playbook: it carries counts and settings from the profile and the venue's own
name (`tests/guide-playbook.test.ts` scans every guide in every language for
them). A gateway is named only by its public name. Whether something must be
invoiced or taxed is never settled in it: it says that is for the venue and its
accountant, and that a tax treatment MySenam suggests is a provisional starting
point.

## Contextual help and discovery

Help where an operator works, and a way to find what else MySenam does. Neither
is a chatbot or a free-text answerer: a "?" says what the [playbook](#the-operating-playbook)
says of a subject, a suggestion comes from a published rule, and the reason a
customer cannot reserve is the reason the application already gave.

### The "?" beside a control

`HelpTip` (`src/components/admin/guide/HelpTip.tsx`) is a button with a visible
**?**, 28 px square, named for the question it answers (*Help: How do booking
buffers work?*), placed beside the heading or control it explains, one to a
place. It holds no text. A **place** (`HELP_PLACES`, `src/lib/guide/help.ts`)
names a [topic](#topics-for-contextual-help) of the playbook and the question
(`gh.q.` phrases); opened, the tip shows that topic, built from the venue's own
saved settings (its cutoff, its rates in force, whether it has shared facilities)
and drawn with the playbook's own renderer (`BlockView` in `PlaybookDocument.tsx`;
there is no second one), so what a tip says and what the guide says are one text.

- **It opens a dialog** (`components/Dialog.tsx`): named by its question, focus
  moved into it, kept in it by Tab and Shift+Tab, closed by Escape or *Close*,
  and given back to the **?** it came from. It is a modal sheet at most 32 rem
  wide and 85% of the screen high, scrolling inside itself, so it works at 360 px.
  Nothing in it moves, and nothing is told by colour alone.
- **It loads lazily and once.** A screen with tips reads nothing for them. The
  first opening asks `GET /api/admin/guide/topic` ([the route](#the-topic-route));
  opening it again does not ask again; a failure says so with *Try again*.
- **It follows the role.** The server answers with the topic for the caller's
  *own* role, the front desk's version for the front desk (told a manager changes
  it, with no link to a screen it cannot use). A role a topic is not written for
  (`TOPIC_ROLES`: today only the coach, who has no dashboard) is given no tip, and a
  tip the server answers 404 to removes itself.
- **A link to the guide only if it may be used.** *Open this in the guide* is
  shown when the route sends it (the `guide` tab is every account's), and opens
  `?tab=guide&view=playbook&venue=&topic=`; the playbook opens the section that
  explains the topic and brings it into view, then forgets `topic` in the address.
  A topic is in a venue's guide only where the venue uses what it explains (the
  guide has no buffers section for a venue without buffers): where it is not, the
  guide simply opens. A step in a topic that names a screen opens it as the
  dashboard's own tabs do (from the counter's booking page, by going there).

**Where they are** (one `<HelpTip place="…">` each; held to the map by
`tests/guide-help.test.ts`, which fails for a place used twice or never):

| Screen | Place | Topic |
| ------ | ----- | ----- |
| Courts & rates: booking rules heading (`BookingPolicyEditor`) | `courts.buffers` | `buffers` |
| Courts & rates: courts that share a floor (`CourtLinksEditor`) | `courts.links` | `shared-linked` |
| Courts & rates: the door panel of a court | `courts.door` | `unattended` |
| Courts & rates: peak hours (`PeakHoursEditor`) | `courts.peak` | `peak-dated` |
| Courts & rates: rates from a later date (`CourtChangesFromDate`, also in the setup journey) | `courts.dated` | `peak-dated` |
| Courts & rates: concession prices (`ConcessionsEditor`) | `courts.concessions` | `discounts` |
| Credit & passes: promo codes | `credit.promos` | `discounts` |
| Credit & passes: membership plans (`MembershipPlans`) | `credit.plans` | `memberships` |
| Credit & passes: members (the customer's membership) | `credit.memberships` | `membership-covers` |
| Credit & passes: passes | `credit.passes` | `passes` |
| Venue details: participants and guardians (`ParticipantsPanel`) | `people.participants` | `guardians` |
| Courts & rates: approval settings (`ApprovalSettings`) | `people.approvals` | `guardians` |
| Venue details: cancellation terms (`CancelPolicyEditor`) | `venues.cancellation` | `refunds` |
| Day list: the cancel panel of a booking | `bookings.cancel` | `refunds` |
| Day list: the coach of a lesson being moved (`LessonCoach`) | `bookings.coach` | `another-coach` |
| Venue details: the hours nobody is at the counter | `venues.unattended` | `unattended` |
| The counter's booking form: beside the price check's reason | `counter.quote` | `cannot-reserve` |
| The counter's booking form: beside a refusal | `counter.refusal` | `cannot-reserve` |
| Go-live banner of a draft venue | `golive.draft` | `test-bookings` |
| The test bookings of a live venue | `golive.tests` | `test-bookings` |

The front desk has a tip only where it uses the screen: a tip inside a region only
a manager changes is inside that region's read-only fieldset, as the region is
(`ManagerOnly`), so the desk meets the tips of the cancel panel, the coach of a
lesson, the counter, passes and the members list, with its own version of each.
The counter's tips appear only for the venue's own staff at the counter; a
customer's booking page has none. Places with **no topic** are given no tip and no
invented text: staff roles (`StaffAccounts`: the playbook says who can do what in
its guides but has no topic for it), and anything else in the dashboard the
playbook does not yet write up.

**The rule-specific answer** is the reason the application gives, shown with the tip
that explains the rule: the counter shows the refusal it already shows (a time
taken, a closed venue, a limit) and the tip *Why can't this customer reserve this?*
opens the `cannot-reserve` topic, whose table is the reasons the application gives
and only those that apply to the venue. There is no free-text question.

### The topic route

`GET /api/admin/guide/topic?venueId=&id=` answers `{ venueId, role, topic, guide }`:
`topic` is the playbook's topic (typed content: phrases and values, not English)
for the session's own role, `guide` the link *Open this in the guide* or `null`.
Every staff role may read it; the role is the session's (there is no parameter
that changes it), the tenant is checked as for every guide route (`403` for a
venue the caller may not manage, `400` for none named, the platform owner any),
and `404` for a topic that does not exist or is not written for the role. It is
`no-store` and kept nowhere ([routes](../architecture/http-api.md)).

### Discovery

The discover view (`DiscoverView.tsx`; a manager's, `?tab=guide&view=discover`)
has two parts, and says *suggestions* throughout: they come from the rules in
[Discoveries](#discoveries) over the saved settings and answers, and nothing is
learned, ranked or switched on.

- **Suggestions**: the profile's `discover()` result, at most three, each with the
  reason sentence, what the capability needs in the guide's five words
  (`availabilityOf`: available now; available with configuration; requires an
  external integration; requires the operator's approval; not currently
  supported) and the outside service it names (*Needs Billplz.*; never called
  verified), then **Set this up**, **Not for us** and **How it works**.
  *Set this up* starts a targeted journey (`?tab=guide&view=setup&focus=<capability>`,
  [the setup journey](#existing-venues-and-targeted-journeys)) without rerunning
  setup; where the setup plan has no step for the capability (company accounts,
  booking alerts) it opens the screen that has it instead. *Not for us* is the
  existing `dismiss` action (logged as `guide.dismissed`) and the suggestion does
  not come back. *How it works* shows the capability's own sentence from the
  registry and, where the playbook has a topic for it (`CAPABILITY_TOPIC`), the
  venue's version of it, read when first opened.
- **Everything MySenam can do**: the registry (`catalogue()` in `help-catalogue.ts`;
  `capabilitiesIn` for each group, so a capability added to the registry is here),
  grouped, each item marked **In use**, **Available** or **Not currently
  supported**, in words as well as a badge. *In use* is shown only where the saved
  configuration says so (`capabilityInUse`: a count or a setting the venue saved);
  where the profile cannot tell, the item is *Available*. An unsupported item shows
  what to do instead (`gcap.<id>.alt`) and, for a way of selling the catalogue
  names, its limitation; it is never offered for setup and has no setup control.
  An item that is among the suggestions above is marked *Suggested above* and has no
  second set of buttons, so nothing is offered twice.

A venue is never offered what it uses (the rule's `unused`), nothing unsupported is
a suggestion (`DISCOVERY_RULES` name available capabilities only), and the front
desk has no discover view (the tab hides it and the server refuses it the data).

### Language, accessibility, tests

Text is in the staff dictionaries, `guide-help.ts` (`gh.`), English first and
authoritative; the Malay and Chinese are machine-assisted and **await review by native
speakers**. A tip's explanation is the playbook's own text (`gp.t.`); the
capability names, sentences and alternatives are the customer dictionaries'
(`gcap.`, read through `t.customer`). Every control has a name
(`tests/form-labels.test.ts`), targets are 24 px or more, and nothing depends on
motion.

`tests/guide-help.test.ts` (the places, the dictionaries, the route: each role's
own topics, the desk's version, role from the session, `404`, tenant `403`, no
other venue's values; also on Postgres), `tests/guide-help-discover.test.ts` (the
catalogue equals the registry, nothing unsupported offered, in use, dismissal
persisting and logged, the targeted journey, roles and tenants; also on
Postgres), `tests/components/guide-help.test.tsx` (the tip: opening, Escape, focus,
lazy and once, role, link; the guide opening at a topic; the discover view),
`tests/components/guide-help-screens.test.tsx` (the tips on the real tabs against
the real routes, the desk's), `tests/components/guide-help-places.test.tsx` (the
cancel panel, the coach, the banner, the counter and not a customer's page).

## Permissions

The setup routes are in `MANAGER_ONLY` and `STAFF_ACTIONS` has `guideSetup`
(`tests/roles.test.ts` holds both to the real routes); the playbook route is
not, so every role reads it, each its own. `STAFF_ACTIONS` also gained
`einvoicing`, `reports`, `exports`, `marketing`, `apiKeys`,
`paymentSettings` and `staffLog`, so a link to a manager's screen can be held
to what its reader may open. A role is `manager`, `desk` or `coach` (`coach` is
previewed by staff; coaches work from their own link and have no dashboard
account). Tenant scope is in [tenancy](../architecture/tenancy.md#the-venue-guides-scope).

## The dashboard tab

`TABS` in `src/app/admin/page.tsx` has `guide`, addressed
`?tab=guide&view=setup|playbook|discover` (the view and the venue are in the
address, like the tab, so a reload or a link lands where it was). Every
account has the tab; the front desk is shown only *How to run it*, and the
server refuses it the setup regardless. `src/components/admin/guide/GuideTab.tsx`
renders the switcher and, for each view, `SetupPlanView` (the setup journey, in
`SetupPlanView.tsx`), `PlaybookView` (the playbook, in its own file) or, for the
discover view, `DiscoverView` ([below](#contextual-help-and-discovery)), each fed by
one route. The
dashboard's tab list and `DASHBOARD_TABS` (`src/lib/guide/shell.ts`) are held
equal by `tests/guide-model.test.ts`. All text is in the staff dictionaries:
`guide.ts` (`gd.`: the shell, refusals' words, readiness, discoveries, log
entries and the framework's own steps), and one file for each of the three
later workers (`guide-setup.ts` `gs.`, `guide-playbook.ts` `gp.`,
`guide-help.ts` `gh.`) so none is edited by two. Phones, keyboard and screen
readers: state is a word beside the colour, controls are buttons with names, and
the lists are plain lists.

## The public guide

*How MySenam fits your business* is the first of the three guides, and the
only one a visitor meets before registering. It is the marketplace's own
(`isMarketplace()`; any other install answers `404`, as `/list-your-venue`
does), is in the visitor's language, and **writes nothing**: no cookie, no
record, no analytics. A test counts the rows of every table before and after
rendering every page, its metadata and the sitemap
(`tests/guide-public-pages.test.tsx`).

### Routes

| Route | What it is |
| ----- | ---------- |
| `/for-venues` | The picker: the thirteen kinds of business, several at once, and a refinement by activity (the catalogue's keys). A plain `GET` form, so it works with no script; the choice is in the address, `?types=a,b&activities=x` (a form's repeated boxes and a comma list mean the same; what does not exist is ignored). With a choice it shows the tailored explanation; bare it is the indexed page, and a choice is `noindex` with the bare page as its canonical address |
| `/for-venues/[type]` | One server-rendered, indexable page for each business type (`BUSINESS_TYPE_IDS`): its own title, description and canonical address, in the visitor's language. `?activities=` refines it; a type that does not exist is `404` |
| `/sitemap.xml` | Lists `/for-venues` and each type page, in marketplace mode and not on a storefront |

The site navigation has the link (*For venues*, beside *List your venue*), and
the application form reads the choice back (below). No API route is added.

### What a page shows

For the selection (`fitView(selection)`, `src/lib/guide/public/view.ts`):

1. **Your day in MySenam**: the types' journeys (`WORKFLOW_IDS`), as tabs (one
   journey at a time) of stepped walkthroughs: for each step who does it, what
   they see, what MySenam checks, the capabilities it relies on, and a small
   *illustrative* screen with made-up sample data, labelled as such. The
   journeys: a customer booking a court, staff booking at the counter, paying
   online, membership benefits, passes, class enrolment, a lesson with a coach,
   a parent registering a child, tournaments, leagues, open games, equipment
   hire with a deposit, unstaffed entry (only where an activity may be left
   unstaffed), timed sessions, sign-offs, a company account, cancelling and the
   venue cancelling, and several branches: each only where the type uses it.
2. **How these fit together**, when several types, the mixed venue or
   activities of several resource models are chosen (`composeTypes`): each
   activity keeps its own rates and rules; booking rules by venue, activity or
   court; models side by side; one sign-in; branches. Each statement rests on
   capabilities the selection lists (`COMBINED_CLAIMS`).
3. **What you would set up**: the available capabilities, grouped in the order a
   venue is set up, with their blurbs.
4. **What is available**: a chip for each capability, in five groups by
   `availabilityOf` (available now; with configuration; requires an external
   integration, naming which; requires the operator's approval; not currently
   supported). A state is a word and a mark, never a colour alone.
5. **Good to know**: each chosen activity whose catalogue support is not `full`,
   with the catalogue's own `supportNote` (in English, marked `lang="en"`).
6. **What MySenam does not do**: every unsupported capability with what to do
   instead, those that concern the selection first (a type's own, an activity's
   `activityNote`, and `LIMITS_WITH`: Billplz refunds by hand, the platform's
   WhatsApp number, one door code per lock), then the rest.
7. **The way on**: `/list-your-venue?fit=…` and a link to `/pricing`. The page
   says nothing of price plans beyond that link.

The bare picker page and every choice on it then end with *Use MySenam from
your AI assistant* (`src/components/fit/AiAssistants.tsx`): the address of the
[MCP server](../integrations/mcp.md), whose public tools need no key and answer
from this same model (`guide_business_types`, `guide_fit`), and a line on a
venue's own key kept in an environment variable.

There are no testimonials, savings or statistics; the only figures are the
made-up sample data in the illustrative screens.

### Where the content lives

All of it is data derived from the shared model; none is copied from it.

- `public/steps.ts`: every step (`STEP_LIST`): its `actor`, the capabilities it
  `needs` (all) or `any` (one of several ways), its `notes` (each shown only
  where the selection lists the capabilities it needs), unsupported `limits` it
  names, `optional`, and its screen's lines (`fit.tk.<token>` phrases; `#…` is
  a literal, `$40` an amount in the install's currency).
- `public/workflows.ts`: `WORKFLOWS`, each journey's steps in order;
  `shownSteps` (what a selection's capabilities allow), `claimsOf` (what a
  shown step claims).
- `public/view.ts`: `fitView`, `MODEL_CAPABILITIES` / `MODEL_WORKFLOWS` (what an
  activity added by the visitor brings), `LIMITS_WITH`, `COMBINED_CLAIMS`,
  `workflowApplies` (unstaffed entry is not shown for swimming, water polo or
  anything on the water: the catalogue's `supervised`).
- `public/select.ts`: the address (`parseSelection`, `guideAddress`,
  `encodeFit`, `decodeFit`, `applyAddress`); `public/present.ts`: the words in a
  language.
- Words: the customer dictionaries, `fit.` phrases (`fit.s.<step>.t|s|c|x.<note>`,
  `fit.w.<workflow>.t|d`, `fit.tk.<token>`, the page's own); the `gcap.` and
  `gbt.` phrases of the registry and the types are reused.

**To add a step** or a journey: add the step to `STEP_LIST`, its id to the
workflow in `WORKFLOWS`, and its phrases in four languages. **To add a business
type** or a workflow id: see
[adding a business type](#adding-a-business-type-or-a-workflow).
`tests/guide-public.test.ts` names what is missing.

### The rules the content keeps

- A step relies only on capabilities that exist and are `available`; a limit is
  an `unsupported` one. A test fails otherwise, when a business type lists too
  little for a journey's required steps, and when a shown step or note claims a
  capability the selection does not list.
- Every available capability a page shows rests on a feature-status row that is
  `IMPLEMENTED_AND_TESTED`, or `INTEGRATION_VERIFICATION_REQUIRED` and labelled
  as needing an integration.
- Every business type's chips equal `availabilityOf`; the gym, climbing,
  bowling, swimming, equipment-rental, Billplz and WhatsApp cases are tested as
  the owner listed them.
- What every venue has (`resources`, `booking-rules`, `day-list`,
  `receipts-tax`) is added to every business type's list (`EVERY_VENUE` in
  `business-types.ts`), so a journey can rely on it; the gym also lists
  `shared-facilities`. `day-list` (the staff's list of the day's bookings) is
  a capability added for the public guide.

### Handing the choice to the application

The call to action goes to `/list-your-venue?fit=types:a,b~activities:x,y`
(short and readable; never anything personal). `ApplyForm` reads it
(`decodeFit`, lenient: a value that does not exist is dropped, and JSON of the
`GuideAnswers` shape is accepted too), says *You told us you run: …* with
*Change* (back to the guide with the same choice) and *Leave this out*, and
sends it as `fit` in the existing request. The server side is
[what a visitor chose](#what-a-visitor-chose): checked by `normaliseFit`, kept
with the application, seeded once into the venue's intent. The visitor is never
asked it twice (`tests/guide-public-handoff.test.tsx` runs the form's request
through the real route to `venue_guide`).

### Phones, keyboards and languages

The walkthrough is a plain ordered list until the page has loaded (every step
open, no controls: what a search engine, a reader without script and a phone
see); then it becomes a stepper (headings that are buttons with
`aria-expanded`, *Previous step* and *Next step*, focus following the step
opened, a status line) and the journeys become tabs (arrow keys, Home and End,
one tab in the tab order). One `h1`, sections as `h2` with jump links,
journeys `h3`, steps `h4`; every box is inside its label; targets are at least
36 pixels; no horizontal scroll at 360 pixels (checked in a browser);
illustrative buttons are pictures, not controls. Nothing depends on animation
or dragging.

English is written first and is authoritative. **Malay, Chinese (Simplified)
and Tamil are machine-assisted and await native review**, as the rest of the
app's do: the `fit.` phrases (about 560, in `src/lib/i18n.ts`, `i18n-zh.ts`,
`i18n-ta.ts`) and `gcap.day-list.*`; in particular the wording of what MySenam
checks (money, approvals, guardians). The catalogue's own `supportNote` for
partly supported activities is English only.

## Interfaces

What the setup journey, the public guide, the playbook and the contextual help
build on. Import from the files named; do not reach into another worker's.

| To | Use |
| -- | --- |
| Know what MySenam can do | `CAPABILITIES`, `capability(id)`, `requireCapability(id)`, `availableCapabilities()`, `unsupportedCapabilities()`, `capabilitiesIn(group)`, `availabilityOf(c)` |
| Describe a kind of business | `BUSINESS_TYPES`, `businessType(id)`, `composeTypes(ids)`, `activityFacts(key)`, `WORKFLOW_IDS`, `isBusinessTypeId` |
| Read a venue | `readVenueProfile(venueId, { today? })` (server) → `VenueProfile`; helpers in `profile-types.ts` (browser-safe); `emptyProfile()` |
| Read or write intent | `readGuide`, `saveAnswers`, `acknowledge`, `dismiss` (`answers.ts`, server); `validatePatch`, `applyPatch`, `normaliseFit`, `GuideAnswers` (`answer-schema.ts`, browser-safe) |
| Plan the setup | `buildSetupPlan(ctx, registry?)` → `SetupPlan`; `SetupStep`, `StepContext`, `StepState`, `PlanItem`, `Say` (`plan.ts`); `SETUP_STEPS`, `reviewState`, `becauseAnswer`, `becauseFact` (`steps.ts`) |
| Say if ready | `launchReadiness(profile, plan?)` → `LaunchReadiness` |
| Suggest | `discover(profile, answers, dismissed)`, `DISCOVERY_RULES` |
| Serve a view | `setupView(venueId, role, state?)`, `guideVenue`, `ownRole` (`http.ts`); `playbookFor(venueId, role)` (`playbook/server.ts`), `buildPlaybook` (`playbook/index.ts`) |
| Serve the setup journey | `journeyView(venueId, role, focus)`, `isFocus`, `nextSaturday` (`setup-journey.ts`); `questionFlow`, `unanswered`, `QUESTIONS` (`setup-questions.ts`); `focusIds`, `SETUP_ACTIONS` (`plan.ts`) |
| Roles and screens | `GuideRole`, `mayViewAs`, `DashboardTab`, `DASHBOARD_TABS`, `GuideView` (`shell.ts`) |
| Put a "?" on a screen | `<HelpTip place="…" venueId={…} />` (`HelpTip.tsx`); `HELP_PLACES`, `TOPIC_ROLES`, `topicWrittenFor`, `guideAddress` (`help.ts`) |
| List what MySenam can do | `catalogue(profile, suggested)`, `capabilityInUse`, `setupFocus`, `CAPABILITY_TOPIC` (`help-catalogue.ts`) |

A `Say` is `{ key, vars? }`: a staff-dictionary phrase and its values, which the
screen says in the reader's language (`t(say.key, say.vars)`); the plan and the
readiness carry these, never English. A go-live reason from the application
arrives as a `StaffText` in `say` and is said with `t.say`.

### Adding a capability

Add a row to `AVAILABLE` or `UNSUPPORTED` in `capabilities.ts` (use the
`available(...)` and `unsupported(...)` helpers), with the exact `featureRow`;
add `gcap.<id>.title` and `.blurb` (and `.alt` for an unsupported one) to the
four customer dictionaries (`src/lib/i18n.ts` EN and MS, `i18n-zh.ts`,
`i18n-ta.ts`); run `tests/guide-capabilities.test.ts`, which names what is
missing. If there is no row in feature status, it is not available.

### Adding a step

Add a `SetupStep` to `SETUP_STEPS`: a permanent `id`, a `group`, the
`capabilities` it concerns, `kind` and `effect` (never one that overwrites what
an existing venue has), `applies` (returning the reason or `null`), `state`
(from the profile only; `reviewState` for a review), `required`, and `configure`
with the `staffAction` that governs it. Its text goes in the staff dictionaries
(`guide-setup.ts`). A step that writes setup must call the existing
configuration code or route (its validation, permission, logging and
effective-dating), never its own table.

### Adding a business type or a workflow

A business type is a `type(...)` row in `BUSINESS_TYPES` and its id in
`BUSINESS_TYPE_IDS`, with `gbt.<id>` in the four customer dictionaries; a
workflow is an id in `WORKFLOW_IDS` and in the types that have it. The test
checks that each type's activities, capabilities and workflows exist.

### Adding a role

Add it to `GUIDE_ROLES` and `GUIDE_ROLE_RANK` (`shell.ts`), `ROLE_PHRASES` in
`PlaybookDocument.tsx` and `gd.role.<role>` in the staff dictionaries; what a role
may see is whatever its modules say for it, held to `staffMay`.

## What is stored, and what is not

Stored: `venue_guide` (one row per venue, deleted with it) and
`venue_applications.fit` (business types and activity keys only). Not stored:
any copy of the venue's configuration, the profile, the plan, the readiness or a
playbook; none is cached across requests or venues. No personal data is held
beyond the name of the manager who acknowledged a step, kept as it was like the
staff log's. Exploring the public guide stores nothing.

## Tests

`tests/guide-capabilities.test.ts` (the registry against feature status and the
register, the dictionaries, staff actions); `tests/guide-model.test.ts`
(business types, answers, the plan's conditional rules and existing-venue rules,
readiness groups, discoveries, the tab list); `tests/guide-profile.test.ts`
(the profile against fixture venues and secrets, tenant isolation, answers,
stale saves and concurrent saves, `fit` through `submitApplication`, a copied
branch, the routes and their log entries and refusals);
`tests/components/guide-tab.test.tsx` (the tab: roles, links, reviews);
`tests/guide-setup.test.ts` (the journey's conditional steps for a small
badminton centre, a coaching academy and a multi-sport business with branches,
targeted journeys, the route and its tenant and role refusals, the price
example against `quoteFor`, *Try it* from saved bookings, each action's route
changing real behaviour and refusing where the application refuses, save and
resume across two sessions, a stale save, an established venue left unchanged,
the checklist and the plan agreeing, readiness for counter-only and online
venues, the words in all three languages); `tests/guide-setup-ui.test.tsx` (the
questions and the plan on screen, phone structure and focus, and, over the real
routes and database, the actions run from the cards). The
playbook: `tests/guide-playbook.test.ts` (fixture venues and which modules each
gets, every number and policy equal to the profile's, current against scheduled,
every link of every role against `MANAGER_ONLY`, the desk's and the coach's
guides, topics written once, determinism, no store, the three languages, no
secret), `tests/guide-playbook-venues.test.ts` (the route and its roles, tenant
isolation, a change showing on the next request, a branch's own guide, the
coach's page and link), `tests/components/guide-playbook.test.tsx` (contents,
search, folding, links, the role preview, the print view). `tests/guide-public.test.ts` (the public guide's content against the registry,
feature status and the dictionaries), `tests/guide-public-pages.test.tsx` (the
pages, metadata, the sitemap, no writes), `tests/components/fit-guide.test.tsx`
(stepper, tabs, labels, targets) and `tests/guide-public-handoff.test.tsx` (the
choice through the form to `venue_guide`). The
concurrent-save and tenancy tests, and the playbook's tenancy and change tests,
are run on Postgres as well as PGlite. A test
against a payment or message provider is a stand-in; the guide never says one
is verified.
