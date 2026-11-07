import type { Admin } from "./admin-auth";
import { coachesWithoutEmail, type UntoldCoach } from "./coach-schedule";
import { noShowAttention, type NoShowAttention } from "./no-show-marks";
import { expiringSoon, lowPasses, strikeLines, type Expiring, type LowPass, type StrikeLine } from "./standing-notices";

/**
 * The needs-attention lines about people (ADR 0072), for `/api/admin/attention`:
 *
 * - `noShow` (managers and the owner; null for front desk): players' answers to hosts' no-show marks waiting for a decision, older marks that count
 *   at every venue and have not been reviewed (the owner's), and hosts whose marks are often reversed (lib/no-show-marks.ts);
 * - `expiring`, `low`, `strikes`: passes with entries left, memberships that will not renew and gift vouchers ending within two weeks; passes
 *   nearly used; numbers with a strike lately or at the venue's limit (lib/standing-notices.ts);
 * - `coaches`: coaches with lessons still to come and no email address, who therefore cannot be told (lib/coach-schedule.ts).
 *
 * Each is scoped to the staff member's own venues, the platform owner's to all.
 */
export interface PeopleAttention {
  noShow: NoShowAttention | null;
  expiring: Expiring[];
  low: LowPass[];
  strikes: StrikeLine[];
  coaches: UntoldCoach[];
}

export async function peopleAttention(admin: Admin): Promise<PeopleAttention> {
  return {
    noShow: await noShowAttention(admin),
    expiring: await expiringSoon(admin.venueIds),
    low: await lowPasses(admin.venueIds),
    strikes: await strikeLines(admin.venueIds),
    coaches: await coachesWithoutEmail(admin.venueIds),
  };
}
