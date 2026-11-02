import type { ScreenRow, StepNote, Tone, WorkflowStep } from "./model";

/**
 * Every step of every workflow of the public guide, as data
 * (docs/features/venue-guide.md#the-public-guide; adding one is described
 * there). A step names the capabilities it relies on; the registry
 * (`capabilities.ts`) says what each is and whether it is available, and
 * `tests/guide-public.test.ts` fails on a step that relies on one that does
 * not exist or is not available. A step's words are in the customer
 * dictionaries as `fit.s.<id>.t|s|c` and `fit.s.<id>.x.<note>`; its screen's
 * lines are made of `fit.tk.<token>` phrases.
 *
 * The screens are illustrations: made-up data, never a real venue's.
 * Browser-safe: data only.
 */

// ----------------------------------------------------------------- shorthand

const row = (tone: Tone, ...tokens: string[]): ScreenRow => ({ tokens, tone, as: "row" });
const button = (token: string): ScreenRow => ({ tokens: [token], tone: "plain", as: "action" });
const total = (...tokens: string[]): ScreenRow => ({ tokens, tone: "plain", as: "total" });
const field = (label: string, ...value: string[]): ScreenRow => ({ tokens: [label, ...value], tone: "plain", as: "field" });
/** A line shown only where the selection lists one of these capabilities. */
const when = (ids: string[], r: ScreenRow): ScreenRow => ({ ...r, when: ids });
const note = (id: string, ...needs: string[]): StepNote => ({ id, needs });

const ONLINE = ["pay-online-billplz", "pay-online-stripe", "pay-to-hold"];

