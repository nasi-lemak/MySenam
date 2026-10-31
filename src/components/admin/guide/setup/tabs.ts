import type { StaffPhrase } from "@/lib/staff-i18n";
import type { SetupGroup } from "@/lib/guide/plan";
import type { DashboardTab } from "@/lib/guide/shell";

/** What a screen is called in the dashboard's own tab labels (the same words as the tab bar). */
export const TAB_PHRASES: Record<DashboardTab, StaffPhrase> = {
  bookings: "sh.tab.bookings",
  schedule: "sh.tab.schedule",
  occupancy: "sh.tab.occupancy",
  reports: "sh.tab.reports",
  courts: "sh.tab.courts",
  classes: "sh.tab.classes",
  tournaments: "sh.tab.tournaments",
  leagues: "sh.tab.leagues",
  credit: "sh.tab.credit",
  venues: "sh.tab.venueDetails",
  guide: "gd.tab",
};

/** The plan's groups, in the words of the guide's own headings. */
export const GROUP_PHRASES: Record<SetupGroup, StaffPhrase> = {
  identity: "gd.group.identity",
  resources: "gd.group.resources",
  pricing: "gd.group.pricing",
  policies: "gd.group.policies",
  people: "gd.group.people",
  payments: "gd.group.payments",
  programmes: "gd.group.programmes",
  launch: "gd.group.launch",
};
