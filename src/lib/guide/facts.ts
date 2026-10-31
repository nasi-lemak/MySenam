import type { Say } from "./plan";
import type { VenueProfile } from "./profile-types";
import { hasScheduledChanges } from "./profile-types";
import type { GuideRole } from "./shell";

/**
 * What the playbook route answers until the playbook is built on it
 * (docs/features/venue-guide.md#the-playbook-route): a few facts from the
 * venue's real configuration, chosen for the role asked for. Nothing here is
 * a rule or an instruction; it shows that the route derives its content from
 * the profile and the role, and which facts a front desk or a coach is not
 * shown (the money settings and the staff are a manager's).
 */
export function guideFacts(profile: VenueProfile, role: GuideRole): Say[] {
  const facts: Say[] = [];
  facts.push({ key: "gd.fact.activities", vars: { n: profile.activities.length } });
  if (role === "coach") return facts;
  facts.push({ key: "gd.fact.resources", vars: { n: profile.resources.total } });
  if (profile.channels.onlinePage) facts.push({ key: "gd.fact.online" });
  if (profile.channels.counter) facts.push({ key: "gd.fact.counter" });
  facts.push({ key: "gd.fact.cancel", vars: { n: profile.policies.cancellation.cutoffHours } });
  if (role === "desk") return facts;
  if (profile.payments.online.accountEnabled) facts.push({ key: "gd.fact.onlinePayments" });
  if (hasScheduledChanges(profile)) facts.push({ key: "gd.fact.scheduled" });
  if (profile.people.coaches > 0) facts.push({ key: "gd.fact.coaches", vars: { n: profile.people.coaches } });
  facts.push({ key: "gd.fact.staff", vars: { managers: profile.staff.managers, desk: profile.staff.desk } });
  return facts;
}
