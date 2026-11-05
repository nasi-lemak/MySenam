# ADR 0046: The strength of a requirement: advisory windows a manager may override, and qualification levels

- **Status:** current, decided 2026-11-05 on the owner's refinements of two of the round-10 features. Built in migration
  0288. **Supersedes** two statements: [ADR 0037](0037-launch-and-tide-windows.md) F1 ("the window is not a
  rule a manager can waive") and [ADR 0036](0036-who-supervises-a-session.md)'s "until a person's certificate is recorded, their
  shifts in that role count for nothing" (for a recommended qualification). Everything else in those records stands. What staff and
  customers see is [advisory and hard windows](../../features/booking.md#advisory-and-hard-windows) and
  [qualification levels](../../features/venue-operations.md#qualification-levels).
- **Context:** two decisions share one idea, how firmly something is required. A launch or tide window is the venue's own judgement
  about the water, yet round 10 let nobody go past it, so a manager who knew the tide table was wrong for the afternoon had to
  change the rule for everybody. A role's qualification was all-or-nothing: a person without it counted for nothing, so an instructor
  whose certificate had not yet been typed in made a class unbookable. Both are the venue telling the app how hard a line is, and the
  app should say so in one vocabulary, never weaken a line that is a matter of safety or law, and never settle a legal question in code.

## Decision

### A. One vocabulary

- **A1.** Every restriction on a booking has a **strength**: `advisory` (the venue's own judgement), `venue_required` (the venue says
  it must hold) or `hard` (a safety closure, a legal restriction, a change of the clocks, a window the venue marked hard, a
  qualification declared a legal requirement). `src/lib/restriction-strength.ts` holds the words and the table below; a test holds the
  code to the table.
- **A2.** A **qualification level** is `recommended` (advisory), `venue_required` or `legally_required` (hard). A launch rule is
  `advisory` or `hard`.

| Restriction | Strength | A manager's override, with a reason, from the counter |
| --- | --- | --- |
| A launch or tide window (`LAUNCH_WINDOW`, `LAUNCH_RETURN`, `LAUNCH_CLOSED`, `TIDE_NO_DATA`, `LAUNCH_WEEK`), the rule left at its default | advisory | Yes (A3) |
| The same, the venue marked the rule **hard** | hard | Never |
| A change of the clocks (`CLOCK_CHANGE`) | hard | Never |
| A closure, outage, block or rain-out, marked a safety closure or not | hard where marked, otherwise venue-required | Never: the database holds that time (`src/lib/claims.ts`) |
| The venue closed that day, or outside its opening hours | venue-required | Never by this path (a court's own override of its booking rules is as it was, ADR 0026) |
| Required supervision (`SV1_NO_SUPERVISOR`), a qualification the venue requires | venue-required | Never at booking; a manager may let one *existing* session stand without cover, with a reason (ADR 0036) |
| Required supervision of a qualification declared legally required | hard | Never, by any path |
| A recommended qualification not recorded | advisory | Not a restriction: it does not stop anybody counting; it is flagged |

### B. Overriding an advisory window

- **B1.** A manager of the venue may book, move or reschedule a booking, move the weeks of a series, or schedule a class term
  outside an **advisory** window, by sending `overrideWindow: true` and a `windowReason` (the same fields on the booking form's route,
  the reschedule route, the series move and the classes route). The server checks again: the person is a manager of that venue
  (front desk, a customer, a venue's API key, another venue's manager and **the platform owner** are refused: an owner's emergency
  override is not built, and would be its own decision), the venue has not turned the override off, and the reason is at least as long as
  the venue's minimum.
- **B2.** A **hard** rule is never gone past. The answer says so (`SAFE1_WINDOW_HARD`), and the counter's refusal for it says there is no
  override. Nothing else is gone past either: the clocks changing, a closure or block, required supervision, the court's booking rules,
  eligibility, sign-offs and capacity are asked exactly as before. A court's own override of its booking rules still goes past no window.
- **B3.** What is let through is **written in the booking's own transaction, only for what was actually refused**
  (`booking_window_overrides`: the booking or class session, the refusal gone past, the rule, the day's window as it stood, the reason,
  who, when), and in the activity log (`booking.window_overridden`), both or neither: a preview, a booking that fails and the loser of a
  race leave nothing. A week of a series or a session of a term outside its window is recorded each. The customer's result is a normal
  booking.
- **B4.** It is shown on the booking (*Went past the window … by …: why*), on a manager's **report** under *Launch and tide windows*
  (`GET /api/admin/window-overrides`), and a venue whose managers overrode more than its limit in 7 days has a needs-attention line.
- **B5.** The numbers are **configuration with defaults**, never a rule in code: the install's (`window_override_defaults`, one row,
  shortest reason 15 characters, an alert after 5 in 7 days) and the venue's own (`venue_window_override_settings`: whether its managers
  may override at all, default yes, and its own two figures, which replace the install's; 0 alerts is none). Changing them is a
  manager's and is logged. No onboarding step: a venue that has no window sees none of it.
- **B6.** The rule's strength is `launch_rules.strength` (`advisory` for every existing rule). A venue marks a closure, an outage, a
  block or a rain-out a **safety closure** (`safety` on `venue_closures`, `court_outages`, `blocks`; existing ones are not): the flag is
  kept, named in the log and the list, and no override reaches it.

### C. Qualification levels

- **C1.** Each role's qualification has a level (`roster_roles.qualification_level`). The three starters are **editable templates**:
  instructor `recommended`; range officer and lifeguard `venue_required` (a safety role keeps what it did). A role the venue makes
  itself, with a qualification, is `venue_required` unless the venue says otherwise (the safe default). A venue may lower, raise or
  rename any of them, or clear the qualification. Existing roles keep what they did (`venue_required`), except an instructor starter whose
  suggested qualification the venue has not changed, which the migration makes `recommended`, as the owner decided for that template.
- **C2.** **Counting.** A person with no recorded qualification **counts as supervising** where it is `recommended`: they can be rostered,
  named on a session and cover; the roster flags *recommended qualification not recorded* (and *ended*, for one that expires before a
  shift does), advisory and never blocking, on the roster, in the list of sessions covered that way, and beside the supervisor on the
  booking, the day's list and the schedule. A `venue_required` qualification counts only recorded and unexpired, as round 10's rule did.
  `legally_required` counts as `venue_required` does.
- **C3.** **A manager may let a session stand** without cover, with a reason, where the role is `venue_required` (ADR 0036), and
  **never** where it is `legally_required`: it is refused, and a "let it stand" decision made before the role became a legal
  requirement stops covering. The session can be covered by somebody who holds the qualification, moved or cancelled. Naming somebody to
  cover needs the qualification where it is required, not where it is recommended.
- **C4.** `legally_required` records the **venue's declaration** and the reference or wording it gives (kept as given, required, never
  judged): the app does not say whether the law requires it. The wording of every notice is provisional and awaits legal review.
- **C5.** A change to a role's qualification or level shows its **effect before it is made** (`role_preview`: how many rostered shifts are
  held by somebody without it recorded, which sessions to come would lose cover, which would gain it) and changes nothing.
  Making the change returns the sessions it newly left uncovered, as every roster change does (ADR 0036).

## Consequences

- A venue that changes nothing: its rules are advisory, so its managers can now override a window with a reason (the owner's decision);
  its range officers and lifeguards are as they were; its instructors, where it kept the suggested certificate, now count unrecorded.
- A venue that wants none of it turns the override off (one checkbox), marks its rules hard, or sets its roles to required.
- Not built: an owner or platform emergency override; a level for one supervision rule apart from its role's (the level is the role's);
  an override of a window on a move to another resource at the same time (`moveBooking` does not ask the target's window at all, an
  existing gap, listed in known limitations); an alert by message (the line is on the needs-attention panel); the safety flag has no
  other effect than naming the closure. A legal requirement is a declaration, never verified.
- Existing text this changes: ADR 0037 F1 and its "Open for the owner" paragraph; `docs/features/booking.md` ("No manager's override goes
  past it", and D2's last clause); ADR 0036's secure-by-default sentence and `docs/features/venue-operations.md` where it said a person's
  shifts count for nothing until it is recorded; the staff dictionary's *no qualification recorded* and *qualifications* texts.
