/**
 * MySenam's pictures: one small line drawing per activity, kind of business,
 * category, and a generic set for operators' own activities
 * (docs/development/images.md, the standard every entry keeps).
 *
 * Each glyph is the inside of an SVG drawn on a 24-unit grid with 2 units of
 * padding: lines in `currentColor` 1.75 wide with round caps and joins, filled
 * shapes only in `currentColor`. Only `path`, `circle`, `ellipse`, `rect`,
 * `line` and `polyline` elements, each closed with `/>`, and only their
 * geometry plus `fill="currentColor"` (and `stroke="none"` on a filled dot):
 * no colours, text, styles, scripts or links. `parseGlyph` refuses anything
 * else, and tests/glyphs.test.ts checks every entry against the rules.
 *
 * Every glyph here is MySenam's own drawing; none is taken from an icon set.
 * A designer replaces one by editing its entry (or exporting them all with
 * `npm run glyphs:export -- <folder>`, editing, and pasting the elements back).
 *
 * Browser-safe: data and two pure functions.
 */

export const GLYPH_VIEWBOX = "0 0 24 24";
export const GLYPH_STROKE_WIDTH = 1.75;

/** Waves along a line: `wave(y)` from x 3 to 21. */
const WAVE = (y: number) => `M3 ${y}q1.5 1.2 3 0t3 0 3 0 3 0 3 0 3 0`;

