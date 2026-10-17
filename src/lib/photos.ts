import crypto from "crypto";
import sharp from "sharp";
import { getDb } from "./db";
import { photoStore, photoUrl } from "./photo-store";
import { MAX_CAPTION, MAX_PHOTOS, MAX_UPLOAD_BYTES, PHOTO_WIDTHS, type Photo } from "./photos-shared";

/**
 * Venue photos: a cover and up to five more, all optional.
 *
 * What is uploaded is never kept or served. It must be a JPEG, PNG or WebP —
 * by what the file is, not what it is called — and no bigger than a phone
 * camera makes; it is turned the right way up and drawn afresh as WebP at
 * three widths, for a search card, a page and a full screen. Drawing it
 * afresh is what makes it safe: nothing of the original survives but its
 * pixels, so no location, no camera details, and nothing a crafted file
 * could carry. SVG, which is a program as much as a picture, is never
 * accepted.
 */

export { MAX_CAPTION, MAX_PHOTOS, MAX_UPLOAD_BYTES, PHOTO_WIDTHS, photoAt, srcSet, type Photo } from "./photos-shared";
/** More than any phone takes, and few enough that one cannot exhaust the memory. */
export const MAX_PIXELS = 50_000_000;
export const MIN_WIDTH = 400;

/** What a file is, by its first bytes. */
export function sniff(data: Buffer): "jpeg" | "png" | "webp" | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

export type Processed = {
  width: number;
  height: number;
  color: string;
  files: { width: number; data: Buffer }[];
};

/** Check an upload and draw it afresh at every width. */
export async function processPhoto(data: Buffer): Promise<{ ok: true; value: Processed } | { ok: false; error: string }> {
  if (data.length > MAX_UPLOAD_BYTES) return { ok: false, error: "That photo is over 15 MB. Send a smaller one." };
  const kind = sniff(data);
  if (!kind) return { ok: false, error: "Send a photo as JPEG, PNG or WebP." };
  try {
    const opts = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };
    const meta = await sharp(data, opts).metadata();
    // The bytes said one thing; make sure the decoder agrees.
    if (meta.format !== kind) return { ok: false, error: "Send a photo as JPEG, PNG or WebP." };
    // Turned the way the camera held it, which is the only thing kept from its metadata.
    const upright = sharp(data, opts).rotate();
    const files: { width: number; data: Buffer }[] = [];
    let width = 0;
    let height = 0;
    for (const w of PHOTO_WIDTHS) {
      const out = await upright
        .clone()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      files.push({ width: out.info.width, data: out.data });
      width = out.info.width;
      height = out.info.height;
    }
    if (width < MIN_WIDTH) return { ok: false, error: `That photo is too small: at least ${MIN_WIDTH} pixels wide, please.` };
    const { dominant } = await sharp(files[0].data).stats();
    const color = `#${[dominant.r, dominant.g, dominant.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    return { ok: true, value: { width, height, color, files } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/pixel limit/i.test(message)) return { ok: false, error: "That photo has too many pixels. Send a smaller one." };
    return { ok: false, error: "That file could not be read as a photo." };
  }
}

interface PhotoRow {
  id: number;
  venue_id: number;
  key: string;
  width: number;
  height: number;
  color: string;
  caption: string | null;
  position: number;
  created_at: string;
}

function toPhoto(r: PhotoRow): Photo {
  return {
    id: r.id,
    venueId: r.venue_id,
    caption: r.caption,
    width: r.width,
    height: r.height,
    color: r.color,
    position: r.position,
    // A photo narrower than 1600 has its own width as its largest, so some versions are the same size.
    src: PHOTO_WIDTHS.map((w) => ({ width: Math.min(w, r.width), url: photoUrl(`${r.key}-${w}.webp`) })).filter(
      (s, i, all) => all.findIndex((x) => x.width === s.width) === i
    ),
    createdAt: r.created_at,
  };
}

export async function venuePhotos(venueId: number): Promise<Photo[]> {
  return ((await getDb().prepare("SELECT * FROM venue_photos WHERE venue_id = ? ORDER BY position, id").all(venueId)) as PhotoRow[]).map(toPhoto);
}

/** Each venue's cover, for cards. */
export async function coversFor(venueIds: number[]): Promise<Map<number, Photo>> {
  if (venueIds.length === 0) return new Map();
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT ON (venue_id) * FROM venue_photos
        WHERE venue_id IN (${venueIds.map(() => "?").join(",")}) ORDER BY venue_id, position, id`
    )
    .all(...venueIds)) as PhotoRow[];
  return new Map(rows.map((r) => [r.venue_id, toPhoto(r)]));
}

export type PhotoResult = { ok: true; value: Photo[] } | { ok: false; error: string };

