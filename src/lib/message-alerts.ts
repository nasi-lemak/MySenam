import { getDb } from "./db";
import { staffSentences, tellOwnersEach, tellVenueStaffEach } from "./owner-alerts";
import { staffEmailsOf } from "./safeguarding-conflict";

/**
 * What the people who deal with reports of messages between players are told, as it happens (docs/features/player-messages.md#moderation; ADR 0059).
 *
 * A report of a message in an ordinary conversation (a game, a tournament, a ladder, a team: an adult's too) used to wait for a manager to open the
 * reports panel. Now each is told when it is made, by the same alert for every report: to the managers of the conversation's venue, or to the platform's
 * owners where it has none (a community group, a team that plays from no venue). The alert says that a message was reported and how many reports are
 * open, and where to look: **never any message text, never who reported or who was reported, never why**; and it is not worded or ranked by what a
 * reporter chose, so a report that says someone feels unsafe is not read from text or treated differently by this code. A member of staff who is the
 * person reported is not among those told. Each alert is queued once (keyed by the report), and queued in the outbox: a mail server that is down
 * delays it rather than loses it.
 *
 * An automatic suspension (the published rule: three different people's reports within thirty days) is told the same way, to the owners and the managers
 * of the venue whose reports brought it about, with the date by which it is to be reviewed.
 *
 * Nothing here is a legal conclusion: how long a report may wait, and what must be done about one, are for the operator and its legal adviser (ADR 0052).
 */

async function openReportsAt(venueId: number | null): Promise<number> {
  return ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE status = 'open' AND venue_id IS NOT DISTINCT FROM ?").get(venueId)) as { n: number }).n;
}

/** A message in an ordinary conversation was reported: its venue's managers (the owners where it has no venue) are told, once. */
export async function tellNewReport(reportId: number, venueId: number | null, reportedId: number | null): Promise<void> {
  const open = await openReportsAt(venueId);
  const write = (t: Parameters<Parameters<typeof tellOwnersEach>[0]>[0]) => ({
    subject: t("fx10.rep.mail.s"),
    body: staffSentences(t, t("fx10.rep.mail.b", { n: open }), t("fx10.rep.mail.where")),
  });
  const opts = { exceptEmails: await staffEmailsOf(reportedId), dedupeKey: `msgreport:${reportId}` };
  if (venueId === null) await tellOwnersEach(write, opts);
  else await tellVenueStaffEach(venueId, write, { ...opts, managersOnly: true });
}

/** Somebody's messaging was suspended by the rule: the owners, and the managers of the venue whose report completed the count, are told, once, with its review date. */
export async function tellAutoSuspension(reportId: number, venueId: number | null): Promise<void> {
  const row = (await getDb()
    .prepare("SELECT s.id, COALESCE(s.review_by, datetime(s.created_at, '+14 days')) AS review_by, s.user_id FROM player_message_suspensions s WHERE s.report_id = ? AND s.source = 'automatic' AND s.lifted_at IS NULL ORDER BY s.id DESC LIMIT 1")
    .get(reportId)) as { id: number; review_by: string; user_id: number } | undefined;
  if (!row) return;
  const write = (t: Parameters<Parameters<typeof tellOwnersEach>[0]>[0]) => ({
    subject: t("fx10.sus.mail.s"),
    body: staffSentences(t, t("fx10.sus.mail.b", { date: row.review_by.slice(0, 10) }), t("fx10.rep.mail.where")),
  });
  const opts = { exceptEmails: await staffEmailsOf(row.user_id), dedupeKey: `msgsuspension:${row.id}` };
  await tellOwnersEach(write, opts);
  if (venueId !== null) await tellVenueStaffEach(venueId, write, { ...opts, managersOnly: true });
}

/** A suspended person asked for a review: whoever may decide it is told one is waiting (that and where only: nothing of why, nothing of who). */
export async function tellReviewRequested(appealId: number, suspensionVenueId: number | null, reportVenueIds: number[], suspendedUserId: number): Promise<void> {
  const write = (t: Parameters<Parameters<typeof tellOwnersEach>[0]>[0]) => ({
    subject: t("fx10.rev.mail.s"),
    body: staffSentences(t, t("fx10.rev.mail.b"), t("fx10.rep.mail.where")),
  });
  const opts = { exceptEmails: await staffEmailsOf(suspendedUserId), dedupeKey: `msgreview:${appealId}` };
  if (suspensionVenueId === null) await tellOwnersEach(write, opts);
  for (const venueId of suspensionVenueId !== null ? [suspensionVenueId] : reportVenueIds) await tellVenueStaffEach(venueId, write, { ...opts, managersOnly: true });
}
