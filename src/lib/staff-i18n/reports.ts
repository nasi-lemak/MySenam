// Staff dashboard phrases for this area: English, and the same keys in Malay
// and Chinese (lib/staff-i18n/index.ts). Keys start with the area's prefix.

const en = {} satisfies Record<string, string>;

const ms: Record<keyof typeof en, string> = {};

const zh: Record<keyof typeof en, string> = {};

const area = { en, ms, zh };
export default area;