export const GLYPHS = {
  // ------------------------------------------------------------ activities
  "activity/badminton":
    '<path d="M8.5 16.5h7v1a3.5 3.5 0 0 1-7 0z" fill="currentColor"/><path d="M9 16.5 5.5 4.5Q12 2.5 18.5 4.5L15 16.5"/><path d="M10.8 16.5 10.1 3.7M13.2 16.5l.7-12.8M7.3 10.5h9.4"/>',
  "activity/tennis":
    '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6c3.3 3.3 3.3 9.5 0 12.8M18.4 5.6c-3.3 3.3-3.3 9.5 0 12.8"/>',
  "activity/pickleball":
    '<rect x="2.5" y="2.5" width="10" height="11.5" rx="3.5"/><path d="M6 14v6a1.5 1.5 0 0 0 3 0v-6"/><circle cx="17.5" cy="17.5" r="4"/><circle cx="16.3" cy="16.3" r="0.85" fill="currentColor" stroke="none"/><circle cx="18.7" cy="16.3" r="0.85" fill="currentColor" stroke="none"/><circle cx="16.3" cy="18.7" r="0.85" fill="currentColor" stroke="none"/><circle cx="18.7" cy="18.7" r="0.85" fill="currentColor" stroke="none"/>',
  "activity/padel":
    '<path d="M12 2.5c3.3 0 6 2.6 6 6.3 0 3.4-2.3 5.7-4.5 6.7h-3C8.3 14.5 6 12.2 6 8.8 6 5.1 8.7 2.5 12 2.5z"/><path d="M10.5 15.5V19a1.5 1.5 0 0 0 3 0v-3.5"/><circle cx="10" cy="6.8" r=".9" fill="currentColor" stroke="none"/><circle cx="14" cy="6.8" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="9" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="11.2" r=".9" fill="currentColor" stroke="none"/><circle cx="14" cy="11.2" r=".9" fill="currentColor" stroke="none"/><path d="M2.5 14v7.5h4M21.5 14v7.5h-4"/>',
  "activity/squash":
    '<ellipse cx="10" cy="8" rx="5" ry="5.5"/><path d="M7.5 6.5h5M7.5 9.5h5M8.5 3.5v9M11.5 3.5v9"/><path d="M8.5 13 10 15.5l1.5-2.5M10 15.5v6"/><circle cx="18.5" cy="18.5" r="2" fill="currentColor"/>',
  "activity/table_tennis":
    '<circle cx="9.5" cy="9.5" r="6.5" fill="currentColor"/><path d="M14.2 12.8l5.4 5.4a1.4 1.4 0 0 1-2 2l-5.4-5.4"/><circle cx="19" cy="5" r="2.2"/>',
  "activity/futsal":
    '<circle cx="12" cy="12" r="9"/><path d="M12 8.6l3.2 2.3-1.2 3.8h-4l-1.2-3.8z" fill="currentColor"/><path d="M12 8.6V3M15.2 10.9l5.4-1.7M14 14.7l3.3 4.6M10 14.7l-3.3 4.6M8.8 10.9 3.4 9.2"/>',
  "activity/football":
    '<rect x="2.5" y="5" width="19" height="14" rx="1"/><path d="M12 5v14M2.5 9h3v6h-3M21.5 9h-3v6h3"/><circle cx="12" cy="12" r="2.5"/>',
  "activity/basketball":
    '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.7 5.6C7.8 7.3 9 9.5 9 12s-1.2 4.7-3.3 6.4M18.3 5.6C16.2 7.3 15 9.5 15 12s1.2 4.7 3.3 6.4"/>',
  "activity/volleyball":
    '<circle cx="12" cy="12" r="9"/><path d="M12 12c0-3.6-1.4-6.6-3.9-8.6M12 12c3.1 1.8 6.4 2.2 9.2 1.2M12 12c-3.1 1.8-5 4.6-5.6 7.6"/><path d="M15.6 3.8c1 3.6.4 7-1.6 9.6M20.4 16c-3.4.4-6.6-.6-9-2.7M4.1 16.3c.5-3.4 2.4-6.2 5.3-7.9"/>',
  "activity/netball":
    '<path d="M5 21.5V3M2.5 21.5h5M5 5h4.5"/><ellipse cx="14" cy="5" rx="4.5" ry="1.5"/><path d="M10 5.8l1.3 5.7h5.4L18 5.8M12.6 6.5l.4 5M15.4 6.5l-.4 5"/><circle cx="15.5" cy="17.5" r="3.5"/>',
  "activity/floorball":
    '<path d="M17.5 2.5 9.2 17.7a3 3 0 0 1-2.6 1.6H2.5M2.5 21.5h4.9a4.5 4.5 0 0 0 3.6-1.8"/><circle cx="17.5" cy="17" r="4"/><circle cx="16.3" cy="15.8" r="0.85" fill="currentColor" stroke="none"/><circle cx="18.7" cy="15.8" r="0.85" fill="currentColor" stroke="none"/><circle cx="16.3" cy="18.2" r="0.85" fill="currentColor" stroke="none"/><circle cx="18.7" cy="18.2" r="0.85" fill="currentColor" stroke="none"/>',
  "activity/sepak_takraw":
    '<circle cx="12" cy="12" r="9"/><path d="M3 12c3-2.2 15-2.2 18 0M3 12c3 2.2 15 2.2 18 0M7.5 4.2c3.6.6 11.1 10.6 9 15.6M16.5 4.2c-3.6.6-11.1 10.6-9 15.6"/>',
  "activity/cricket":
    '<path d="M13.2 6.6l4.2 4.2-9.3 9.3a2.4 2.4 0 0 1-3.4 0l-.8-.8a2.4 2.4 0 0 1 0-3.4z"/><path d="M15.3 8.7l4.2-4.2"/><circle cx="18" cy="17.5" r="3"/><path d="M15.9 15.4l4.2 4.2"/>',
  "activity/swimming":
    '<circle cx="17.5" cy="7" r="2"/><path d="M3.5 13.5l5-4.5 3.5 2.5 3-1.5M12 11.5l-2.5 3"/>' + `<path d="${WAVE(17.5)}"/>`,
  "activity/water_polo":
    '<circle cx="12" cy="9" r="6.5"/><path d="M5.5 9h13M12 2.5c-2 1.8-3 4-3 6.5s1 4.7 3 6.5M12 2.5c2 1.8 3 4 3 6.5s-1 4.7-3 6.5"/>' + `<path d="${WAVE(19.5)}"/>`,
  "activity/kayak":
    '<path d="M2.5 12.5C6 10 18 10 21.5 12.5 18 15 6 15 2.5 12.5z"/><ellipse cx="12" cy="12.5" rx="2.5" ry="1"/><path d="M5 19 19 5"/><path d="M18.2 5 19.6 2.6l1.8 1.8L19 5.8zM5.8 19l-1.4 2.4-1.8-1.8L5 18.2z" fill="currentColor"/>',
  "activity/canoe":
    '<path d="M2.5 12.5h19c-1.4 3.8-5 6-9.5 6s-8.1-2.2-9.5-6z"/><path d="M15 2.5 10.5 16"/><path d="M10.8 15.1 9.4 19.5a1.2 1.2 0 0 1-2.3-.8l1.5-4.3z" fill="currentColor"/><path d="M13.5 2.5h3"/>' + `<path d="M3 21.5h18"/>`,
  "activity/paddleboard":
    '<path d="M2.5 19.5h19M4 21.5h16"/><circle cx="9" cy="4.5" r="1.8"/><path d="M9 7v6.5l-2 5M9 13.5l2 5M9 9.5l5-1.5"/><path d="M14.5 3l2.5 13"/><path d="M16.4 13.2l1.6 5.3a.9.9 0 0 1-1.7.4l-.9-5.4z" fill="currentColor"/>',
  "activity/gym":
    '<rect x="4.5" y="6.5" width="3.5" height="11" rx="1"/><rect x="16" y="6.5" width="3.5" height="11" rx="1"/><path d="M8 12h8M2.5 9.5v5M21.5 9.5v5"/>',
  "activity/cycling":
    '<circle cx="6" cy="16" r="4"/><circle cx="18" cy="16" r="4"/><path d="M6 16h5.5L15.5 9 18 16M11.5 16 9 8.5M6 16l3-7.5H15.5M7.5 8.5h3M15.5 9l-.7-2.5H17"/>',
  "activity/yoga":
    '<circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v7M12 9.5c-2.2.4-4 2-5 4.5M12 9.5c2.2.4 4 2 5 4.5"/><path d="M3.5 19c2.8-2.6 5.6-3.8 8.5-3.8s5.7 1.2 8.5 3.8M6 21h12"/>',
  "activity/pilates":
    '<circle cx="5" cy="8.5" r="1.8"/><path d="M6.5 11l4 6 9-6M7.5 12.5l7-3.5"/><rect x="2.5" y="19" width="19" height="2.5" rx="1"/>',
  "activity/dance":
    '<circle cx="14" cy="4" r="1.8"/><path d="M13.5 6.5 11.5 13M7.5 4.5l5 3.5 5-2M8.5 15.5l3-2.5 3.5 2.5zM10.2 15.5 8 21M13.5 15.5l3.5 5"/>',
  "activity/martial_arts":
    '<path d="M2.5 9.5h19v3h-19z"/><path d="M12 7.5l2.5 3.5-2.5 3.5-2.5-3.5z" fill="currentColor"/><path d="M10.8 13.5l-3 7 2.4 1 2.6-6.5M13.2 13.5l3 7-2.4 1-2.6-6.5"/>',
  "activity/boxing":
    '<path d="M7 16.5V8.5a6 6 0 0 1 6-6h.5A5.5 5.5 0 0 1 19 8v5c0 1.6-.8 2.7-2 3.5"/><path d="M7 12H5.8a2.8 2.8 0 0 1 0-5.5H7M7 12c2.6 0 4.2-1 5-3"/><rect x="7" y="16.5" width="10" height="5" rx="1"/>',
  "activity/climbing":
    '<path d="M10.5 2.5h4a3.5 3.5 0 0 1 3.5 3.5v9.5a6 6 0 0 1-12 0V7a4.5 4.5 0 0 1 4.5-4.5z"/><path d="M9.5 6.5v9"/><path d="M14 21.5c0-3 2.5-4.5 2.5-7.5S14 9.5 14 6.5"/>',
  "activity/bouldering":
    '<path d="M2.5 20.5 5 11.5l5-6.5 5.5 2 3.5 5 1.5 8.5z"/><circle cx="9" cy="11" r="1.2" fill="currentColor"/><circle cx="13.5" cy="9.5" r="1.2" fill="currentColor"/><circle cx="15" cy="14.5" r="1.2" fill="currentColor"/><circle cx="8" cy="16.5" r="1.2" fill="currentColor"/>',
  "activity/archery":
    '<circle cx="10" cy="14" r="7.5"/><circle cx="10" cy="14" r="3.5"/><circle cx="10" cy="14" r=".8" fill="currentColor"/><path d="M10 14 20 4M17 4v3h3M19 2.5v2.5h2.5"/>',
  "activity/golf_simulator":
    '<rect x="2.5" y="3" width="19" height="13" rx="1.5"/><path d="M11 13.5v-8l4.5 2-4.5 2M7.5 13.5h9M8.5 21.5h7"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
  "activity/bowling":
    '<path d="M8 2.5c1.2 0 2 .9 2 2.1 0 1.2-.8 2-.8 3.1 0 1.6 2.3 3.6 2.3 7.4 0 2.8-.9 5.2-1.3 6.4H5.8c-.4-1.2-1.3-3.6-1.3-6.4 0-3.8 2.3-5.8 2.3-7.4 0-1.1-.8-1.9-.8-3.1 0-1.2.8-2.1 2-2.1zM6.9 8.5h2.2"/><circle cx="16.5" cy="16" r="5"/><circle cx="15.3" cy="13.6" r=".9" fill="currentColor" stroke="none"/><circle cx="17.9" cy="14" r=".9" fill="currentColor" stroke="none"/><circle cx="16.2" cy="16.3" r=".9" fill="currentColor" stroke="none"/>',
  "activity/fencing":
    '<path d="M8 16 20.5 3.5M16 16 3.5 3.5M7.5 16.5 4 20M16.5 16.5 20 20"/><path d="M4.8 13.2a4.5 4.5 0 0 0 6 6zM19.2 13.2a4.5 4.5 0 0 1-6 6z" fill="currentColor"/>',

  // ------------------------------------------------------- kinds of business
  "business/badminton-and-pickleball":
    '<path d="M5.5 15h5v.8a2.5 2.5 0 0 1-5 0z" fill="currentColor"/><path d="M5.8 15 3 4.5Q8 3 13 4.5L10.2 15M7.2 15l-.6-11M8.8 15l.6-11"/><circle cx="17" cy="16.5" r="4.5"/><circle cx="15.7" cy="15.2" r="0.9" fill="currentColor" stroke="none"/><circle cx="18.3" cy="15.2" r="0.9" fill="currentColor" stroke="none"/><circle cx="15.7" cy="17.8" r="0.9" fill="currentColor" stroke="none"/><circle cx="18.3" cy="17.8" r="0.9" fill="currentColor" stroke="none"/>',
  "business/futsal-and-football":
    '<path d="M2.5 17V4.5h19V17M2.5 8.5h19M7 4.5v8M12 4.5v4M17 4.5v8"/><circle cx="12" cy="16.5" r="4.5"/><path d="M12 14.5l1.9 1.4-.7 2.2h-2.4l-.7-2.2z" fill="currentColor"/>',
  "business/tennis-and-padel":
    '<circle cx="7.5" cy="16" r="5"/><path d="M4 12.5c1.9 1.9 1.9 5.1 0 7M11 12.5c-1.9 1.9-1.9 5.1 0 7"/><path d="M15.5 2.5c2.8 0 5 2.2 5 5.2 0 2.8-1.9 4.8-3.8 5.6h-2.4c-1.9-.8-3.8-2.8-3.8-5.6 0-3 2.2-5.2 5-5.2z"/><path d="M14.3 14.3v4.2a1.2 1.2 0 0 0 2.4 0v-4.2"/><circle cx="14" cy="6" r=".75" fill="currentColor" stroke="none"/><circle cx="17" cy="6" r=".75" fill="currentColor" stroke="none"/><circle cx="15.5" cy="7.9" r=".75" fill="currentColor" stroke="none"/><circle cx="14" cy="9.8" r=".75" fill="currentColor" stroke="none"/><circle cx="17" cy="9.8" r=".75" fill="currentColor" stroke="none"/>',
  "business/multi-sport":
    '<circle cx="7" cy="7.5" r="4.5"/><path d="M7 3v9M2.5 7.5h9"/><circle cx="17" cy="7.5" r="4.5"/><path d="M13.8 4.3c1.6 1.8 1.6 4.6 0 6.4M20.2 4.3c-1.6 1.8-1.6 4.6 0 6.4"/><circle cx="12" cy="16.5" r="4.5"/><path d="M12 14.5l1.9 1.4-.7 2.2h-2.4l-.7-2.2z" fill="currentColor"/>',
  "business/gym-and-fitness":
    '<path d="M2.5 12h19"/><rect x="4.5" y="6" width="2.5" height="12" rx=".8"/><rect x="7.5" y="8" width="2" height="8" rx=".6"/><rect x="17" y="6" width="2.5" height="12" rx=".8"/><rect x="14.5" y="8" width="2" height="8" rx=".6"/>',
  "business/swimming":
    '<path d="M8 15V5.5a2.5 2.5 0 0 1 5 0M14 15V5.5a2.5 2.5 0 0 1 5 0M8 8.5h6M8 12h6"/>' + `<path d="${WAVE(17)}"/><path d="${WAVE(20.5)}"/>`,
  "business/climbing-and-bouldering":
    '<path d="M3 21.5h18M5 21.5V2.5h7.5l-2 6.5 5.5 5-2 7.5"/><path d="M7.5 6l1.8-1 .2 2zM8 12.5l2 .5-1.5 1.5zM10.5 17.5l1.8.2-1 1.6z" fill="currentColor"/><circle cx="19" cy="6" r="1.8"/><path d="M19 8v4.5l-2 2M19 10l-2.5-1.5M19 12.5l1.5 3"/>',
  "business/coaching-academy":
    '<rect x="4" y="4" width="16" height="17.5" rx="1.5"/><path d="M9 4V2.5h6V4"/><path d="M7.5 8.5l2.5 2.5M10 8.5 7.5 11"/><circle cx="15.5" cy="16.5" r="1.8"/><path d="M9 14c1 2.5 2.5 3.3 4 2.8M11.8 15.6l1.4 1.2-1.7.6"/>',
  "business/equipment-rental":
    '<path d="M2.5 11.5V4a1.5 1.5 0 0 1 1.5-1.5h7.5l10 10-9 9z"/><circle cx="7" cy="7" r="1.5"/><path d="M16 13.5a3 3 0 1 1-1-2.2M15.2 9.8l-.2 1.5 1.5.2"/>',
  "business/archery-and-supervised":
    '<path d="M12 2.5l7.5 3v6c0 4.8-3.2 8.4-7.5 10-4.3-1.6-7.5-5.2-7.5-10v-6z"/><circle cx="12" cy="11.5" r="3.8"/><circle cx="12" cy="11.5" r="1" fill="currentColor"/>',
  "business/club-and-community":
    '<circle cx="12" cy="7" r="2.8"/><circle cx="5.5" cy="9" r="2"/><circle cx="18.5" cy="9" r="2"/><path d="M6.5 20.5v-1a5.5 5.5 0 0 1 11 0v1M2.5 18v-.8a3.5 3.5 0 0 1 4.6-3.3M21.5 18v-.8a3.5 3.5 0 0 0-4.6-3.3"/>',
  "business/school-and-corporate":
    '<path d="M3 9.5 12 3.5l9 6zM3 21.5h18M6 12.5v6M10 12.5v6M14 12.5v6M18 12.5v6"/>',
  "business/mixed":
    '<circle cx="7.5" cy="7.5" r="4.5"/><path d="M16.5 3 21 11h-9z"/><rect x="8.5" y="13.5" width="8" height="8" rx="1.5"/>',

  // ------------------------------------------------------------ categories
  "category/racket":
    '<path d="M11 2.5c3.3 0 5.5 2.7 5.5 5.8 0 3.2-2.4 5.7-5.5 5.7S5.5 11.5 5.5 8.3c0-3.1 2.2-5.8 5.5-5.8z"/><path d="M8 6h6M7.6 9.5h6.8M9 3.6v9.4M13 3.6v9.4M11 14v7.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  "category/team":
    '<path d="M8.5 3 5 4.5 2.5 9l3 2 1.5-1.5V21h10V9.5l1.5 1.5 3-2L19 4.5 15.5 3c-.5 1.5-2 2.5-3.5 2.5S9 4.5 8.5 3z"/>',
  "category/aquatic":
    '<path d="M12 2.5c3.5 4.5 6 8 6 11.5a6 6 0 0 1-12 0c0-3.5 2.5-7 6-11.5z"/><path d="M9 14a3 3 0 0 0 3 3"/>',
  "category/water": '<path d="M12 2.5V11M10.5 2.5h3M12 11c1.6 0 2.5 1.6 2.5 3.6S13.6 18 12 18.5c-1.6-.5-2.5-1.9-2.5-3.9S10.4 11 12 11z"/>' + `<path d="${WAVE(20.5)}"/>`,
  "category/fitness":
    '<path d="M12 20s-8.5-4.8-8.5-11A4.5 4.5 0 0 1 12 6.6 4.5 4.5 0 0 1 20.5 9c0 6.2-8.5 11-8.5 11z"/><path d="M5 12.5h3.5l1.5-2.5 2.5 5 1.5-2.5H19"/>',
  "category/studio":
    '<path d="M12 19.5c-3-2-4.5-5-4.5-8.5 0-2 .7-4 4.5-6.5 3.8 2.5 4.5 4.5 4.5 6.5 0 3.5-1.5 6.5-4.5 8.5z"/><path d="M12 19.5c-4.2 0-7.6-2.5-9.5-6.5 2-.4 3.6-.2 4.8.5M12 19.5c4.2 0 7.6-2.5 9.5-6.5-2-.4-3.6-.2-4.8.5"/>',
  "category/specialist":
    '<path d="M12 2.5l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.4l-5.6 3.1 1.3-6.2L3 9l6.3-.7z"/>',

  // ------------------------------------- features (the /play page's cards)
  "feature/games":
    '<circle cx="6" cy="4.8" r="2.2"/><circle cx="18" cy="4.8" r="2.2"/><path d="M2.5 12v-.5a3.5 3.5 0 0 1 7 0v.5M14.5 12v-.5a3.5 3.5 0 0 1 7 0v.5"/><circle cx="12" cy="18" r="3.5"/><path d="M12 16.6l1.4 1-.5 1.6h-1.8l-.5-1.6z" fill="currentColor"/>',
  "feature/tournaments":
    '<path d="M7 3h10v5.5a5 5 0 0 1-10 0z"/><path d="M7 5H4.5a3 3 0 0 0 3 4.5M17 5h2.5a3 3 0 0 1-3 4.5M12 13.5V17M8.5 21.5h7M9.5 17h5l.5 4.5h-6z"/>',
  "feature/leagues":
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/><circle cx="6" cy="6" r="1" fill="currentColor"/><path d="M12 6h6M12 12h4M12 18h2"/>',

  // ----------------------------------------- generic, for operators' own
  "generic/ball": '<circle cx="12" cy="12" r="9"/><path d="M3.3 9.7c4.3 2.3 13.1 2.3 17.4 0M5.6 18.3c3-3.2 9.8-3.2 12.8 0"/>',
  "generic/racket":
    '<path d="M9.9 14.1A6.5 5 -45 1 1 19.1 4.9 6.5 5 -45 1 1 9.9 14.1z"/><path d="M12.5 7.5l4.5 4.5M14.5 5.5 19 10M9.9 14.1 3.5 20.5"/>',
  "generic/goal": '<path d="M2.5 19.5V5h19v14.5M2.5 9.5h19M2.5 14h19M7.25 5v14.5M12 5v14.5M16.75 5v14.5"/>',
  "generic/wave": `<path d="${WAVE(7)}"/><path d="${WAVE(12)}"/><path d="${WAVE(17)}"/>`,
  "generic/weights": '<path d="M8.5 10 8 6.6A2.2 2.2 0 0 1 10.2 4h3.6A2.2 2.2 0 0 1 16 6.6L15.5 10"/><path d="M12 9a6 6 0 0 1 6 6c0 2.4-.7 4.6-1.6 6.5H7.6C6.7 19.6 6 17.4 6 15a6 6 0 0 1 6-6z"/>',
  "generic/mat": '<circle cx="7" cy="14.5" r="4.5"/><circle cx="7" cy="14.5" r="1.5"/><path d="M7 19h14.5v-2.5H11"/>',
  "generic/target": '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  "generic/wheel":
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v7M12 14v7M4.2 7.5l6.1 3.5M13.7 13l6.1 3.5M4.2 16.5l6.1-3.5M13.7 11l6.1-3.5"/>',
  "generic/mountain": '<path d="M2.5 19.5 9 8l3.5 6 2.5-4 6.5 9.5z"/><path d="M6.8 11.9 9 13l2-1.5"/>',
  "generic/whistle": '<circle cx="9" cy="14.5" r="5.5"/><path d="M9 9h12.5v4.5H14"/><circle cx="9" cy="14.5" r="1.5" fill="currentColor"/><path d="M5 9.5 3 7"/>',
  "generic/stopwatch": '<circle cx="12" cy="13.5" r="7.5"/><path d="M10 2.5h4M12 2.5V6M12 13.5V9.5M18 6.5l1.5-1.5"/>',
  "generic/court": '<rect x="4.5" y="2.5" width="15" height="19" rx=".5"/><path d="M2.5 12h19M4.5 7h15M4.5 17h15M12 7v10"/>',
} as const satisfies Record<string, string>;

