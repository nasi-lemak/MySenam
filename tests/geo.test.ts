import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areaMatches,
  distanceM,
  findAddress,
  formatDistance,
  geocoderOn,
  inCountry,
  placeAt,
  readPoint,
  resetGeocoder,
} from "../src/lib/geo";

/** Where things are, and how the map is asked. */

describe("distances", () => {
  it("are measured along the ground", () => {
    // KLCC to KL Sentral: 2.6 km south and 2.8 km west.
    expect(distanceM({ lat: 3.1579, lng: 101.7116 }, { lat: 3.1343, lng: 101.6862 })).toBe(3852);
    expect(distanceM({ lat: 3, lng: 101 }, { lat: 3, lng: 101 })).toBe(0);
  });

  it("read the way people say them", () => {
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(4249)).toBe("4.2 km");
    expect(formatDistance(181_400)).toBe("181 km");
  });
});

describe("a pin from a form", () => {
  it("is two finite numbers, rounded to ten centimetres", () => {
    expect(readPoint(3.12345678, 101.7)).toEqual({ lat: 3.123457, lng: 101.7 });
    expect(readPoint("3.1", 101.7)).toBeNull();
    expect(readPoint(NaN, 101.7)).toBeNull();
    expect(readPoint(undefined, undefined)).toBeNull();
  });

  it("is in Malaysia, Peninsular or Borneo", () => {
    expect(inCountry({ lat: 3.14, lng: 101.69 })).toBe(true); // KL
    expect(inCountry({ lat: 5.98, lng: 116.07 })).toBe(true); // Kota Kinabalu
    expect(inCountry({ lat: 13.75, lng: 100.5 })).toBe(false); // Bangkok
    expect(inCountry({ lat: 51.5, lng: -0.12 })).toBe(false);
  });
});

describe("the area somebody typed", () => {
  const place = "Taman Connaught, Cheras, Kuala Lumpur, 56000, Malaysia";
  it("matches a place name in what the map says is at the pin", () => {
    expect(areaMatches("Cheras", place)).toBe(true);
    expect(areaMatches("cheras, KL", place)).toBe(true);
    expect(areaMatches("KL", place)).toBe(true);
    expect(areaMatches("PJ", "Section 14, Petaling Jaya, Selangor")).toBe(true);
  });

  it("does not match on words every address has", () => {
    expect(areaMatches("Ipoh", place)).toBe(false);
    expect(areaMatches("Taman Jalan", place)).toBe(false);
  });
});

describe("asking the map", () => {
  const asked: string[] = [];
  const answer = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        asked.push(url);
        expect(new Headers(init.headers).get("user-agent")).toMatch(/venue check/);
        if (body instanceof Error) throw body;
        return Response.json(body);
      })
    );
  beforeEach(() => {
    asked.length = 0;
    resetGeocoder();
    process.env.MYSENAM_GEOCODER = "http://geo.test";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.MYSENAM_GEOCODER = "off";
  });

  it("is not done at all when switched off", async () => {
    process.env.MYSENAM_GEOCODER = "off";
    answer([]);
    expect(geocoderOn()).toBe(false);
    expect(await findAddress("12 Jalan Cheras")).toBeNull();
    expect(await placeAt({ lat: 3, lng: 101 })).toBeNull();
    expect(asked).toEqual([]);
  });

  it("asks once for the same thing", async () => {
    answer([{ lat: "3.1", lon: "101.7", display_name: "Cheras" }]);
    expect(await findAddress("12 Jalan Cheras")).toEqual({ lat: 3.1, lng: 101.7, label: "Cheras" });
    expect(await findAddress("12 Jalan Cheras")).toEqual({ lat: 3.1, lng: 101.7, label: "Cheras" });
    expect(asked).toHaveLength(1);
  });

  it("makes nothing of an answer it cannot read", async () => {
    expect(await findAddress("ab")).toBeNull();
    answer({ error: "nope" });
    expect(await findAddress("somewhere odd")).toBeNull();
    resetGeocoder();
    answer([{ lat: "north", lon: "101.7" }]);
    expect(await findAddress("somewhere odd")).toBeNull();
    resetGeocoder();
    answer([{}]);
    expect(await findAddress("somewhere odd")).toBeNull();
    resetGeocoder();
    answer({});
    expect(await placeAt({ lat: 3, lng: 101 })).toBeNull();
  });

  it("carries on without an answer when the map is down", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(new Error("ECONNREFUSED"));
    expect(await findAddress("12 Jalan Cheras")).toBeNull();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("keeps to one request a second on OpenStreetMap's own server", async () => {
    delete process.env.MYSENAM_GEOCODER;
    expect(geocoderOn()).toBe(true);
    answer({ display_name: "Somewhere" });
    const started = Date.now();
    await placeAt({ lat: 3, lng: 101 });
    await placeAt({ lat: 3.1, lng: 101 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(asked[0]).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/);
  });
});