/** A new photo, last in the order — or the cover, if it is the first. */
export async function addPhoto(venueId: number, data: Buffer, opts: { caption?: string; adminId?: number } = {}): Promise<PhotoResult> {
  const db = getDb();
  const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM venue_photos WHERE venue_id = ?").get(venueId)) as { n: number };
  if (n >= MAX_PHOTOS) return { ok: false, error: `${MAX_PHOTOS} photos at most: a cover and ${MAX_PHOTOS - 1} more. Remove one first.` };
  const processed = await processPhoto(data);
  if (!processed.ok) return processed;
  const key = `venues/${venueId}/${crypto.randomBytes(8).toString("hex")}`;
  const store = photoStore();
  const written: string[] = [];
  try {
    for (const [i, f] of processed.value.files.entries()) {
      const name = `${key}-${PHOTO_WIDTHS[i]}.webp`;
      await store.put(name, f.data);
      written.push(name);
    }
  } catch (err) {
    for (const name of written) await store.remove(name).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : "The photo could not be stored." };
  }
  const caption = opts.caption?.trim().slice(0, MAX_CAPTION) || null;
  const added = await db.transaction(async () => {
    // Counted again under the transaction, so two uploads at once cannot make seven.
    const { n: now, next } = (await db
      .prepare("SELECT COUNT(*)::int AS n, COALESCE(MAX(position) + 1, 0)::int AS next FROM venue_photos WHERE venue_id = ?")
      .get(venueId)) as { n: number; next: number };
    if (now >= MAX_PHOTOS) return false;
    await db
      .prepare("INSERT INTO venue_photos (venue_id, key, width, height, color, caption, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(venueId, key, processed.value.width, processed.value.height, processed.value.color, caption, next, opts.adminId ?? null);
    return true;
  })();
  if (!added) {
    await removeFiles(key);
    return { ok: false, error: `${MAX_PHOTOS} photos at most. Remove one first.` };
  }
  return { ok: true, value: await venuePhotos(venueId) };
}

async function removeFiles(key: string): Promise<void> {
  const store = photoStore();
  for (const w of PHOTO_WIDTHS) await store.remove(`${key}-${w}.webp`).catch(() => {});
}

/** Gone, files and all; the rest close up, so the next one becomes the cover if this was it. */
export async function removePhoto(venueId: number, photoId: number): Promise<PhotoResult> {
  const db = getDb();
  const row = (await db.prepare("SELECT key FROM venue_photos WHERE id = ? AND venue_id = ?").get(photoId, venueId)) as { key: string } | undefined;
  if (!row) return { ok: false, error: "Photo not found." };
  await db.prepare("DELETE FROM venue_photos WHERE id = ?").run(photoId);
  await renumber(venueId);
  await removeFiles(row.key);
  return { ok: true, value: await venuePhotos(venueId) };
}

/** Every file of every photo of these venues, for when the venues themselves go. */
export async function removeVenuePhotoFiles(keys: string[]): Promise<void> {
  for (const key of keys) await removeFiles(key);
}

async function renumber(venueId: number, order?: number[]): Promise<void> {
  const db = getDb();
  const ids = order ?? ((await db.prepare("SELECT id FROM venue_photos WHERE venue_id = ? ORDER BY position, id").all(venueId)) as { id: number }[]).map((r) => r.id);
  for (const [i, id] of ids.entries()) await db.prepare("UPDATE venue_photos SET position = ? WHERE id = ? AND venue_id = ?").run(i, id, venueId);
}

/** Make it the cover, move it one place earlier or later, or change its caption. */
export async function changePhoto(
  venueId: number,
  photoId: number,
  change: { cover?: boolean; move?: -1 | 1; caption?: string | null }
): Promise<PhotoResult> {
  const db = getDb();
  const photos = await venuePhotos(venueId);
  const at = photos.findIndex((p) => p.id === photoId);
  if (at < 0) return { ok: false, error: "Photo not found." };
  if (change.caption !== undefined)
    await db.prepare("UPDATE venue_photos SET caption = ? WHERE id = ?").run(change.caption?.trim().slice(0, MAX_CAPTION) || null, photoId);
  const ids = photos.map((p) => p.id);
  if (change.cover) {
    ids.splice(at, 1);
    ids.unshift(photoId);
    await renumber(venueId, ids);
  } else if (change.move) {
    const to = at + change.move;
    if (to >= 0 && to < ids.length) {
      [ids[at], ids[to]] = [ids[to], ids[at]];
      await renumber(venueId, ids);
    }
  }
  return { ok: true, value: await venuePhotos(venueId) };
}

/** Photos added lately, across venues, for the platform owner to look over. */
export async function recentPhotos(days = 14): Promise<(Photo & { venueName: string })[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.*, v.name AS venue_name FROM venue_photos p JOIN venues v ON v.id = p.venue_id
        WHERE p.created_at > datetime('now', ?) ORDER BY p.created_at DESC, p.id DESC LIMIT 200`
    )
    .all(`-${days} days`)) as (PhotoRow & { venue_name: string })[];
  return rows.map((r) => ({ ...toPhoto(r), venueName: r.venue_name }));
}
