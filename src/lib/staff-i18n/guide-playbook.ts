// Staff dashboard phrases for the venue guide's operating playbook (the
// playbook view of components/admin/guide/GuideTab.tsx;
// docs/features/venue-guide.md): English, and the same keys in Malay and
// Chinese (lib/staff-i18n/index.ts). Prefix `gp.`. This file is the
// playbook's alone: its modules' text goes here. What the guide's shell,
// refusals, readiness and log entries say is in guide.ts (`gd.`).

const en = {
  "gp.heading": "How to run your venue",
};

const ms: Record<keyof typeof en, string> = {
  "gp.heading": "Cara mengendalikan pusat anda",
};

const zh: Record<keyof typeof en, string> = {
  "gp.heading": "如何运营您的场馆",
};

const area = { en, ms, zh };
export default area;
