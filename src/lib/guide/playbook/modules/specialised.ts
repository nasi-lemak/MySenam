import { hasCoaching, hasMultipleBranches } from "../../profile-types";
import { heading, note, para, policy, screen, step, steps, w, warning } from "../dsl";
import { topicBlocks } from "../topics";
import type { Block, GuideRole, PlaybookModule } from "../types";

const BOTH: GuideRole[] = ["manager", "desk"];
const MANAGER: GuideRole[] = ["manager"];
const DESK: GuideRole[] = ["desk"];
const nn = (b: Block | null | false): b is Block => !!b;

/**
 * Workflows that exist only where the venue's saved configuration says they
 * do: a venue with no coaches has no coaching section, one with no tournament
 * has none for tournaments, and so on. Each `applies` reads the profile alone.
 */
export const SPECIALISED_MODULES: PlaybookModule[] = [
  {
    id: "spec.coaching",
    section: "specialised",
    roles: BOTH,
    applies: (p) => hasCoaching(p),
    blocks: (c) => {
      const p = c.profile;
      const noHours = p.people.coaches - p.people.coachesWithHours;
      return [
        heading("gp.spec.coaching.h", "spec-coaching"),
        para("gp.spec.coaching.text"),
        para("gp.spec.coaching.fee"),
        c.role === "manager"
          ? steps(
              step("gp.spec.coaching.s1", { screen: screen("classes"), coaches: w("coach.coaches") }, c.go("classes", "coaches")),
              step("gp.spec.coaching.s2"),
              step("gp.spec.coaching.s3"),
              step("gp.spec.coaching.s4", { screen: screen("reports") }, c.go("reports", "reports"))
            )
          : para("gp.spec.coaching.desk"),
        c.role === "manager" && noHours > 0 ? warning("gp.spec.coaching.noHours", { n: noHours }) : null,
        ...topicBlocks("another-coach", p, c.role),
      ].filter(nn);
    },
  },
  {
    id: "spec.classes",
    section: "specialised",
    roles: BOTH,
    applies: (p) => p.people.classes > 0,
    blocks: (c) => [
      heading("gp.spec.classes.h", "spec-classes"),
      para("gp.spec.classes.text"),
      c.role === "manager"
        ? steps(step("gp.spec.classes.m1", { screen: screen("classes") }, c.go("classes", "classes")), step("gp.spec.classes.m2", undefined, c.go("classes", "classChange")), step("gp.spec.classes.m3", undefined, c.go("classes", "classCancel")))
        : steps(step("gp.spec.classes.d1", { screen: screen("classes") }, c.go("classes")), step("gp.spec.classes.d2")),
      para("gp.spec.classes.enrol"),
    ],
  },
  {
    id: "spec.tournaments",
    section: "specialised",
    roles: MANAGER,
    applies: (p) => p.programmes.tournaments > 0,
    blocks: (c) => [
      heading("gp.spec.tournaments.h", "spec-tournaments"),
      para("gp.spec.tournaments.text"),
      steps(
        step("gp.spec.tournaments.s1", { screen: screen("tournaments") }, c.go("tournaments", "tournaments")),
        step("gp.spec.tournaments.s2", undefined, c.go("tournaments", "tournamentRun")),
        step("gp.spec.tournaments.s3", undefined, c.go("tournaments", "tournamentIssues")),
        step("gp.spec.tournaments.s4")
      ),
      note("gp.spec.tournaments.calloff"),
    ],
  },
  {
    id: "spec.leagues",
    section: "specialised",
    roles: MANAGER,
    applies: (p) => p.programmes.leagues > 0,
    blocks: (c) => [
      heading("gp.spec.leagues.h", "spec-leagues"),
      para("gp.spec.leagues.text"),
      steps(step("gp.spec.leagues.s1", { screen: screen("leagues") }, c.go("leagues", "leagues")), step("gp.spec.leagues.s2", undefined, c.go("leagues", "leagueRun"))),
    ],
  },
  {
    // Leagues of teams (lib/team-leagues.ts): the manager's season, from the fixture list to moving a fixture.
    id: "spec.teamLeagues",
    section: "specialised",
    roles: MANAGER,
    applies: (p) => (p.programmes.teamLeagues ?? 0) > 0,
    blocks: (c) => [
      heading("gp.spec.teamleagues.h", "spec-team-leagues"),
      para("gp.spec.teamleagues.text"),
      steps(
        step("gp.spec.teamleagues.s1", { screen: screen("leagues") }, c.go("leagues", "teamLeagues")),
        step("gp.spec.teamleagues.s2", undefined, c.go("leagues", "teamLeagueRun")),
        step("gp.spec.teamleagues.s3", undefined, c.go("leagues", "teamFixtureMove")),
        step("gp.spec.teamleagues.s4")
      ),
      note("gp.spec.teamleagues.court"),
    ],
  },
  {
    id: "spec.teamLeaguesDesk",
    section: "specialised",
    roles: DESK,
    applies: (p) => (p.programmes.teamLeagues ?? 0) > 0,
    blocks: (c) => [heading("gp.spec.teamleaguesdesk.h", "spec-team-leagues"), steps(step("gp.spec.teamleaguesdesk.s1", { screen: screen("leagues") }, c.go("leagues"))), para("gp.spec.teamleaguesdesk.rest")],
  },
  {
    id: "spec.competitionsDesk",
    section: "specialised",
    roles: DESK,
    applies: (p) => p.programmes.tournaments + p.programmes.leagues > 0,
    blocks: (c) => [
      heading("gp.spec.desk.h", "spec-competitions"),
      steps(
        c.profile.programmes.tournaments > 0 && step("gp.spec.desk.t", { screen: screen("tournaments") }, c.go("tournaments")),
        c.profile.programmes.leagues > 0 && step("gp.spec.desk.l", { screen: screen("leagues") }, c.go("leagues"))
      ),
      para("gp.spec.desk.rest"),
    ],
  },
  {
    id: "spec.openGames",
    section: "specialised",
    roles: BOTH,
    applies: (p) => p.programmes.openGames > 0,
    blocks: () => [heading("gp.spec.open.h", "spec-open"), para("gp.spec.open.text"), para("gp.spec.open.money"), para("gp.spec.open.staff")],
  },
  {
    id: "spec.family",
    section: "specialised",
    roles: BOTH,
    applies: (p) => p.guardians.familyPlans > 0,
    blocks: (c) => [
      heading("gp.spec.family.h", "spec-family"),
      para("gp.spec.family.text", { n: c.profile.guardians.familyPlans }),
      c.role === "manager" ? steps(step("gp.spec.family.manager", { screen: screen("credit") }, c.go("credit", "membershipCovers"))) : para("gp.spec.family.desk"),
    ],
  },
  {
    id: "spec.guardians",
    section: "specialised",
    roles: BOTH,
    applies: (p) => p.guardians.participants > 0 || p.guardians.approvalRequirements > 0,
    blocks: (c) => [
      heading("gp.spec.guardians.h", "spec-guardians"),
      ...topicBlocks("guardians", c.profile, c.role),
      para("gp.spec.guardians.deciding"),
    ],
  },
  {
    id: "spec.unstaffed",
    section: "specialised",
    roles: BOTH,
    applies: (p) => p.access.unstaffedHours || p.access.unmannedResources > 0,
    blocks: (c) => [heading("gp.spec.unstaffed.h", "spec-unstaffed"), ...topicBlocks("unattended", c.profile, c.role)],
  },
  {
    id: "spec.accounts",
    section: "specialised",
    roles: BOTH,
    applies: (p) => p.commerce.companyAccounts > 0,
    blocks: (c) => [
      heading("gp.spec.accounts.h", "spec-accounts"),
      para("gp.spec.accounts.text", { n: c.profile.commerce.companyAccounts }),
      c.role === "manager" ? steps(step("gp.spec.accounts.manager", { screen: screen("credit") }, c.go("credit", "accounts"))) : para("gp.spec.accounts.desk"),
    ],
  },
  {
    id: "spec.branches",
    section: "specialised",
    roles: MANAGER,
    applies: (p) => hasMultipleBranches(p),
    blocks: (c) =>
      [
        heading("gp.spec.branches.h", "spec-branches"),
        para("gp.spec.branches.text", { n: c.profile.branches.venues }),
        c.profile.branches.copiedFromBranch ? note("gp.spec.branches.copied") : null,
        policy("gp.spec.branches.scope"),
        steps(step("gp.spec.branches.add", { screen: screen("venues") }, c.go("venues", "addBranch"))),
      ].filter(nn),
  },
];
