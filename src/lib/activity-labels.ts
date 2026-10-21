/**
 * The staff activity log's shape and its words, apart from the code that
 * reads and writes it (lib/activity.ts), so the dashboard can show it.
 */

export interface StaffAction {
  id: number;
  adminId: number | null;
  adminName: string;
  venueId: number | null;
  bookingCode: string | null;
  action: string;
  detail: string | null;
  createdAt: string;
}

/** Plain words for each kind of entry, for the log's reader. */
export const ACTION_LABELS: Record<string, string> = {
  "booking.created": "Booked",
  "booking.cancelled": "Cancelled a booking",
  "booking.moved": "Moved a booking",
  "booking.rescheduled": "Changed a booking's time",
  "booking.no_show": "Marked a no-show",
  "payment.paid": "Marked paid",
  "payment.unpaid": "Marked unpaid",
  "payment.refunded": "Recorded a refund",
  "court.created": "Added a court",
  "court.changed": "Changed a court",
  "credit.changed": "Changed stored credit",
  "membership.sold": "Sold a membership",
  "membership.voided": "Voided a membership",
  "membership.plan_added": "Added a membership plan",
  "membership.plan_retired": "Retired a membership plan",
  "pass.sold": "Sold a pass",
  "pass.voided": "Voided a pass",
  "voucher.sold": "Sold a gift voucher",
  "voucher.voided": "Cancelled a gift voucher",
  "privacy.export": "Gave a customer their data",
  "strikes.forgiven": "Forgave a number its strikes",
  "einvoice.settings": "Changed e-invoicing settings",
  "einvoice.consolidated": "Sent last month's consolidated e-invoice",
  "einvoice.retried": "Sent an e-invoice again",
  "promo.created": "Made a promo code",
  "promo.voided": "Voided a promo code",
  "staff.added": "Added staff",
  "staff.removed": "Removed staff",
  "staff.role": "Changed a role",
  "settings.changed": "Changed settings",
  export: "Downloaded a spreadsheet",
};