export type GlyphName = keyof typeof GLYPHS;

/** The generic set an operator's own activity may use, besides any built-in activity's glyph. */
export const GENERIC_GLYPHS = [
  "generic/ball",
  "generic/racket",
  "generic/goal",
  "generic/wave",
  "generic/weights",
  "generic/mat",
  "generic/target",
  "generic/wheel",
  "generic/mountain",
  "generic/whistle",
  "generic/stopwatch",
  "generic/court",
] as const satisfies readonly GlyphName[];

/** Is this one of the glyphs here (not a legacy emoji, not a guess)? */
export function isGlyphName(v: unknown): v is GlyphName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(GLYPHS, v);
}

/** What an activity may be drawn with: the generic set, any activity's own, or a category's (the default). */
export function isActivityGlyph(v: unknown): v is GlyphName {
  return isGlyphName(v) && (v.startsWith("generic/") || v.startsWith("activity/") || v.startsWith("category/"));
}

// ------------------------------------------------------------ tones

/** Tile tones: one per category, one shared by business types that fit none. Tokens in src/app/globals.css. */
export const GLYPH_TONES = ["racket", "team", "aquatic", "water", "fitness", "studio", "specialist", "neutral"] as const;
export type GlyphTone = (typeof GLYPH_TONES)[number];

