import { hasCoaching, hasMultipleBranches, hasScheduledChanges, usesOnlinePayments, type VenueProfile } from "../../profile-types";
import type { DashboardTab } from "../../shell";
import { SCREEN_PHRASE, fact, facts, heading, note, para, step, steps, w } from "../dsl";
import type { Block, GuideRole, PhraseKey, PlaybookModule, Value } from "../types";

const BOTH: GuideRole[] = ["manager", "desk"];
const MANAGER: GuideRole[] = ["manager"];
const DESK: GuideRole[] = ["desk"];
const always = () => true;

const PROVIDER: Record<string, string> = { billplz: "Billplz", stripe: "Stripe" };

/** The features this venue's saved configuration shows it uses, as phrases: nothing is listed that the profile does not show. */
export function featuresInUse(p: VenueProfile): PhraseKey[] {
  const out: PhraseKey[] = [];
  const add = (on: boolean, key: PhraseKey) => {
    if (on) out.push(key);
  };
  add(p.rates.peakPricing, "gp.feat.peak");
  add(p.rates.memberRates, "gp.feat.memberRates");
  add(p.rates.lastMinute, "gp.feat.lastMinute");
  add(p.commerce.concessions > 0, "gp.feat.concessions");
  add(p.commerce.promoCodes > 0, "gp.feat.promos");
  add(p.commerce.membershipPlans > 0, "gp.feat.memberships");
  add(p.commerce.passProducts > 0, "gp.feat.passes");
  add(p.commerce.extras > 0, "gp.feat.extras");
  add(p.payments.storedCredit, "gp.feat.credit");
  add(p.payments.giftVouchers, "gp.feat.vouchers");
  add(usesOnlinePayments(p), "gp.feat.online");
  add(p.policies.payToHold, "gp.feat.hold");
  add(p.policies.limits || p.policies.bookAheadDays !== null, "gp.feat.limits");
  add(p.policies.signOffRequired, "gp.feat.signoff");
  add(p.resources.shared > 0, "gp.feat.shared");
  add(p.resources.linked > 0, "gp.feat.linked");
  add(p.resources.withBuffers > 0, "gp.feat.buffers");
  add(p.resources.perPlayer > 0, "gp.feat.perPlayer");
  add(p.people.classes > 0, "gp.feat.classes");
  add(hasCoaching(p), "gp.feat.coaching");
  add(p.programmes.tournaments > 0, "gp.feat.tournaments");
  add(p.programmes.leagues > 0, "gp.feat.leagues");
  add(p.programmes.openGames > 0, "gp.feat.openGames");
  add(p.guardians.familyPlans > 0, "gp.feat.family");
  add(p.guardians.approvalRequirements > 0, "gp.feat.approvals");
  add(p.access.unstaffedHours || p.access.unmannedResources > 0, "gp.feat.unstaffed");
  add(p.commerce.hireDeposits, "gp.feat.hire");
  add(p.commerce.companyAccounts > 0, "gp.feat.accounts");
  add(hasMultipleBranches(p), "gp.feat.branches");
  add(p.compliance.einvoicing.enabled, "gp.feat.einvoicing");
  add(p.channels.apiKeys > 0, "gp.feat.api");
  return out;
}

const COUNTER_WORDS: Record<string, PhraseKey> = { cash: "gp.method.cash", qr: "gp.method.qr", transfer: "gp.method.transfer", card: "gp.method.card" };

/** The sentences that say what the venue is, from its saved configuration: the top of every guide. */
export function summarise(p: VenueProfile): { key: PhraseKey; vars?: Record<string, Value> }[] {
  const out: { key: PhraseKey; vars?: Record<string, Value> }[] = [];
  if (p.resources.total > 0)
    out.push(
      p.activities.length > 0
        ? { key: "gp.sum.resources", vars: { n: p.resources.total, activities: { list: p.activities.map((a) => ({ activity: a.key })) } } }
        : { key: "gp.sum.resourcesOnly", vars: { n: p.resources.total } }
    );
  else out.push({ key: "gp.sum.none" });
  out.push({ key: "gp.sum.hours", vars: { from: { clock: p.hours.openMin }, to: { clock: p.hours.closeMin } } });
  if (p.rates.lowest !== null && p.rates.highest !== null)
    out.push({
      key: p.rates.peakPricing ? "gp.sum.ratesPeak" : p.rates.lowest === p.rates.highest ? "gp.sum.rateOne" : "gp.sum.ratesRange",
      vars: { low: { money: p.rates.lowest }, high: { money: p.rates.highest } },
    });
  const channels: Value[] = [];
  if (p.identity.live) channels.push(w("gp.chan.online"));
  channels.push(w("gp.chan.counter"));
  out.push({ key: "gp.sum.channels", vars: { list: { list: channels } } });
  if (p.commerce.membershipPlans > 0) out.push({ key: "gp.sum.memberships" });
  return out;
}

