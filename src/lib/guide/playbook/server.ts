import { getVenue } from "../../store";
import { addDays, todayISO } from "../../time";
import { coachLessons, type CoachByToken } from "../../coach-schedule";
import { readVenueProfile } from "../profile";
import type { GuideRole } from "../shell";
import { buildPlaybook } from "./index";
import type { Playbook } from "./types";

/**
 * The playbook for a venue and a role, built fresh from the venue's saved
 * configuration on each call (docs/features/venue-guide.md, "The operating
 * playbook"). Server-only: it reads the profile. Nothing is kept between calls
 * or between venues.
 */
export async function playbookFor(venueId: number, role: GuideRole): Promise<Playbook> {
  const [profile, venue] = await Promise.all([readVenueProfile(venueId), getVenue(venueId)]);
  return buildPlaybook(profile, role, { venueName: venue?.name ?? null });
}

/**
 * A coach's guide, from their private link: the coach's venue (their coach
 * record belongs to exactly one) and their own facts (how many lessons of
 * theirs are coming, whether their hours are set, their days off) and nothing
 * of anybody else's.
 */
export async function coachPlaybook(found: CoachByToken): Promise<Playbook> {
  const profile = await readVenueProfile(found.coach.venueId);
  const today = todayISO(found.zone);
  const lessons = await coachLessons(found.coach.id, today, addDays(today, 30));
  return buildPlaybook(profile, "coach", {
    venueName: found.venueName,
    coach: { lessonsAhead: lessons.length, hoursSet: found.coach.hours.length > 0, timeOff: found.coach.timeOff.length },
  });
}
