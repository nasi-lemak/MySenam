import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";

/**
 * Every route handler that takes a body answers a body that is valid JSON
 * but not an object (`null`, a list, a number, a string), or is not JSON at
 * all, with a 4xx, never a 500 (lib/api.ts `readJsonObject`). Each is called
 * signed in as the platform owner and as a customer, so the body is reached
 * past the sign-in checks.
 */

const ROUTES = import.meta.glob("../src/app/api/**/route.ts");
const METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const BODIES = ["null", "[]", "5", '"text"', "{not json"];
/**
 * Handlers that act without reading a body, so calling them does what they
 * do: make or load a backup, fill the demo, end the session these calls use.
 * Each is covered by its own tests.
 */
const SKIP = new Set(["admin/backup", "admin/demo", "admin/auth/logout", "auth/logout"]);

let ownerId: number;
let userId: number;
let n = 0;

/** A value for each dynamic segment: a long token where it is one, else an id. */
const fill = (path: string) => {
  const params: Record<string, string> = {};
  const url = path.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = /token|key/i.test(name) ? "a".repeat(40) : name === "provider" ? "fake" : "1";
    params[name] = value;
    return value;
  });
  return { url, params };
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const u = await registerUser({ name: "Body Tester", email: "bodies@example.my", phone: "0123334444", password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  userId = u.user.id;
});

describe("a body that is not a JSON object", () => {
  it("is refused with a 4xx by every handler, never a 500", async () => {
    const failures: string[] = [];
    let called = 0;
    for (const [file, load] of Object.entries(ROUTES).sort()) {
      const path = file.replace("../src/app/api/", "").replace(/\/route\.ts$/, "");
      if (SKIP.has(path)) continue;
      const mod = (await load()) as Record<string, unknown>;
      for (const method of METHODS) {
        const handler = mod[method];
        if (typeof handler !== "function") continue;
        for (const body of BODIES) {
          const { url, params } = fill(path);
          const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}; ${SESSION_COOKIE}=${(await createSession(userId)).token}`;
          const req = new NextRequest(`http://localhost/api/${url}`, {
            method,
            headers: { "content-type": "application/json", cookie, origin: "http://localhost", "x-forwarded-for": `10.99.${++n % 250}.${n % 200}` },
            body,
          });
          let status: number | string;
          try {
            const res = (await (handler as (r: NextRequest, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) })) as Response;
            status = res.status;
          } catch (err) {
            status = `threw ${String(err).slice(0, 120)}`;
          }
          called++;
          if (typeof status !== "number" || status >= 500) failures.push(`${method} /api/${path} ${body} -> ${status}`);
        }
      }
    }
    expect(called).toBeGreaterThan(500);
    expect(failures).toEqual([]);
  }, 600_000);
});