/** The tone each kind of business is shown in (a business type id to a tone). */
export const BUSINESS_TONES: Record<string, GlyphTone> = {
  "badminton-and-pickleball": "racket",
  "futsal-and-football": "team",
  "tennis-and-padel": "racket",
  "multi-sport": "team",
  "gym-and-fitness": "fitness",
  swimming: "aquatic",
  "climbing-and-bouldering": "specialist",
  "coaching-academy": "studio",
  "equipment-rental": "water",
  "archery-and-supervised": "specialist",
  "club-and-community": "team",
  "school-and-corporate": "neutral",
  mixed: "neutral",
};

// ------------------------------------------------------------ reading them

/** One element of a glyph: its tag and its attributes, as written. */
export type GlyphShape = { tag: GlyphTag; attrs: Record<string, string> };

export const GLYPH_TAGS = ["path", "circle", "ellipse", "rect", "line", "polyline"] as const;
export type GlyphTag = (typeof GLYPH_TAGS)[number];

/** The attributes each element may carry: its geometry, and the two paint values the standard allows. */
export const GLYPH_ATTRIBUTES: Record<GlyphTag, readonly string[]> = {
  path: ["d", "fill", "stroke"],
  circle: ["cx", "cy", "r", "fill", "stroke"],
  ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke"],
  rect: ["x", "y", "width", "height", "rx", "fill", "stroke"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points", "fill", "stroke"],
};

const ELEMENT = /<([a-z]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*\/>/gy;
const ATTRIBUTE = /\s+([a-z-]+)="([^"<>]*)"/g;
const GEOMETRY = /^[-+0-9.eE ,MmLlHhVvCcSsQqTtAaZz]*$/;

