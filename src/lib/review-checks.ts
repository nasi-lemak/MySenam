/**
 * What the platform owner confirms before letting a venue in. Kept apart from
 * lib/applications.ts, which reaches the database, so the approvals panel in
 * the browser can show the same list the server insists on.
 */
export const REVIEW_CHECKS = [
  { id: "location", label: "The pin is on the venue: I looked at the map, and Street View if there is any" },
  { id: "phone", label: "I phoned the venue's number and they confirmed they applied" },
  { id: "business", label: "The business exists beyond this form: a Google listing, website or social media page" },
  { id: "photos", label: "Any photos show this venue, not another place or stock pictures (or there are none)" },
] as const;

export type ReviewCheck = (typeof REVIEW_CHECKS)[number]["id"];