export const STEP_LIST: WorkflowStep[] = [
  // ------------------------------------------------------- a customer books a court
  {
    id: "choose",
    actor: "customer",
    needs: ["resources", "booking-rules", "opening-hours"],
    notes: [note("linked", "linked-courts"), note("buffers", "buffers")],
    screen: [row("ok", "court1", "#19:00–20:00", "free", "$40"), row("wait", "court2", "#19:00–20:00", "held"), row("stop", "court3", "#19:00–20:00", "taken")],
  },
  {
    id: "price",
    actor: "system",
    needs: ["resources"],
    notes: [note("peak", "peak-pricing"), note("member", "member-rates"), note("promo", "promo-codes"), note("concession", "concessions")],
    screen: [row("plain", "court1", "#19:00–20:00", "$40"), total("total", "$40")],
  },
  {
    id: "pay",
    actor: "customer",
    needs: [],
    any: [...ONLINE, "counter-payments", "company-accounts"],
    notes: [
      note("hold", "pay-to-hold"),
      note("billplz", "pay-online-billplz"),
      note("stripe", "pay-online-stripe"),
      note("counter", "counter-payments"),
      note("account", "company-accounts"),
    ],
    screen: [
      when(ONLINE, button("btnPayOnline")),
      when(["counter-payments"], button("btnPayCounter")),
      when(["company-accounts"], row("plain", "onAccount")),
      when(["pay-to-hold"], row("wait", "heldUntil")),
    ],
  },
  {
    id: "day-list",
    actor: "staff",
    needs: ["day-list"],
    notes: [note("alerts", "booking-alerts")],
    screen: [row("wait", "#19:00–20:00", "court1", "#MS-4F2K9", "unpaid"), row("ok", "#20:00–21:00", "court2", "#MS-7Q1B3", "paid")],
  },
  {
    id: "attend",
    actor: "staff",
    needs: ["check-in"],
    optional: true,
    screen: [row("ok", "#MS-4F2K9", "checkedIn"), row("stop", "#MS-7Q1B3", "noShow"), button("btnCheckIn")],
  },
  {
    id: "cash-up",
    actor: "staff",
    needs: ["cash-up"],
    optional: true,
    screen: [row("plain", "cash", "takenIn", "$120"), row("plain", "qr", "takenIn", "$80")],
  },
  {
    id: "reports",
    actor: "manager",
    needs: ["reports"],
    optional: true,
    notes: [note("shared", "linked-courts")],
    screen: [row("plain", "booked", "$200"), row("plain", "collected", "$120"), row("wait", "owed", "$80"), row("plain", "hoursSold", "#42", "hoursUsed", "#37")],
  },

  // ------------------------------------------------------- staff book at the counter
  {
    id: "counter-start",
    actor: "staff",
    needs: ["day-list", "booking-rules"],
    notes: [note("override", "manager-overrides")],
    screen: [field("fPhone", "phoneSample"), field("fCourt", "court2", "#20:00–21:00"), button("btnBook")],
  },
  {
    id: "counter-settle",
    actor: "staff",
    needs: ["counter-payments"],
    notes: [note("pass", "passes"), note("credit", "stored-credit"), note("concession", "concessions"), note("member", "member-rates")],
    screen: [button("cash"), button("qr"), button("bank"), button("card")],
  },
  {
    id: "receipt",
    actor: "customer",
    needs: ["receipts-tax"],
    optional: true,
    screen: [row("plain", "court2", "#20:00–21:00"), row("ok", "paid", "cash"), total("total", "$40")],
  },

  // ------------------------------------------------------- paying online
  {
    id: "online-hold",
    actor: "customer",
    needs: ["pay-to-hold"],
    optional: true,
    screen: [row("wait", "heldUntil"), button("btnPayOnline")],
  },
  {
    id: "online-pay",
    actor: "customer",
    needs: [],
    any: ONLINE,
    notes: [note("billplz", "pay-online-billplz"), note("stripe", "pay-online-stripe"), note("part", "pay-to-hold")],
    screen: [row("plain", "gwPage"), row("ok", "paid", "$40")],
  },
  {
    id: "online-receipt",
    actor: "customer",
    needs: ["receipts-tax"],
    optional: true,
    notes: [note("email", "email-messages")],
    screen: [row("ok", "paid", "court1", "#19:00–20:00"), total("total", "$40")],
  },

  // ------------------------------------------------------- memberships
  {
    id: "mb-join",
    actor: "customer",
    needs: ["memberships"],
    notes: [note("family", "family-memberships")],
    screen: [row("plain", "planMonthly", "$60"), row("plain", "validTerm"), button("btnJoin")],
  },
  {
    id: "mb-book",
    actor: "customer",
    needs: ["memberships"],
    notes: [note("rates", "member-rates")],
    screen: [row("ok", "court1", "#19:00–20:00", "memberPrice", "$25"), row("stop", "notCovered", "renewHint")],
  },
  {
    id: "mb-arrive",
    actor: "staff",
    needs: ["memberships", "check-in"],
    optional: true,
    screen: [row("wait", "memberWarn"), button("btnAdmit")],
  },
  {
    id: "mb-suspend",
    actor: "manager",
    needs: ["membership-suspension"],
    optional: true,
    screen: [row("wait", "suspended", "reasonRecorded"), row("wait", "flagged", "#2")],
  },

  // ------------------------------------------------------- passes
  {
    id: "pass-sell",
    actor: "staff",
    needs: ["passes", "counter-payments"],
    notes: [note("online", "passes-online")],
    screen: [row("plain", "pass10", "$120"), row("plain", "passHours", "$100"), button("btnSellPass")],
  },
  {
    id: "pass-use",
    actor: "customer",
    needs: ["passes"],
    screen: [row("ok", "passUses"), row("plain", "passRemains"), row("stop", "passTooLittle")],
  },
  {
    id: "pass-ledger",
    actor: "system",
    needs: ["passes"],
    notes: [note("void", "refunds")],
    screen: [row("plain", "ledBought", "#+10"), row("plain", "ledSpent", "#−2"), row("plain", "ledBack", "#+2")],
  },

  // ------------------------------------------------------- classes
  {
    id: "cl-find",
    actor: "customer",
    needs: ["classes"],
    screen: [row("ok", "classBeginner", "#19:00–20:00", "#12", "placesLeft"), row("wait", "classFull", "waitlistOpen")],
  },
  {
    id: "cl-enrol",
    actor: "customer",
    needs: ["classes"],
    notes: [note("waiver", "waivers"), note("members", "memberships")],
    screen: [row("plain", "person1"), row("plain", "person2"), button("btnEnrol")],
  },
  {
    id: "cl-pay",
    actor: "customer",
    needs: ["classes"],
    any: ONLINE,
    optional: true,
    screen: [row("ok", "enrolled"), button("btnPayOnline")],
  },
  {
    id: "cl-roster",
    actor: "staff",
    needs: ["classes"],
    notes: [note("calloff", "venue-cancellations")],
    screen: [row("plain", "person1", "enrolled"), row("plain", "person2", "enrolled"), row("wait", "classFull", "waitlistOpen")],
  },

  // ------------------------------------------------------- lessons
  {
    id: "ls-choose",
    actor: "customer",
    needs: ["coaching"],
    screen: [row("ok", "coachA", "#19:00–20:00", "free"), row("plain", "coachB", "#20:00–21:00", "free"), row("plain", "feeFrom", "$60")],
  },
  {
    id: "ls-checks",
    actor: "system",
    needs: ["coaching"],
    screen: [row("ok", "court1", "coachA", "#19:00–20:00", "bothFree"), row("stop", "court1", "coachA", "#20:00–21:00", "coachBusy")],
  },
  {
    id: "ls-pay",
    actor: "customer",
    needs: ["coaching"],
    notes: [note("pack", "passes"), note("credit", "stored-credit")],
    screen: [total("total", "$60"), when(ONLINE, button("btnPayOnline")), when(["passes"], button("btnPayPack"))],
  },
  {
    id: "ls-coach",
    actor: "coach",
    needs: ["coaching"],
    notes: [note("children", "guardians")],
    screen: [row("plain", "#19:00–20:00", "lesson", "#Child 1"), row("plain", "#20:00–21:00", "lesson", "#Child 2"), row("plain", "calFeed")],
  },

  // ------------------------------------------------------- a parent registers a child
  {
    id: "gc-person",
    actor: "parent",
    needs: ["guardians"],
    screen: [field("fChildName", "#Child 1"), field("fRelationship", "relParent"), row("plain", "declaredOnly")],
  },
  {
    id: "gc-checks",
    actor: "system",
    needs: ["guardians"],
    notes: [note("membership", "memberships"), note("family", "family-memberships"), note("signoff", "sign-offs"), note("waiver", "waivers")],
    screen: [row("ok", "#Child 1", "childReady"), row("stop", "#Child 2", "childMissing")],
  },
  {
    id: "gc-approval",
    actor: "parent",
    needs: ["guardians", "activity-approvals"],
    optional: true,
    screen: [row("wait", "applied", "waitingStaff"), row("ok", "approved", "slotBooked")],
  },
  {
    id: "gc-book",
    actor: "parent",
    needs: ["guardians"],
    notes: [note("hold", "pay-to-hold"), note("pass", "passes")],
    screen: [row("plain", "#Child 1", "#19:00–20:00", "placeBooked"), when(["pay-to-hold"], row("wait", "heldUntil"))],
  },
  {
    id: "gc-attend",
    actor: "staff",
    needs: ["guardians", "check-in"],
    optional: true,
    screen: [row("ok", "#Child 1", "checkedIn"), row("stop", "#Child 2", "noShow")],
  },

  // ------------------------------------------------------- tournaments, leagues, open games
  {
    id: "tn-enter",
    actor: "player",
    needs: ["tournaments"],
    screen: [row("ok", "#Pair A", "entered"), row("wait", "#Pair B", "onWaitlist")],
  },
  {
    id: "tn-draw",
    actor: "manager",
    needs: ["tournaments"],
    screen: [row("plain", "seed1", "#Pair A"), row("plain", "seed2", "#Pair B"), row("plain", "byeTok")],
  },
  {
    id: "tn-play",
    actor: "manager",
    needs: ["tournaments"],
    screen: [row("ok", "#Pair A", "#21–15, 21–18", "#Pair C"), row("wait", "nextMatch", "court3", "#20:00–21:00")],
  },
  {
    id: "tn-public",
    actor: "player",
    needs: ["tournaments"],
    screen: [row("plain", "semiFinal"), row("stop", "#Pair C", "outTok")],
  },
  {
    id: "lg-join",
    actor: "player",
    needs: ["leagues"],
    screen: [row("ok", "joined"), row("plain", "partnerNamed")],
  },
  {
    id: "lg-boxes",
    actor: "manager",
    needs: ["leagues"],
    screen: [row("plain", "box1"), row("plain", "box2"), row("plain", "seasonSet")],
  },
  {
    id: "lg-report",
    actor: "player",
    needs: ["leagues"],
    screen: [row("wait", "scoreSent", "#6–3, 6–4"), row("ok", "confirmedOther"), row("stop", "disputed")],
  },
  {
    id: "lg-standings",
    actor: "system",
    needs: ["leagues"],
    screen: [row("ok", "#1", "movesUp"), row("plain", "#2", "stays"), row("stop", "#3", "movesDown")],
  },
  {
    id: "og-host",
    actor: "customer",
    needs: ["open-games"],
    screen: [row("plain", "places4"), row("plain", "levelMid"), row("plain", "shareEven")],
  },
  {
    id: "og-join",
    actor: "player",
    needs: ["open-games"],
    screen: [row("ok", "gameOpen"), row("wait", "gameFull")],
  },
  {
    id: "og-suggest",
    actor: "player",
    needs: ["open-games", "matchmaking"],
    optional: true,
    screen: [row("plain", "suggested", "#19:00–20:00", "court1"), row("plain", "whySuggested")],
  },
  {
    id: "og-money",
    actor: "system",
    needs: ["open-games"],
    screen: [row("plain", "hostBooking", "court1"), row("wait", "shareOwed")],
  },

  // ------------------------------------------------------- equipment hire
  {
    id: "eh-book",
    actor: "customer",
    needs: ["equipment-hire"],
    screen: [row("plain", "kayaks3", "#19:00–20:00", "$60"), total("total", "$60")],
  },
  {
    id: "eh-handover",
    actor: "staff",
    needs: ["equipment-hire"],
    screen: [row("ok", "depositHeld", "$100"), button("btnHandOver")],
  },
  {
    id: "eh-return",
    actor: "staff",
    needs: ["equipment-hire"],
    screen: [row("ok", "condFine"), row("stop", "condDamaged"), field("fNote", "noteRequired")],
  },
  {
    id: "eh-kept",
    actor: "manager",
    needs: ["equipment-hire", "receipts-tax"],
    optional: true,
    screen: [row("plain", "keptDamage", "$20"), row("wait", "taxProvisional")],
  },

  // ------------------------------------------------------- unstaffed entry
  {
    id: "un-induct",
    actor: "staff",
    needs: ["unstaffed-access", "sign-offs"],
    screen: [row("ok", "inductDone"), row("ok", "signOffRecorded")],
  },
  {
    id: "un-book",
    actor: "customer",
    needs: ["unstaffed-access"],
    screen: [row("plain", "lateSlot"), row("ok", "paid")],
  },
  {
    id: "un-code",
    actor: "customer",
    needs: ["unstaffed-access"],
    screen: [row("ok", "doorCode", "#4827"), row("stop", "noCodeYet")],
  },
  {
    id: "un-limits",
    actor: "staff",
    needs: ["unstaffed-access"],
    limits: ["smart-locks", "door-credentials"],
    screen: [row("plain", "lockHasCode"), row("plain", "lookLogged")],
  },

  // ------------------------------------------------------- timed sessions on shared facilities
  {
    id: "ts-choose",
    actor: "customer",
    needs: ["resources"],
    notes: [note("places", "shared-facilities")],
    screen: [row("ok", "#19:00–20:00", "#20", "placesLeft", "quiet"), row("wait", "#20:00–21:00", "#6", "placesLeft", "filling"), row("stop", "#21:00–22:00", "#0", "placesLeft", "busy")],
  },
  {
    id: "ts-price",
    actor: "system",
    needs: ["resources"],
    notes: [note("perPlayer", "per-player-pricing"), note("member", "memberships"), note("pass", "passes")],
    screen: [row("plain", "#2", "placesWord", "$40"), total("total", "$40")],
  },
  {
    id: "ts-arrive",
    actor: "staff",
    needs: ["check-in"],
    optional: true,
    screen: [row("ok", "#MS-4F2K9", "checkedIn"), row("stop", "#MS-7Q1B3", "noShow"), button("btnCheckIn")],
  },

  // ------------------------------------------------------- sign-offs
  {
    id: "so-rule",
    actor: "manager",
    needs: ["sign-offs"],
    screen: [row("plain", "signOffNeeded"), row("plain", "signOffExpiry")],
  },
  {
    id: "so-apply",
    actor: "customer",
    needs: ["sign-offs", "activity-approvals"],
    optional: true,
    screen: [row("wait", "applied", "waitingStaff"), row("ok", "approved")],
  },
  {
    id: "so-record",
    actor: "staff",
    needs: ["sign-offs"],
    notes: [note("waiver", "waivers")],
    screen: [row("ok", "signOffRecorded"), row("plain", "signOffBy")],
  },
  {
    id: "so-check",
    actor: "system",
    needs: ["sign-offs"],
    screen: [row("ok", "signOffValid"), row("stop", "signOffMissing")],
  },

  // ------------------------------------------------------- company accounts
  {
    id: "co-open",
    actor: "manager",
    needs: ["company-accounts"],
    screen: [row("plain", "orgName"), row("plain", "bookersListed"), row("plain", "limitSet")],
  },
  {
    id: "co-book",
    actor: "customer",
    needs: ["company-accounts"],
    screen: [row("plain", "whoPays"), row("wait", "unpaidOnAccount")],
  },
  {
    id: "co-invoice",
    actor: "system",
    needs: ["company-accounts"],
    notes: [note("email", "email-messages")],
    screen: [row("plain", "court1", "#19:00–20:00", "$40"), row("plain", "court2", "#20:00–21:00", "$40"), total("total", "$80")],
  },
  {
    id: "co-paid",
    actor: "staff",
    needs: ["company-accounts"],
    screen: [row("ok", "paid", "bank"), button("btnMarkPaid")],
  },
  {
    id: "co-credit",
    actor: "system",
    needs: ["company-accounts"],
    screen: [row("plain", "creditNote"), row("plain", "nextInvoice")],
  },

  // ------------------------------------------------------- cancelling and refunds
  {
    id: "cx-customer",
    actor: "customer",
    needs: ["refunds"],
    screen: [row("plain", "lookup", "#MS-4F2K9"), row("ok", "freeCancel"), row("wait", "lateCancel")],
  },
  {
    id: "cx-settle",
    actor: "system",
    needs: ["refunds"],
    notes: [note("stripe", "pay-online-stripe")],
    limits: ["billplz-refunds"],
    screen: [row("ok", "backOrig"), row("plain", "asCredit"), row("wait", "byHand")],
  },
  {
    id: "cx-staff",
    actor: "staff",
    needs: ["refunds", "counter-payments"],
    optional: true,
    screen: [row("plain", "previewPaid", "$40", "cash"), row("plain", "handedBack"), button("btnCancel")],
  },
  {
    id: "cx-venue",
    actor: "manager",
    needs: ["venue-cancellations"],
    optional: true,
    screen: [row("stop", "closedDay"), row("wait", "owedBack"), row("ok", "refunded")],
  },

  // ------------------------------------------------------- several branches
  {
    id: "br-signin",
    actor: "manager",
    needs: ["branches"],
    screen: [row("plain", "branchA"), row("plain", "branchB")],
  },
  {
    id: "br-add",
    actor: "manager",
    needs: ["branches", "branch-copy"],
    optional: true,
    screen: [row("wait", "draftBranch"), row("ok", "copiedTok"), row("stop", "notCopied")],
  },
  {
    id: "br-staff",
    actor: "manager",
    needs: ["branches", "staff-roles"],
    screen: [row("plain", "roleBiz"), row("plain", "roleBranch"), row("plain", "roleDesk")],
  },
  {
    id: "br-reports",
    actor: "manager",
    needs: ["branches", "reports"],
    optional: true,
    screen: [row("plain", "branchA", "booked", "$200"), row("plain", "branchB", "booked", "$120")],
  },
];