export const START_MODULES: PlaybookModule[] = [
  {
    id: "start.overview",
    section: "start",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      const page: PhraseKey = p.identity.suspended
        ? "gp.v.page.suspended"
        : p.identity.draft
          ? "gp.v.page.draft"
          : p.identity.visibility === "members"
            ? "gp.v.page.members"
            : p.identity.visibility === "private"
              ? "gp.v.page.private"
              : "gp.v.page.public";
      const online = p.payments.online;
      const provider = online.provider ? (PROVIDER[online.provider] ?? online.provider) : "";
      const rateWords: PhraseKey = p.rates.peakPricing ? "gp.v.ratesPeak" : p.rates.lowest === p.rates.highest ? "gp.v.rateOne" : "gp.v.ratesRange";
      return [
        heading("gp.start.overview.h", "overview"),
        para("gp.start.overview.intro"),
        facts(
          fact("gp.f.resources", "gp.v.n", { n: p.resources.total }),
          p.activities.length > 0 && fact("gp.f.activities", "gp.v.list", { list: { list: p.activities.map((a) => ({ activity: a.key })) } }),
          fact("gp.f.hours", "gp.v.hours", { from: { clock: p.hours.openMin }, to: { clock: p.hours.closeMin } }),
          p.rates.lowest !== null && p.rates.highest !== null && fact("gp.f.rates", rateWords, { low: { money: p.rates.lowest }, high: { money: p.rates.highest } }),
          fact("gp.f.page", page),
          fact("gp.f.counter", "gp.v.counter"),
          fact(
            "gp.f.payments",
            online.accountEnabled ? (online.sandbox ? "gp.v.payOnlineTest" : "gp.v.payOnline") : online.accountExists ? "gp.v.payOnlineOff" : "gp.v.payCounterOnly",
            { provider }
          ),
          p.payments.counterMethods.length > 0 && fact("gp.f.methods", "gp.v.list", { list: { list: p.payments.counterMethods.map((m) => w(COUNTER_WORDS[m])) } }),
          c.role === "manager" && fact("gp.f.staff", "gp.v.staff", { managers: p.staff.managers, desk: p.staff.desk }),
          hasMultipleBranches(p) && fact("gp.f.branches", "gp.v.n", { n: p.branches.venues })
        ),
        p.hours.weekdayOverrides ? para("gp.start.weekdayHours") : null,
        p.hours.closedDays > 0 ? para("gp.start.closedDays", { n: p.hours.closedDays }) : null,
      ].filter((b): b is Block => b !== null);
    },
  },
  {
    id: "start.draft",
    section: "start",
    roles: BOTH,
    applies: (p) => p.identity.draft && !p.identity.suspended,
    blocks: (c) => [
      note("gp.start.draft.note"),
      c.role === "manager" ? steps(step("gp.start.draft.go", undefined, c.go("guide", "guideSetup", "setup"))) : para("gp.start.draft.desk"),
    ],
  },
  {
    id: "start.scheduled",
    section: "start",
    roles: BOTH,
    applies: (p) => hasScheduledChanges(p),
    blocks: (c) => {
      const p = c.profile;
      const blocks: Block[] = [heading("gp.sched.h", "coming"), para("gp.sched.intro")];
      for (const h of p.hours.scheduled)
        blocks.push({ type: "callout", kind: "scheduled", title: w("gp.sched.title", { date: { date: h.from } }), text: w("gp.sched.hours", { from: { clock: h.openMin }, to: { clock: h.closeMin } }) });
      for (const r of p.rates.scheduled)
        blocks.push({ type: "callout", kind: "scheduled", title: w("gp.sched.title", { date: { date: r.from } }), text: w("gp.sched.rates", { n: r.resources }) });
      if (c.role === "manager")
        blocks.push(
          steps(
            p.hours.scheduled.length > 0 && step("gp.sched.changeHours", undefined, c.go("venues", "datedHours")),
            p.rates.scheduled.length > 0 && step("gp.sched.changeRates", undefined, c.go("courts", "datedCourtChanges"))
          )
        );
      return blocks;
    },
  },
  {
    id: "start.features",
    section: "start",
    roles: BOTH,
    applies: (p) => featuresInUse(p).length > 0,
    blocks: (c) => {
      const used = featuresInUse(c.profile);
      return [
        heading("gp.start.features.h", "features"),
        para("gp.start.features.used", { list: { list: used.map((k) => w(k)) } }),
        c.role === "manager" ? steps(step("gp.start.features.discover", undefined, c.go("guide", "guideSetup", "discover"))) : null,
      ].filter((b): b is Block => b !== null);
    },
  },
  {
    id: "start.where",
    section: "start",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      const row = (tab: DashboardTab, value: PhraseKey) => {
        const link = c.go(tab);
        return link ? fact(SCREEN_PHRASE[tab], value, undefined, link) : null;
      };
      const mgr = c.role === "manager";
      return [
        heading("gp.start.where.h", "where"),
        facts(
          row("bookings", "gp.where.bookings"),
          row("schedule", "gp.where.schedule"),
          row("occupancy", "gp.where.occupancy"),
          mgr ? row("reports", "gp.where.reports") : null,
          mgr ? row("courts", "gp.where.courts") : null,
          row("classes", hasCoaching(p) ? "gp.where.classesCoaching" : p.people.classes > 0 ? "gp.where.classesUsed" : "gp.where.classes"),
          p.programmes.tournaments > 0 ? row("tournaments", "gp.where.tournaments") : null,
          p.programmes.leagues > 0 ? row("leagues", "gp.where.leagues") : null,
          row("credit", "gp.where.credit"),
          mgr ? row("venues", "gp.where.venues") : null,
          row("guide", mgr ? "gp.where.guideManager" : "gp.where.guideDesk")
        ),
      ];
    },
  },
  {
    id: "start.roles",
    section: "start",
    roles: MANAGER,
    applies: always,
    blocks: (c) =>
      [
        heading("gp.start.roles.h", "roles"),
        para("gp.start.roles.desk"),
        para("gp.start.roles.manager"),
        c.profile.staff.pendingInvitations > 0 ? para("gp.start.roles.pending", { n: c.profile.staff.pendingInvitations }) : null,
        steps(step("gp.start.roles.invite", undefined, c.go("venues", "staff"))),
      ].filter((b): b is Block => b !== null),
  },
  {
    id: "start.deskLimits",
    section: "start",
    roles: DESK,
    applies: always,
    blocks: () => [heading("gp.start.deskLimits.h", "limits"), para("gp.start.deskLimits.text")],
  },
];
