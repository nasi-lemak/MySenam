# ADR 0028: The business-fit guide, the setup journey and the operating playbook are read models over the real configuration

- **Status:** current, decided 2026-10-31 (the owner's onboarding and
  operating-guide initiative). How operators meet it is
  [the venue guide](../../features/venue-guide.md).
- **Context:** MySenam is meant to be set up and run by a venue's own people
  with little help from its operator. The setup checklist
  (`src/lib/setup.ts`) says where to start, and everything else is eight tabs
  of configuration. Three things were wanted: a public explanation of how
  MySenam fits a given kind of venue, a setup journey that adapts to the
  business, and a guide to running the venue day to day that is true of *that*
  venue's configuration and of each person's role. The risk in all three is
  the same: a second description of the business (a questionnaire, a
  wizard's own settings, a hand-written manual) that drifts from what the
  application actually does.
- **Decision:**
  - **One venue profile, read from the real configuration.**
    `readVenueProfile(venueId)` (`src/lib/guide/profile.ts`) reads what the venue has (its activities and
    resources, hours, rates in force and rates scheduled, policies, payment
    set-up, staff, programmes, memberships and passes, branches, test
    bookings) from the existing tables, through the existing lookups
    (`ratesOn`, `venueHours`, the policy resolvers). Nothing is copied. The
    setup journey and the playbook are functions of this profile; the public
    guide uses *illustrative* profiles of the same shape.
  - **What is new data is the operator's intent only:** the answers to the
    discovery questions, the steps they acknowledged ("I have reviewed my
    cancellation terms": a judgement no state can show) and the suggestions
    they dismissed, in one table (`venue_guide`, migration 0261), with a
    revision number so two people saving at once do not overwrite each other.
    Where the profile shows a fact, the journey never asks for it.
  - **Setup actions are the existing actions.** A step either embeds the
    existing editor's own request (the same route, validation, permission,
    log entry and effective-dating) or opens the existing screen. A step is
    done when the saved state says so, never because *Next* was pressed; an
    acknowledgement is a recorded, manager-only, logged act and is shown as one.
  - **A typed capability registry** (`src/lib/guide/capabilities.ts`) is the
    one list of what the guide may say MySenam can do: each capability names
    its row in [feature status](../../product/feature-status.md), whether it
    needs configuration, an external integration or an approval, the screen
    that configures it and the staff action that governs it. A test fails when
    a capability names a row that does not exist, or says "available" of one
    that feature status does not call implemented. Activity facts (support
    level and its note, resource model, supervision, sign-off) come from the
    activity catalogue, not from the guide.
  - **The playbook is deterministic.** `buildPlaybook(profile, role)` composes
    typed content modules, each saying when it applies to a profile and for
    which roles, from dictionary phrases and the profile's facts. No language
    model, no service, no stored copy: it is computed per request from the
    current configuration, so there is nothing to invalidate and nothing that
    can serve one venue's content to another. (Cost is a handful of reads.)
  - **The role is the caller's own,** derived from the session. A manager may
    ask to see the front-desk or coach version to train staff, never the
    reverse. A link in a guide is shown only if `staffMay` allows that role
    what it opens, so a guide grants no authority.
  - **Public pages write nothing.** The public guide is static content plus
    client-side selection; the choice travels in the address to the
    application form and is stored with the application (then with the venue's
    intent) only once somebody applies.
- **Consequences:** the guide cannot say something the application cannot do,
  and a change to a capability's status in feature status is caught by a test
  rather than by a confused operator. Adding a role or a capability is adding a
  module or a registry row. Accepted costs: the text is written (and translated)
  by people rather than generated, and the machine-assisted Malay, Chinese and
  Tamil await native review like the rest of the app's.
