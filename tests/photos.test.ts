import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

process.env.MYSENAM_DB = ":memory:";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-photos-"));
process.env.MYSENAM_DATA_DIR = dataDir;

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import {
  addPhoto,
  changePhoto,
  coversFor,
  MAX_PHOTOS,
  processPhoto,
  recentPhotos,
  removePhoto,
  removeVenuePhotoFiles,
  sniff,
  venuePhotos,
} from "../src/lib/photos";
import { photoAt, srcSet } from "../src/lib/photos-shared";
import { photoStore, photoUrl } from "../src/lib/photo-store";
import { createVenue, listVenues } from "../src/lib/store";

/** Venue photos: only real pictures, drawn afresh, nothing of the original kept. */

let venueId: number;
let ownerCookie: string;

/** A photo as a phone takes it: a JPEG, with where it was taken in it. */
async function phoneJpeg(width = 3000, height = 2000, orientation?: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .jpeg()
    .withMetadata({
      ...(orientation ? { orientation } : {}),
      exif: { IFD0: { Make: "PhonePhone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "3/1 8/1 0/1" } },
    })
    .toBuffer();
}

const files = (id: number) => fs.readdirSync(path.join(dataDir, "photos", "venues", String(id))).filter((f) => !f.endsWith(".part"));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession((await listAdmins())[0].id)).token}`;
  venueId = (await listVenues())[0].id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("what is accepted", () => {
  it("is a JPEG, PNG or WebP by what the file is, never by its name", async () => {
    expect(sniff(await phoneJpeg(500, 400))).toBe("jpeg");
    expect(sniff(await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer())).toBe("png");
    expect(sniff(await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).webp().toBuffer())).toBe("webp");
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniff(Buffer.from("GIF89a......"))).toBeNull();
    expect(await processPhoto(Buffer.from("<svg/>"))).toMatchObject({ ok: false, error: "Send a photo as JPEG, PNG or WebP." });
  });

  it("refuses what only looks like a photo, what is too small, and what has too many pixels", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]);
    expect(await processPhoto(fake)).toMatchObject({ ok: false });
    expect(await processPhoto(await phoneJpeg(300, 200))).toMatchObject({ ok: false, error: expect.stringContaining("too small") });
    const huge = await sharp({ create: { width: 10000, height: 6000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await processPhoto(huge)).toMatchObject({ ok: false, error: expect.stringContaining("too many pixels") });
    expect(await processPhoto(Buffer.alloc(16 * 1024 * 1024))).toMatchObject({ ok: false, error: expect.stringContaining("15 MB") });
  });

  it("is drawn afresh as WebP at three widths, the right way up, with nothing of where it was taken", async () => {
    const done = await processPhoto(await phoneJpeg(3000, 2000, 6));
    if (!done.ok) throw new Error(done.error);
    // Orientation 6 is a phone held upright: it comes out portrait.
    expect(done.value.files.map((f) => f.width)).toEqual([400, 800, 1600]);
    expect(done.value).toMatchObject({ width: 1600, height: 2400, color: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    for (const f of done.value.files) {
      const meta = await sharp(f.data).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation ?? 1).toBe(1);
    }
    // A small photo is not blown up.
    const small = await processPhoto(await phoneJpeg(600, 400));
    if (!small.ok) throw new Error(small.error);
    expect(small.value.files.map((f) => f.width)).toEqual([400, 600, 600]);
  });
});

describe("a venue's photos", () => {
  it("are optional, at most six, the first the cover; they move, change and go, files and all", async () => {
    expect(await venuePhotos(venueId)).toEqual([]);
    for (let i = 0; i < MAX_PHOTOS; i++) {
      const r = await addPhoto(venueId, await phoneJpeg(800, 600), { caption: i === 0 ? "  Main hall  " : undefined });
      if (!r.ok) throw new Error(r.error);
    }
    expect(await addPhoto(venueId, await phoneJpeg(800, 600))).toMatchObject({ ok: false, error: expect.stringContaining("6 photos at most") });
    const photos = await venuePhotos(venueId);
    expect(photos.map((p) => p.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(photos[0].caption).toBe("Main hall");
    expect(files(venueId)).toHaveLength(18);
    expect(photos[0].src.map((s) => s.width)).toEqual([400, 800]);
    expect(srcSet(photos[0])).toMatch(/^\/photos\/venues\/\d+\/[a-f0-9]{16}-400\.webp 400w, .*-800\.webp 800w$/);
    expect(photoAt(photos[0], 600)).toMatch(/-800\.webp$/);
    expect(photoAt(photos[0], 5000)).toMatch(/-800\.webp$/);

    const last = photos[5];
    const covered = await changePhoto(venueId, last.id, { cover: true, caption: "Court 3" });
    if (!covered.ok) throw new Error(covered.error);
    expect(covered.value[0]).toMatchObject({ id: last.id, caption: "Court 3" });
    const moved = await changePhoto(venueId, last.id, { move: 1 });
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value[1].id).toBe(last.id);
    expect((await changePhoto(venueId, last.id, { move: -1 })).ok).toBe(true);
    expect((await coversFor([venueId])).get(venueId)?.id).toBe(last.id);
    expect(await coversFor([])).toEqual(new Map());

    const gone = await removePhoto(venueId, last.id);
    if (!gone.ok) throw new Error(gone.error);
    expect(gone.value).toHaveLength(5);
    expect(gone.value[0].position).toBe(0);
    expect(files(venueId)).toHaveLength(15);
    expect(await removePhoto(venueId, last.id)).toMatchObject({ ok: false });
    expect(await changePhoto(venueId, last.id, { cover: true })).toMatchObject({ ok: false });
    expect((await recentPhotos()).length).toBeGreaterThanOrEqual(5);

    for (const p of gone.value) await removePhoto(venueId, p.id);
    expect(files(venueId)).toHaveLength(0);
  });
});

describe("storage", () => {
  it("is a bucket of its own when one is set up, with a public address if there is one", async () => {
    vi.stubEnv("PHOTOS_S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com");
    vi.stubEnv("PHOTOS_S3_BUCKET", "venue-photos");
    vi.stubEnv("PHOTOS_S3_ACCESS_KEY_ID", "key");
    vi.stubEnv("PHOTOS_S3_SECRET_ACCESS_KEY", "secret");
    const calls: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), method: init.method!, auth: new Headers(init.headers).get("authorization") });
        return init.method === "GET" ? new Response("nope", { status: 404 }) : new Response("", { status: 200 });
      })
    );
    const store = photoStore();
    expect(store.kind).toBe("s3");
    await store.put("venues/1/abc-400.webp", Buffer.from("x"));
    expect(await store.get("venues/1/abc-400.webp")).toBeNull();
    await store.remove("venues/1/abc-400.webp");
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(calls[0].url).toBe("https://acct.r2.cloudflarestorage.com/venue-photos/venues/1/abc-400.webp");
    expect(calls[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=key\//);

    expect(photoUrl("venues/1/abc-400.webp")).toBe("/photos/venues/1/abc-400.webp");
    vi.stubEnv("PHOTOS_PUBLIC_URL", "https://photos.example.my/");
    expect(photoUrl("venues/1/abc-400.webp")).toBe("https://photos.example.my/venues/1/abc-400.webp");

    // A bucket that refuses: nothing is half-added.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    expect(await addPhoto(venueId, await phoneJpeg(800, 600))).toMatchObject({ ok: false, error: expect.stringContaining("403") });
    vi.unstubAllEnvs();
    vi.stubEnv("MYSENAM_DATA_DIR", dataDir);
    expect(await venuePhotos(venueId)).toEqual([]);
  });

  it("on disk, never reaches outside its folder", async () => {
    await expect(photoStore().put("../../escape.webp", Buffer.from("x"))).rejects.toThrow();
    await removeVenuePhotoFiles(["venues/1/nothing-here"]);
  });
});

describe("the routes", () => {
  const upload = async (cookie: string, id: number, body: Buffer, contentType = "image/jpeg") => {
    const mod = await import("../src/app/api/admin/venues/[id]/photos/route");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(body)], { type: contentType }), "photo.jpg");
    form.set("caption", "Courts");
    return mod.POST(new NextRequest(`http://localhost/api/admin/venues/${id}/photos`, { method: "POST", headers: { cookie }, body: form }), {
      params: Promise.resolve({ id: String(id) }),
    });
  };

  it("take uploads from the venue's own staff, and serve them back to anybody", async () => {
    const res = await upload(ownerCookie, venueId, await phoneJpeg(1000, 700));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const [photo] = (await res.json()).photos;
    expect(photo.caption).toBe("Courts");
    expect((await upload(ownerCookie, venueId, Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(400);

    const serve = await import("../src/app/photos/[...key]/route");
    const key = photo.src[0].url.replace(/^\/photos\//, "").split("/");
    const shown = await serve.GET(new NextRequest(`http://localhost${photo.src[0].url}`), { params: Promise.resolve({ key }) });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/webp");
    expect(shown.headers.get("cache-control")).toContain("immutable");
    for (const bad of [["..", "secret.key"], ["venues", "1", "x.webp"], ["venues", "1", "0123456789abcdef-999.webp"]])
      expect((await serve.GET(new NextRequest("http://localhost/photos/x"), { params: Promise.resolve({ key: bad }) })).status).toBe(404);

    // Another venue's staff can neither add nor remove.
    const other = await createVenue({ name: "Photo Hall", area: "Klang", address: "1 Jalan Gambar", phone: "0331115555" });
    if (!other.ok) throw new Error("venue");
    const desk = await createAdmin({ name: "Desk", email: "desk@photohall.my", password: "desk-password", venueId: other.venue.id });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    expect((await upload(deskCookie, venueId, await phoneJpeg(1000, 700))).status).toBe(403);
    const one = await import("../src/app/api/admin/venues/[id]/photos/[photoId]/route");
    const ctx = { params: Promise.resolve({ id: String(venueId), photoId: String(photo.id) }) };
    expect((await one.DELETE(new NextRequest("http://localhost/x", { method: "DELETE", headers: { cookie: deskCookie } }), ctx)).status).toBe(403);
    const recent = await import("../src/app/api/admin/photos/route");
    expect((await recent.GET(new NextRequest("http://localhost/x", { headers: { cookie: deskCookie } }))).status).toBe(403);
    expect((await recent.GET(new NextRequest("http://localhost/x", { headers: { cookie: ownerCookie } }))).status).toBe(200);

    const patched = await one.PATCH(
      new NextRequest("http://localhost/x", { method: "PATCH", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ caption: "Hall" }) }),
      ctx
    );
    expect((await patched.json()).photos[0].caption).toBe("Hall");
    expect((await one.DELETE(new NextRequest("http://localhost/x", { method: "DELETE", headers: { cookie: ownerCookie } }), ctx)).status).toBe(200);
    const list = await import("../src/app/api/admin/venues/[id]/photos/route");
    const after = await list.GET(new NextRequest("http://localhost/x", { headers: { cookie: ownerCookie } }), { params: Promise.resolve({ id: String(venueId) }) });
    expect((await after.json()).photos).toEqual([]);
  });
});
