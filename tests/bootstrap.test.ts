import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { authenticateAdmin, isOwner } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";

/**
 * A fresh install's platform owner, when a business got there first: on a
 * marketplace anybody can sign up before the owner has ever signed in.
 */
describe("the first platform owner", () => {
  it("is still made when a business signed up before anybody else", async () => {
    const signedUp = await submitApplication({
      businessName: "Early Bird Hall",
      area: "Cheras",
      address: "1 Jalan Awal",
      venuePhone: "0300000000",
      contactName: "Early",
      email: "early@example.my",
      password: "a long enough password",
      lat: 3.1,
      lng: 101.7,
    });
    expect(signedUp.ok).toBe(true);
    const owner = await authenticateAdmin("admin@mysenam.my", "mysenam-admin");
    expect(owner && isOwner(owner)).toBe(true);
  });
});