/**
 * A glyph's markup read into elements, refusing anything the standard does
 * not allow (an unknown element or attribute, a colour, a self-made paint, an
 * unclosed tag, text between elements). Throws: a glyph is code, written
 * once, and a wrong one is caught by the tests, never shown.
 */
export function parseGlyph(markup: string): GlyphShape[] {
  const shapes: GlyphShape[] = [];
  let at = 0;
  while (at < markup.length) {
    // Line breaks and spaces between elements are allowed (a pasted file has them); nothing else is.
    while (/\s/.test(markup[at] ?? "")) at++;
    if (at >= markup.length) break;
    ELEMENT.lastIndex = at;
    const m = ELEMENT.exec(markup);
    if (!m) throw new Error(`Not a glyph element at ${at}: ${markup.slice(at, at + 30)}`);
    const tag = m[1] as GlyphTag;
    if (!(GLYPH_TAGS as readonly string[]).includes(tag)) throw new Error(`Element <${tag}> is not allowed in a glyph.`);
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(ATTRIBUTE)) {
      const [, name, value] = a;
      if (!GLYPH_ATTRIBUTES[tag].includes(name)) throw new Error(`Attribute ${name} is not allowed on <${tag}>.`);
      if (name in attrs) throw new Error(`Attribute ${name} is given twice.`);
      if (name === "fill" && value !== "currentColor" && value !== "none") throw new Error(`fill="${value}": only currentColor or none.`);
      if (name === "stroke" && value !== "none") throw new Error(`stroke="${value}": only none, on a filled shape.`);
      if (name !== "fill" && name !== "stroke" && !GEOMETRY.test(value)) throw new Error(`${name}="${value}" is not geometry.`);
      attrs[name] = value;
    }
    if (attrs.stroke === "none" && attrs.fill !== "currentColor") throw new Error('stroke="none" only on a shape filled with currentColor.');
    shapes.push({ tag, attrs });
    at = ELEMENT.lastIndex;
  }
  return shapes;
}

const parsed = new Map<string, GlyphShape[]>();

/** A glyph's elements, or null for a name that is not a glyph. */
export function glyphShapes(name: string): GlyphShape[] | null {
  if (!isGlyphName(name)) return null;
  let shapes = parsed.get(name);
  if (!shapes) {
    shapes = parseGlyph(GLYPHS[name]);
    parsed.set(name, shapes);
  }
  return shapes;
}

/** The root attributes every glyph is drawn with: the standard, in one place. */
export const GLYPH_ROOT = {
  viewBox: GLYPH_VIEWBOX,
  fill: "none",
  stroke: "currentColor",
  "stroke-width": String(GLYPH_STROKE_WIDTH),
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

/** A glyph as a standalone SVG file (for export and for the tests). */
export function glyphSvg(name: GlyphName, size = 24): string {
  const root = Object.entries(GLYPH_ROOT)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ${root}>${GLYPHS[name]}</svg>`;
}
