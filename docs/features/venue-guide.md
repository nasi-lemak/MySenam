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
| Routes and shell | `http.ts`, `facts.ts`, `shell.ts`; `GuideTab.tsx` | Three routes, the dashboard's `guide` tab, roles |

The tab's setup view is [the setup journey](#the-setup-journey). Its playbook
and discover views are placeholders: each reads its route and shows what comes
back as plain lists, marked as such on the screen, for the playbook and the
contextual help to replace one function at a time ([the dashboard
tab](#the-dashboard-tab)). The
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
`src/lib/activity-catalogue.ts` (`activityFacts`), never copied. Sessionless
gym admission, open-ended climbing day passes, selling bowling by the game,
scheduling a range officer, a WhatsApp number of the venue's own, web push, a
store app, demand pricing, referral credit, Billplz refunds, booking from
Google, smart locks and per-person door credentials are registered as
unsupported, each with what to do instead.

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
it is shown as "reviewed on…", and nothing infers it from a click on *Next*.

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

`GET /playbook?venueId=&as=` answers `{ venueId, role, ownRole, roles, facts }`.
The role a guide is *for* is the session's own (`manager` or `desk`); `as` may
name `manager`, `desk` or `coach`, and only a role at or below the caller's
(`mayViewAs`): a desk asking `as=manager` gets `403`, an unknown role `400`. It
is every role's, the front desk included. Until the playbook is built on it,
`facts` are phrases chosen from the profile for the role (`guideFacts`): the
front desk is not shown the money settings or the staff, a coach only the
activities.

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
`SetupPlanView.tsx`) or a placeholder that replaces cleanly (`PlaybookView`,
`DiscoverView`), each fed by one route. The
dashboard's tab list and `DASHBOARD_TABS` (`src/lib/guide/shell.ts`) are held
equal by `tests/guide-model.test.ts`. All text is in the staff dictionaries:
`guide.ts` (`gd.`: the shell, refusals' words, readiness, discoveries, log
entries and the framework's own steps), and one file for each of the three
later workers (`guide-setup.ts` `gs.`, `guide-playbook.ts` `gp.`,
`guide-help.ts` `gh.`) so none is edited by two. Phones, keyboard and screen
readers: state is a word beside the colour, controls are buttons with names, and
the lists are plain lists.

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
| Serve a view | `setupView(venueId, role, state?)`, `guideVenue`, `ownRole` (`http.ts`); `guideFacts` (`facts.ts`) |
| Serve the setup journey | `journeyView(venueId, role, focus)`, `isFocus`, `nextSaturday` (`setup-journey.ts`); `questionFlow`, `unanswered`, `QUESTIONS` (`setup-questions.ts`); `focusIds`, `SETUP_ACTIONS` (`plan.ts`) |
| Roles and screens | `GuideRole`, `mayViewAs`, `DashboardTab`, `DASHBOARD_TABS`, `GuideView` (`shell.ts`) |

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
`GuideTab.tsx` and `gd.role.<role>` in the staff dictionaries; what a role may
see is whatever its modules say for it, held to `staffMay`.

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
concurrent-save and tenancy tests are run on Postgres as well as PGlite. A test
against a payment or message provider is a stand-in; the guide never says one
is verified.
