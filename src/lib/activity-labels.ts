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
  "booking.concession": "Checked a concession price",
  "enquiry.handled": "Answered a private hire enquiry",
  "customer.note": "Wrote a note on a customer",
  "block.repeated": "Blocked hours every week",
  "account.changed": "Changed a company or school account",
  "account.charged": "Charged a booking to an account",
  "account.invoiced": "Invoiced an account",
  "account.paid": "Recorded an account's invoice paid",
  "payment.paid": "Marked paid",
  "payment.unpaid": "Marked unpaid",
  "payment.refunded": "Recorded a refund",
  "court.created": "Added a court",
  "court.changed": "Changed a court",
  "credit.changed": "Changed stored credit",
  "membership.sold": "Sold a membership",
  "membership.voided": "Voided a membership",
  "membership.extended": "Gave days back on a membership",
  "membership.plan_added": "Added a membership plan",
  "membership.plan_retired": "Retired a membership plan",
  "pass.sold": "Sold a pass",
  "pass.voided": "Voided a pass",
  "sale.made": "Sold at the counter",
  "sale.voided": "Voided a counter sale",
  "voucher.sold": "Sold a gift voucher",
  "voucher.voided": "Cancelled a gift voucher",
  "privacy.export": "Gave a customer their data",
  "tournament.closed": "Closed a tournament's entries",
  "tournament.drawn": "Made a tournament draw",
  "tournament.cancelled": "Called off a tournament",
  "league.started": "Started a league season",
  "league.ended": "Ended a league season",
  "league.planned": "Planned a league season",
  "league.closed": "Closed a league",
  "strikes.forgiven": "Forgave a number its strikes",
  "einvoice.settings": "Changed e-invoicing settings",
  "einvoice.consolidated": "Sent last month's consolidated e-invoice",
  "einvoice.retried": "Sent an e-invoice again",
  "review.replied": "Replied to a review",
  "review.reported": "Reported a review to the platform",
  "review.requests": "Changed review requests",
  "review.hidden": "Hid a review",
  "review.shown": "Showed a review again",
  "campaign.sent": "Emailed news to customers who asked for it",
  "integration.changed": "Changed API keys or webhooks",
  "promo.created": "Made a promo code",
  "promo.voided": "Voided a promo code",
  "staff.added": "Added staff",
  "staff.removed": "Removed staff",
  "staff.role": "Changed a role",
  "settings.changed": "Changed settings",
  export: "Downloaded a spreadsheet",
};
