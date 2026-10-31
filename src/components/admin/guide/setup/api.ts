import { readJson } from "@/lib/read-response";
import type { StaffT } from "@/lib/staff-i18n";
import type { SetupView } from "@/lib/guide/http";
import type { AnswerPatch } from "@/lib/guide/answer-schema";
import type { JourneyView } from "@/lib/guide/setup-journey";

/**
 * The journey's two ways of talking to the server, both to the guide's own
 * routes (docs/architecture/http-api.md): reading the whole journey, and
 * saving what the manager says (answers, a review). Every setting itself is
 * saved by the existing editor's own route, never here.
 */

/** What the journey draws beside the plan when the server has not sent it (or not yet): the saved profile's own figures, no courts, no examples. */
export const fallbackExtras = (v: SetupView): JourneyView["extras"] => ({
  focus: null,
  venue: { openMin: v.profile.hours.openMin, closeMin: v.profile.hours.closeMin, weekHours: null, cancelCutoffHours: v.profile.policies.cancellation.cutoffHours, timeZone: v.profile.identity.timeZone },
  courts: [],
  prices: [],
  tryIt: {
    live: v.profile.identity.live,
    made: v.profile.history.testBookings,
    standing: v.profile.history.testBookings,
    cancelled: 0,
    counterPaid: 0,
    emailService: v.profile.install.emailTransport,
    publicPath: `/venue/${v.venueId}`,
  },
});

export type Loaded = { ok: true; view: JourneyView } | { ok: false; error: string };

/** The journey for one venue, narrowed to `focus` for a targeted one. */
export async function loadJourney(venueId: number, focus: string | null, t: StaffT): Promise<Loaded> {
  try {
    const res = await fetch(`/api/admin/guide/setup/journey?venueId=${venueId}${focus ? `&focus=${encodeURIComponent(focus)}` : ""}`, { cache: "no-store" });
    const body = await readJson(res);
    if (!res.ok || !body?.plan) return { ok: false, error: t.err(body, t("gd.failed")) };
    return { ok: true, view: { ...body, extras: body.extras ?? fallbackExtras(body as SetupView) } as JourneyView };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : t("gd.failed") };
  }
}

export type Saved = { ok: true; view: SetupView } | { ok: false; error: string; stale: boolean; view?: SetupView };

/** One write to the setup route (`answers`, `acknowledge`): the venue's setup view back, or what refused it (a stale save also brings the current view). */
export async function writeGuide(venueId: number, body: { action: "answers"; answers: AnswerPatch; rev: number } | { action: "acknowledge"; step: string }, t: StaffT): Promise<Saved> {
  try {
    const res = await fetch("/api/admin/guide/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ venueId, ...body }) });
    const answer = await readJson(res);
    if (res.ok) return { ok: true, view: answer as SetupView };
    return { ok: false, error: t.err(answer, t("gd.failed")), stale: answer?.stale === true, ...(answer?.plan ? { view: answer as SetupView } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : t("gd.failed"), stale: false };
  }
}
