import { NextResponse } from "next/server";
import { logAction } from "./activity";
import { saidOn, type BookingPath } from "./limits";
import { POLICY_NAMES, venueOverrides, type PolicyOverrideRecord } from "./policy-overrides";
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
