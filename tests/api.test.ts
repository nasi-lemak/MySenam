import { describe, expect, it } from "vitest";

import { refusal } from "../src/lib/api";

/**
 * A refusal on its way to the browser. The sentence always goes; the name goes
 * when the store had one, and the page prefers the name so it can say it in
 * whichever language the reader is in.
 */
describe("a refusal leaving the server", () => {
  it("carries the sentence, the name and what it quotes", async () => {
    const res = refusal({
      ok: false,
      error: "Maximum 4 hours per booking.",
      code: "MAX_HOURS",
      vars: { max: 4 },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Maximum 4 hours per booking.",
      code: "MAX_HOURS",
      vars: { max: 4 },
    });
  });

  it("sends no empty vars for a refusal that quotes nothing", async () => {
    const res = refusal({ ok: false, error: "Booking not found.", code: "BOOKING_NOT_FOUND" });
    const body = await res.json();
    expect(body).toEqual({ error: "Booking not found.", code: "BOOKING_NOT_FOUND" });
    expect("vars" in body).toBe(false);
  });

  it("still goes out for a refusal nothing has named yet", async () => {
    const res = refusal({ ok: false, error: "Something nobody coded." });
    expect(await res.json()).toEqual({ error: "Something nobody coded." });
  });

  it("can be sent with another status when 409 is the wrong word", async () => {
    expect(refusal({ ok: false, error: "Gone." }, 404).status).toBe(404);
  });
});
