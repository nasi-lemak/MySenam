import { NextResponse } from "next/server";

/**
 * What front-desk staff may not do.
 *
 * A venue's staff are a manager or front desk. The desk runs the day: takes
 * bookings, marks them paid (and how), checks people in, moves, changes and
 * cancels bookings, hands out kit, sells passes, memberships and credit, and
 * blocks a court for an hour. A manager also sets the venue up and handles
 * money going back out: courts and prices, the venue's details and rules, who
 * it is for, payment settings, refunds and voids, promo codes, notices,
 * photos, WhatsApp, the marketplace invoice, and the reports.
 *
 * Written once, here, as the addresses and methods a desk account is turned
 * away from in `requireAdmin` (lib/admin-auth.ts), so a route cannot forget
 * to ask; `tests/roles.test.ts` holds every line of it to a real route.
 */
export const MANAGER_ONLY: { path: RegExp; methods: string[] | "all" }[] = [
  { path: /^\/api\/admin\/addons(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/billing$/, methods: ["POST"] },
  { path: /^\/api\/admin\/courts(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/classes(\/\d+)?$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/go-live$/, methods: ["POST"] },
  { path: /^\/api\/admin\/(hold-policy|house-rules|venue-access|venue-tax|booking-alerts|peak-rules|slot-length|venue-time-zone|cancel-policy|calendar-feed)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/holidays$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/data-request$/, methods: "all" },
  { path: /^\/api\/admin\/coaches$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/strikes$/, methods: ["POST"] },
  { path: /^\/api\/admin\/(leagues|tournaments)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/(memberships|passes|promos|vouchers)\/\d+\/void$/, methods: ["POST"] },
  { path: /^\/api\/admin\/promos$/, methods: ["POST"] },
  { path: /^\/api\/admin\/membership-plans$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/notices(\/\d+)?$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/online-payments$/, methods: ["POST"] },
  { path: /^\/api\/admin\/outages$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/reports$/, methods: "all" },
  { path: /^\/api\/admin\/activity$/, methods: "all" },
  { path: /^\/api\/admin\/export$/, methods: "all" },
  { path: /^\/api\/admin\/venues\/\d+$/, methods: ["PATCH"] },
  { path: /^\/api\/admin\/venues\/\d+\/(closures|blocked-phones)$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/venues\/\d+\/payment-settings$/, methods: "all" },
  { path: /^\/api\/admin\/venues\/\d+\/photos(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/whatsapp$/, methods: ["POST"] },
  { path: /^\/api\/admin\/storefronts$/, methods: ["POST", "DELETE"] },
];

export type StaffRole = "manager" | "desk";

/** The answer a front-desk account gets for something a manager does. */
export function deskRefusal(role: StaffRole, method: string, path: string): NextResponse | null {
  if (role !== "desk") return null;
  const hit = MANAGER_ONLY.some((r) => r.path.test(path) && (r.methods === "all" || r.methods.includes(method.toUpperCase())));
  return hit
    ? NextResponse.json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, { status: 403 })
    : null;
}
