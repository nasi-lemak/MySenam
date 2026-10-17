/**
 * What pages in the browser need to know about venue photos, apart from
 * lib/photos.ts, which reaches the image library and the database.
 */

export const MAX_PHOTOS = 6;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const PHOTO_WIDTHS = [400, 800, 1600] as const;
export const MAX_CAPTION = 120;

export interface Photo {
  id: number;
  venueId: number;
  caption: string | null;
  /** Of the largest version. */
  width: number;
  height: number;
  color: string;
  position: number;
  /** Each version's address, smallest first. */
  src: { width: number; url: string }[];
  createdAt: string;
}

/** For `<img srcset>`. */
export function srcSet(photo: Pick<Photo, "src">): string {
  return photo.src.map((s) => `${s.url} ${s.width}w`).join(", ");
}

/** The version nearest `width`, for where one size is all there is room for. */
export function photoAt(photo: Pick<Photo, "src">, width: number): string {
  return (photo.src.find((s) => s.width >= width) ?? photo.src[photo.src.length - 1]).url;
}
