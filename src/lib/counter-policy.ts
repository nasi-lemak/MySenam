import { NextResponse } from "next/server";
import { logAction } from "./activity";
import { saidOn, type BookingPath } from "./limits";
import { POLICY_NAMES, venueOverrides, type PolicyOverrideRecord } from "./policy-overrides";
import { readWindowOverride, windowOffer, windowOverrideAuth, windowSettings, type WindowOverrideRecord } from "./window-overrides";
import { errorText, translator } from "./i18n";
import { canAccessVenue, isOwner, type Admin } from "./admin-auth";
import type { Refusal } from "./types";

/**
 * A refusal of the venue's policies (lib/limits.ts `policyCheck`), as the
 * route that asked answers it: said on its path (`saidOn`), and at the
 * counter with what staff can do about it, so the form can offer it:
 * `payNow` where taking payment as it is booked lets it through (no-show
 * strikes, the guest limit); `policy` where it is one a manager may override;
 * `overridable` where this member of staff may override it here now (a
 * manager, the venue permitting it); `askManager` where the venue permits it
 * but they are front desk.
 */
export async function policyRefused(
  path: BookingPath,
  r: Refusal,
  counter: { staff: { role: "manager" | "desk" }; venueId: number } | null,
  status = 409
): Promise<NextResponse> {
  if (r.code === "BUSY") return NextResponse.json({ error: r.error, code: r.code }, { status: 503, headers: { "Retry-After": "2" } });
  const said = saidOn(path, r);
  const extra: Record<string, unknown> = {};
  if (counter) {
    if (said.policy) {
      const permitted = (await venueOverrides(counter.venueId)).includes(said.policy);
      extra.policy = said.policy;
      extra.overridable = permitted && counter.staff.role !== "desk";
      extra.askManager = permitted && counter.staff.role === "desk";
    }
    if (r.code === "STRIKES_COUNTER" || r.code === "GUEST_SURGE") extra.payNow = true;
  }
  return NextResponse.json({ error: said.error, code: said.code, vars: said.vars, ...extra }, { status });
}

/**
 * A manager's override of an advisory launch or tide window, read from a staff request's body and authorised (lib/window-overrides.ts):
 * `{ overrideWindow: true, windowReason }`. Nothing asked is `{}`; a request that cannot be honoured is the refusal to send. Customers,
 * the venue's API key and front desk are never accepted: `staff` is the signed-in member of staff at this venue, or null.
 */
export async function windowOverrideFromBody(
  body: Record<string, unknown>,
  staff: Admin | null,
  venueId: number | undefined
): Promise<{ record?: WindowOverrideRecord; refuse?: NextResponse }> {
  const ask = readWindowOverride(body);
  if (!ask) return {};
  if ("ok" in ask) return { refuse: NextResponse.json({ error: ask.error, code: ask.code, vars: ask.vars }, { status: 400 }) };
  const mine = staff && venueId !== undefined && canAccessVenue(staff, venueId) ? { id: staff.id, name: staff.name, role: staff.role, owner: isOwner(staff) } : null;
  const auth = await windowOverrideAuth(mine, venueId ?? 0, ask.reason);
  if (!auth.ok) return { refuse: NextResponse.json({ error: auth.refusal.error, code: auth.refusal.code, vars: auth.refusal.vars }, { status: auth.status }) };
  return { record: auth.record };
}

/**
 * A launch or tide window's refusal at the counter, with what the member of staff can do about it: `policy: "launch_window"`,
 * `overridable` for a manager where the venue allows it (the form asks why and sends the override), `askManager` for front desk, or
 * `hard` where the venue's rule is hard and nothing overrides it. The sentence says so too, for a system reading the API.
 */
export async function windowRefused(r: Refusal, counter: { staff: Admin; venueId: number }, status = 409): Promise<NextResponse> {
  const offer = await windowOffer({ role: counter.staff.role, owner: isOwner(counter.staff) }, counter.venueId, r.code, r.strength ?? "advisory");
  if (!offer) return NextResponse.json({ error: r.error, code: r.code, vars: r.vars }, { status });
  const settings = await windowSettings(counter.venueId);
  const note = offer.hard
    ? errorText(translator("en"), "SAFE1_WINDOW_HARD")
    : offer.overridable
      ? errorText(translator("en"), "SAFE1_WINDOW_OFFER", { min: settings.reasonMin })
      : "";
  return NextResponse.json({ error: note ? `${r.error} ${note}` : r.error, code: r.code, vars: r.vars, ...offer }, { status });
}

/** A manager's override, in the activity log against the booking it let through (`booking.policy_overridden`). */
export async function logOverride(
  staff: { id: number; name: string },
  bookingCode: string,
  who: { name: string; phone: string },
  record: PolicyOverrideRecord
): Promise<void> {
  await logAction(staff, {
    venueId: record.venueId,
    action: "booking.policy_overridden",
    bookingCode,
    detail: `Overrode ${record.overridden.map((o) => `${POLICY_NAMES[o.policy]} (${o.code})`).join(", ")} for ${who.name} on ${who.phone}: ${record.reason}`,
  });
}
