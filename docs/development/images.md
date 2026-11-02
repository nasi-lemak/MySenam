# Images: the glyph standard

Authoritative for MySenam's own pictures: the line drawings (glyphs) shown
beside an activity, a kind of business or a category, how they are drawn,
where they are used and how a designer replaces one. Which picture an
activity has, and how an operator chooses one for their own, is
[activities](../features/activities.md#pictures). Venue photos are not glyphs
([discovery](../features/discovery.md)).

Every glyph is MySenam's own drawing, made for this standard. None is taken
or adapted from an icon set, so there is no licence to track. They were drawn
in-house, not by a designer, and are meant to be replaced by better ones that
keep the same rules.

## The standard

A glyph is the inside of an SVG drawn on a 24-unit grid:

- `viewBox="0 0 24 24"`, with 2 units of padding: all geometry lies between 2
  and 22 on both axes.
- Lines, not shapes: drawn with `stroke="currentColor"`, `stroke-width`
  1.75, round caps and joins, `fill="none"`. These are set once on the root
  (`GLYPH_ROOT` in `src/lib/icons/glyphs.ts`); a glyph does not repeat them.
- A filled shape only as `fill="currentColor"`; a small dot (the holes in a
  pickleball) may add `stroke="none"`. No other colour, no gradient, filter,
  opacity, transform, `<style>`, script, text, link, `href`, image or raster.
- Only `path`, `circle`, `ellipse`, `rect`, `line` and `polyline`, each closed
  with `/>`, carrying only their geometry and those two paints. `parseGlyph`
  refuses anything else, so a glyph that breaks a rule fails its test rather
  than reaching a page.
- At most 700 characters of markup per glyph.
- One idea per glyph, recognisable at 20 pixels, the object everyone knows
  for the activity: a shuttlecock for badminton, a paddle and holed ball for
  pickleball, a perforated padel racket between glass walls, a squash racket
  and its small dark ball, a solid table-tennis bat (so it is not read as a
  search magnifier).

Because the colour is `currentColor`, a glyph takes the colour of the text
around it: slate in a list, white on a selected chip, the tile's ink in a
tile.

## Tiles

The larger form, for selection cards and kinds of business, is the same glyph
centred in a rounded square (`GlyphTile`; the glyph at 60% of the tile, the
corner a quarter of its side). Its tone is a design token in
`src/app/globals.css`, one per category and a neutral one:

| Tone | Ground | Ink | Used for |
| ---- | ------ | --- | -------- |
| `racket` | `--color-tile-racket` | `--color-tile-racket-ink` | Racket sports; badminton and pickleball, tennis and padel businesses |
| `team` | `--color-tile-team` | `--color-tile-team-ink` | Team sports; futsal and football, multi-sport, club and community |
| `aquatic` | `--color-tile-aquatic` | `--color-tile-aquatic-ink` | In the pool; swimming facilities |
| `water` | `--color-tile-water` | `--color-tile-water-ink` | On the water; equipment rental |
| `fitness` | `--color-tile-fitness` | `--color-tile-fitness-ink` | Fitness; gyms |
| `studio` | `--color-tile-studio` | `--color-tile-studio-ink` | Classes and studios; coaching academies |
| `specialist` | `--color-tile-specialist` | `--color-tile-specialist-ink` | Specialist; climbing, archery and supervised activities |
| `neutral` | `--color-tile-neutral` | `--color-tile-neutral-ink` | Schools and companies, mixed venues, anything unknown |

Tailwind makes them `bg-tile-<tone>` and `text-tile-<tone>-ink`. Every ink is
at least 4.5:1 on its ground (the tests compute it). A business type's tone is
`BUSINESS_TONES`; an activity's is its category. Colour is never the only
signal: the name is always shown beside the tile.

## Accessibility

- A glyph beside its visible name is decorative: `aria-hidden="true"`,
  `focusable="false"`. This is the default.
- A glyph that stands alone (a pass's activity in the credit tab, where only
  the picture is shown) is given `label`, and is then `role="img"` with that
  accessible name.
- A choice made with pictures is still a form control: the setup journey's
  kinds of business and activities are checkboxes, the public guide's are
  checkboxes in their labels, and the picture picker is a group of radio
  buttons (one name, so the arrow keys move through it) with each picture's
  name under it.
- `<option>` elements cannot hold a picture: a drop-down list names
  activities in words only.

## Files and names

Glyphs are data, not files, so nothing is loaded at run time and nothing new
is installed:

| What | Where |
| ---- | ----- |
| Every glyph, by name; the tones of business types; `parseGlyph`, `glyphSvg` | `src/lib/icons/glyphs.ts` |
| `Glyph` (one glyph, inline), `GlyphTile` (in a tile), `ActivityGlyph` and `ActivityTile` (an activity's picture, a legacy emoji included) | `src/components/Glyph.tsx` |
| The tile tokens | `src/app/globals.css` |
| Writing them out as `.svg` files | `scripts/export-glyphs.mjs` |
| The checks | `tests/glyphs.test.ts`, `tests/components/glyphs-ui.test.tsx`, `tests/activity-pictures.test.ts` |

A name is a set and a slug:

| Set | Names | For |
| --- | ----- | --- |
| `activity/` | One per built-in activity, named by its key (`activity/sepak_takraw`): 32 | The catalogue's `icon` |
| `business/` | One per kind of business, by its id (`business/coaching-academy`): 13 | The setup journey and the public guide |
| `category/` | `racket`, `team`, `aquatic`, `water`, `fitness`, `studio`, `specialist` | An operator's own activity with no picture chosen |
| `generic/` | `ball`, `racket`, `goal`, `wave`, `weights`, `mat`, `target`, `wheel`, `mountain`, `whistle`, `stopwatch`, `court` | Operators' own activities |
| `feature/` | `games`, `tournaments`, `leagues` | The cards of the play page |

A new built-in activity, kind of business or category needs its glyph: the
tests fail without it.

## Where pictures are used

- **Setup journey** (dashboard): the kinds of business and the activities as
  tiles beside their names, still checkboxes.
- **Public guide** (`/for-venues`): a tile beside each kind of business (its
  boxes and its cards, and the heading of a kind's own page), a glyph beside
  each activity and beside each activity whose support is limited.
- **Customers**: the activity chips in search and quick search, the sport
  buttons on a venue's booking board, open games, classes, tournaments and
  leagues; a venue's activities on its page and in search results; a venue
  card without a photo shows up to three of its activities; passes and
  bookings in the account; the three cards of `/play`.
- **Dashboard**: every list naming an activity (courts, schedule, bookings,
  classes, occupancy, reports, approvals, passes and credit, sign-offs), and
  the chosen activity when resources are added.

Not used, by design: emails, WhatsApp and SMS messages, receipts and other
PDFs, the MCP server's answers and the API (all text only), drop-down lists,
and the site header's brand mark, which stays as it is.

## Replacing a glyph

1. `npm run glyphs:export -- <folder>` writes every glyph as a standalone
   `.svg` (`activity/badminton` becomes `activity-badminton.svg`), with the
   standard's root attributes, ready to open in a drawing program. Nothing it
   writes is committed, and CI does not run it.
2. Edit on the 24-unit grid with the 1.75 stroke, keeping the rules above.
   Save as plain SVG; remove any colours, styles, ids, transforms and groups
   the program adds (flatten transforms into the path data).
3. Paste the elements inside `<svg>` back into the glyph's entry in
   `src/lib/icons/glyphs.ts`, under the same name.
4. `npx vitest run tests/glyphs.test.ts` checks every rule, the grid and the
   size budget. Names never change: the catalogue and saved activities refer
   to them.

## Cost

All 67 glyphs are 12.7 KB of markup, 3.5 KB compressed with gzip (measured
on 2 November 2026); the 13 kinds of business are 0.9 KB of that. A page that
draws a glyph carries the whole set once in its script, which is the price of
an activity's picture being a name chosen at run time; a page that draws none
carries none. Splitting the set was not worth the code for that size.
