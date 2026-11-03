import { getDb } from "./db";
import { shortName } from "./tournament-day";
import { GUARDIAN_AGE, ageOn, type TournamentDetail } from "./tournaments";

/**
 * A counted event's public page (bouldering, a height: lib/counted-performances.ts) names a declared minor by first name and
 * the initial of the next, as the live page does (`shortName`, lib/tournament-day.ts), and everybody so where the tournament
 * says it shows short names. A declared minor is one with a guardian's agreement, a participant a guardian manages, or a date
 * of birth under 18 on the first day: the entrant's word, never verified. A team, and any other kind of event, is shown as it was.
 */
export async function namedForThePublic(d: TournamentDetail): Promise<TournamentDetail> {
  if (!d.rules.performance?.counted) return d;
  const rows = (await getDb()
    .prepare("SELECT id, guardian_name, participant_id, birth_date FROM tournament_entries WHERE tournament_id = ?")
    .all(d.id)) as { id: number; guardian_name: string | null; participant_id: number | null; birth_date: string | null }[];
  const short = new Set(
    rows
      .filter((r) => d.liveNames === "short" || r.guardian_name !== null || r.participant_id !== null || (r.birth_date !== null && ageOn(r.birth_date, d.startsOn) < GUARDIAN_AGE))
      .map((r) => r.id)
  );
  return { ...d, entries: d.entries.map((e) => (short.has(e.id) ? { ...e, name: shortName(e.name) } : e)) };
}
