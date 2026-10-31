// Staff dashboard phrases for contextual help and the discovery view of the
// venue guide (docs/features/venue-guide.md): English, and the same keys in
// Malay and Chinese (lib/staff-i18n/index.ts). Prefix `gh.`. This file is
// contextual help's alone: its explanations and the discovery view's own
// text go here. What the guide's shell, refusals, readiness, discoveries'
// reasons and log entries say is in guide.ts (`gd.`).

const en = {
  "gh.discoverHeading": "Discover what else MySenam can do",
};

const ms: Record<keyof typeof en, string> = {
  "gh.discoverHeading": "Terokai apa lagi yang MySenam boleh lakukan",
};

const zh: Record<keyof typeof en, string> = {
  "gh.discoverHeading": "发现 MySenam 还能做什么",
};

const area = { en, ms, zh };
export default area;
