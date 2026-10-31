import { NextResponse } from "next/server";
import { denyVenue, type Admin } from "../admin-auth";
import { readGuide, type GuideState } from "./answers";
import { discover } from "./discover";
import { buildSetupPlan } from "./plan";
import { launchReadiness } from "./readiness";
import { readVenueProfile } from "./profile";
import type { GuideRole } from "./shell";

/**
 * What the guide's routes share (docs/features/venue-guide.md#routes): which
 * venue a request is about, whose guide it is, and the setup answer both the
 * read and every write send back.
 */

/** The role a session's guide is for: the session's own, from the server, never from a parameter. */
export function ownRole(admin: Pick<Admin, "role">): GuideRole {
  return admin.role === "desk" ? "desk" : "manager";
}

/** The venue asked about (`?venueId=` or the body's), or the admin's own single venue; null when none is named. */
export function venueOf(admin: Pick<Admin, "venueIds">, raw: unknown): number | null {
  const own = admin.venueIds?.length === 1 ? admin.venueIds[0] : null;
  const id = raw === undefined || raw === null || raw === "" ? own : Number(raw);
  return Number.isInteger(id) && (id as number) > 0 ? (id as number) : null;
}

/** The venue for a request, or the response to send instead: 400 when none is named, 403 when the admin may not manage it. */
export function guideVenue(admin: Admin, raw: unknown): number | NextResponse {
  const venueId = venueOf(admin, raw);
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/**
 * The setup view of one venue, all of it read afresh from the venue's saved
 * configuration and its saved answers: the profile, the answers and their
 * revision, the plan, the launch readiness and the discoveries. Strictly one
 * venue's; nothing is kept between requests.
 */
export async function setupView(venueId: number, role: GuideRole, state?: GuideState) {
  const profile = await readVenueProfile(venueId);
  const saved = state ?? (await readGuide(venueId));
  const plan = buildSetupPlan({ profile, answers: saved.answers, acknowledged: saved.acknowledged, role });
  return {
    venueId,
    role,
    profile,
    answers: saved.answers,
    rev: saved.rev,
    acknowledged: saved.acknowledged,
    dismissed: saved.dismissed,
    plan,
    readiness: launchReadiness(profile, plan),
    discoveries: discover(profile, saved.answers, saved.dismissed),
  };
}

export type SetupView = Awaited<ReturnType<typeof setupView>>;
