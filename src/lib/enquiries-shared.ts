/** What a private hire enquiry can be for, and where it stands: shared by the page and the server (lib/enquiries.ts). */
export const ENQUIRY_KINDS = ["event", "tournament", "corporate", "party", "school", "other"] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];
export const ENQUIRY_STATUSES = ["new", "replied", "booked", "declined"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];
