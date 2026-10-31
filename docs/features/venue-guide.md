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
| Public guide | `public/` (`workflows.ts`, `steps.ts`, `view.ts`, `select.ts`, `present.ts`); `src/components/fit/`; `src/app/for-venues/` | *How MySenam fits your business*: [the public guide](#the-public-guide) |

The tab's three views (setup, playbook, discover) are placeholders: each reads
its route and shows what comes back as plain lists, marked as such on the
screen, for the setup journey, the playbook and the contextual help to replace
one function at a time ([the dashboard tab](#the-dashboard-tab)). The
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
`audience` (public, members, both). A fact the profile already shows is never
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

`SETUP_STEPS` (`src/lib/guide/steps.ts`) are the framework's own proof; the
setup journey shapes and extends them. Today: `details`, `courts` and
`test-booking` (the three of the checklist, required to go live), `online-payment`
(optional), `cancellation-terms`, `guardians` and `copied-branch` (reviews),
and the conditional `branches`, `equipment`, `unattended`, `coaches`,
`coach-hours` (blocked until there is a coach), `classes` and `memberships`.
Required for going live are the checklist's three; `cancellation-terms` becomes
required once money is taken online.

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
renders the switcher and a placeholder for each view that replaces cleanly:
`SetupPlanView`, `PlaybookView`, `DiscoverView`, each fed by one route. The
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
| Serve a view | `setupView(venueId, role, state?)`, `guideVenue`, `ownRole` (`http.ts`); `guideFacts` (`facts.ts`) |
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
`tests/guide-public.test.ts` (the public guide's content against the registry,
feature status and the dictionaries), `tests/guide-public-pages.test.tsx` (the
pages, metadata, the sitemap, no writes), `tests/components/fit-guide.test.tsx`
(stepper, tabs, labels, targets) and `tests/guide-public-handoff.test.tsx` (the
choice through the form to `venue_guide`). The
concurrent-save and tenancy tests are run on Postgres as well as PGlite. A test
against a payment or message provider is a stand-in; the guide never says one
is verified.
