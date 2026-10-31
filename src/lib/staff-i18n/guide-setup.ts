// Staff dashboard phrases for the venue guide's setup journey (the setup
// view of components/admin/guide/GuideTab.tsx; docs/features/venue-guide.md):
// English, and the same keys in Malay and Chinese (lib/staff-i18n/index.ts).
// Prefix `gs.`. This file is the setup journey's alone: its steps' own text,
// its questions and its explanations go here. What the guide's shell,
// refusals, readiness and log entries say is in guide.ts (`gd.`).

const en = {
  "gs.heading": "Set up your venue",
};

const ms: Record<keyof typeof en, string> = {
  "gs.heading": "Sediakan pusat anda",
};

const zh: Record<keyof typeof en, string> = {
  "gs.heading": "设置您的场馆",
};

const area = { en, ms, zh };
export default area;
