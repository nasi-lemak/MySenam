import type { CSSProperties } from "react";
import { activity } from "@/lib/activity-registry";
import { GLYPH_ROOT, glyphShapes, isGlyphName, type GlyphTone } from "@/lib/icons/glyphs";

/**
 * MySenam's pictures (docs/development/images.md): a glyph drawn in the text's
 * colour, and the same glyph in a tinted tile. Pure: no state, no effects, so
 * server pages and client screens render them alike.
 *
 * Decorative by default (`aria-hidden`), because a glyph is always shown
 * beside its name; give `label` only where a glyph stands alone, and it is
 * then an image with that accessible name.
 */

type Size = number | string;

/** React's names for the standard's root attributes (lib/icons/glyphs.ts GLYPH_ROOT). */
const ROOT = {
  viewBox: GLYPH_ROOT.viewBox,
  fill: GLYPH_ROOT.fill,
  stroke: GLYPH_ROOT.stroke,
  strokeWidth: GLYPH_ROOT["stroke-width"],
  strokeLinecap: GLYPH_ROOT["stroke-linecap"],
  strokeLinejoin: GLYPH_ROOT["stroke-linejoin"],
} as const;

function a11y(label: string | undefined) {
  return label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
}

/** One glyph by name, `size` pixels (or any CSS length: `1.15em` follows the text). Nothing for a name that is not a glyph. */
export function Glyph({ name, size = "1.15em", label, className = "" }: { name: string; size?: Size; label?: string; className?: string }) {
  const shapes = glyphShapes(name);
  if (!shapes) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      {...ROOT}
      focusable="false"
      data-glyph={name}
      className={`inline-block shrink-0 align-[-0.2em] ${className}`}
      {...a11y(label)}
    >
      {shapes.map(({ tag: Tag, attrs }, i) => (
        // Element attributes are geometry, fill and stroke only: React takes them under the same names.
        <Tag key={i} {...attrs} />
      ))}
    </svg>
  );
}

const TONE_CLASS: Record<GlyphTone, string> = {
  racket: "bg-tile-racket text-tile-racket-ink",
  team: "bg-tile-team text-tile-team-ink",
  aquatic: "bg-tile-aquatic text-tile-aquatic-ink",
  water: "bg-tile-water text-tile-water-ink",
  fitness: "bg-tile-fitness text-tile-fitness-ink",
  studio: "bg-tile-studio text-tile-studio-ink",
  specialist: "bg-tile-specialist text-tile-specialist-ink",
  neutral: "bg-tile-neutral text-tile-neutral-ink",
};

const toneOf = (tone: string | undefined): GlyphTone => (tone && tone in TONE_CLASS ? (tone as GlyphTone) : "neutral");

/**
 * A glyph centred in a rounded-square tile tinted by its tone (a category, or
 * neutral). `name` is a glyph; anything else (an activity's legacy emoji) is
 * shown as text in the same tile, so an old row looks at home until changed.
 */
export function GlyphTile({ name, tone, size = 40, label, className = "" }: { name: string; tone?: string; size?: number; label?: string; className?: string }) {
  const style: CSSProperties = { width: size, height: size, borderRadius: Math.round(size / 4) };
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${TONE_CLASS[toneOf(tone)]} ${className}`} style={style} {...a11y(label)}>
      {isGlyphName(name) ? (
        <Glyph name={name} size={Math.round(size * 0.6)} />
      ) : (
        <span aria-hidden="true" style={{ fontSize: Math.round(size * 0.5), lineHeight: 1 }}>
          {name}
        </span>
      )}
    </span>
  );
}

/**
 * An activity's picture inline, beside its name: its glyph, or, for an
 * operator's own activity still holding an emoji from before glyphs, that
 * emoji as text.
 */
export function ActivityGlyph({ sport, icon: given, size, label, className }: { sport: string; icon?: string; size?: Size; label?: string; className?: string }) {
  // `icon`: the activity's own, where the screen has it fresher than this page's catalogue (one just added).
  const icon = given ?? activity(sport).icon;
  if (isGlyphName(icon)) return <Glyph name={icon} size={size} label={label} className={className} />;
  return (
    <span className={className} {...a11y(label)}>
      {icon}
    </span>
  );
}

/** An activity's picture in its category's tile: selection cards and lists of activities. */
export function ActivityTile({ sport, size, label, className }: { sport: string; size?: number; label?: string; className?: string }) {
  const a = activity(sport);
  return <GlyphTile name={a.icon} tone={a.category} size={size} label={label} className={className} />;
}
