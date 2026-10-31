// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";
// No mail or WhatsApp service is reached from a test, whatever this machine has set: sign-ups then open at once, unconfirmed.
for (const name of ["SMTP_URL", "MAIL_FROM", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[name];

let address = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(address),
  usePathname: () => "/list-your-venue",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));
// The map is not what is tested: a stand-in that drops a pin when asked.
vi.mock("@/components/PinPicker", () => ({
  default: ({ onPin }: { onPin: (p: { lat: number; lng: number }) => void }) => (
    <button type="button" onClick={() => onPin({ lat: 3.15, lng: 101.6 })}>
      Drop a pin
    </button>
  ),
}));
vi.mock("@/components/Language", async () => {
  const { translator } = await import("../src/lib/i18n");
  return { useT: () => translator("en"), LanguageToggle: () => null };
});

import { NextRequest } from "next/server";
import ApplyForm from "../src/app/list-your-venue/ApplyForm";
import { POST as applyPost } from "../src/app/api/venue-applications/route";
import { getDb } from "../src/lib/db";
import { readGuide } from "../src/lib/guide/answers";
import { applyAddress } from "../src/lib/guide/public/select";
import { translator, type Phrase } from "../src/lib/i18n";

/**
 * What a visitor chose in the public guide reaches the venue it becomes
 * (docs/features/venue-guide.md#the-public-guide): the address carries it, the
 * form shows it back with a way to change it, the request sends it as `fit`,
 * the application keeps it and the venue's guide starts from it. The visitor
 * is never asked it twice, and a form with nothing in the address sends none.
 */

/** The first request opens the in-memory database, which takes a moment. */
const SLOW = { timeout: 20_000 };

let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  // The form's request goes to the real route handler, so what is stored is what the route accepts.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      bodies.push(JSON.parse(init.body));
      return applyPost(new NextRequest(`http://localhost${url}`, { method: init.method, headers: init.headers, body: init.body }));
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const en = translator("en");

/** Fills in the form the way a person does, by its labels, drops the pin and sends it. */
async function submitForm(email: string, name: string) {
  const set = (phrase: Phrase, value: string) => fireEvent.change(screen.getByLabelText(en(phrase)), { target: { value } });
  set("apply.business", name);
  set("apply.area", "Ampang");
  set("apply.venuePhone", "0342220000");
  set("apply.address", "1 Jalan Satu, Ampang");
  set("apply.contactName", "Rina");
  set("apply.email", email);
  set("apply.password", "a long enough password");
  fireEvent.click(screen.getByRole("button", { name: "Drop a pin" }));
  fireEvent.submit(document.querySelector("form")!);
}

describe("the application form", () => {
  it("shows what the visitor chose, back, with a way to change it, and sends it with the application", async () => {
    address = "fit=types:swimming,coaching-academy~activities:swimming";
    render(<ApplyForm />);
    const note = screen.getByRole("region", { name: /You told us you run/ });
    expect(note.textContent).toContain("Swimming facility");
    expect(note.textContent).toContain("Coaching academy");
    expect(note.textContent).toContain("Swimming");
    // Change goes back to the guide with the same choice in its address.
    const change = screen.getByRole("link", { name: "Change" });
    expect(change.getAttribute("href")).toBe("/for-venues?types=swimming,coaching-academy&activities=swimming");
    await submitForm("handoff@guide.my", "Handoff Courts");
    await waitFor(() => expect(bodies.length).toBe(1), SLOW);
    expect(bodies[0].fit).toEqual({ v: 1, types: ["swimming", "coaching-academy"], activities: ["swimming"] });
    // Nothing personal rides in it, and nothing else of the guide's.
    expect(Object.keys(bodies[0].fit as object).sort()).toEqual(["activities", "types", "v"]);
    // The route accepted it, the application kept it, and the venue's guide starts from it.
    await waitFor(async () => expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE email = 'handoff@guide.my'").get() as { n: number }).n).toBe(1), SLOW);
    const row = (await getDb().prepare("SELECT venue_id, fit FROM venue_applications WHERE email = 'handoff@guide.my'").get()) as { venue_id: number; fit: string };
    expect(JSON.parse(row.fit)).toEqual({ v: 1, types: ["swimming", "coaching-academy"], activities: ["swimming"] });
    expect((await readGuide(row.venue_id)).answers).toEqual({ v: 1, types: ["swimming", "coaching-academy"], activities: ["swimming"] });
  });

  it("comes from the guide's own address for the same choice", async () => {
    const sel = { types: ["climbing-and-bouldering"] as never, activities: ["bouldering"] };
    address = applyAddress(sel).split("?")[1];
    render(<ApplyForm />);
    expect(screen.getByRole("region", { name: /You told us you run/ }).textContent).toContain("Climbing or bouldering centre");
    await submitForm("roundtrip@guide.my", "Round Trip Climbing");
    await waitFor(() => expect(bodies.length).toBe(1), SLOW);
    expect(bodies[0].fit).toEqual({ v: 1, types: ["climbing-and-bouldering"], activities: ["bouldering"] });
    await waitFor(async () => expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE email = 'roundtrip@guide.my'").get() as { n: number }).n).toBe(1), SLOW);
    const row = (await getDb().prepare("SELECT venue_id FROM venue_applications WHERE email = 'roundtrip@guide.my'").get()) as { venue_id: number };
    expect((await readGuide(row.venue_id)).answers).toMatchObject({ types: ["climbing-and-bouldering"], activities: ["bouldering"] });
  });

  it("leaves the choice out when the visitor asks, and sends none at all when the address has none", async () => {
    address = "fit=types:mixed";
    render(<ApplyForm />);
    fireEvent.click(screen.getByRole("button", { name: "Leave this out" }));
    expect(screen.queryByRole("region", { name: /You told us you run/ })).toBeNull();
    await submitForm("leaveout@guide.my", "Leave Out Courts");
    await waitFor(() => expect(bodies.length).toBe(1), SLOW);
    expect("fit" in bodies[0]).toBe(false);
    await waitFor(async () => expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE email = 'leaveout@guide.my'").get() as { n: number }).n).toBe(1), SLOW);
    const row = (await getDb().prepare("SELECT venue_id, fit FROM venue_applications WHERE email = 'leaveout@guide.my'").get()) as { venue_id: number; fit: string | null };
    expect(row.fit).toBeNull();
    expect(await readGuide(row.venue_id)).toMatchObject({ rev: 0, answers: { v: 1 } });
  });

  it("shows nothing and sends nothing for an address that names nothing real, and keeps what is real from one that mixes", async () => {
    address = "fit=types:spaceport~activities:curling";
    const first = render(<ApplyForm />);
    expect(screen.queryByRole("region", { name: /You told us you run/ })).toBeNull();
    first.unmount();
    address = "fit=types:swimming,spaceport";
    render(<ApplyForm />);
    expect(screen.getByRole("region", { name: /You told us you run/ }).textContent).toContain("Swimming facility");
    expect(screen.getByRole("region", { name: /You told us you run/ }).textContent).not.toMatch(/spaceport/i);
    await submitForm("mixed@guide.my", "Mixed Address Courts");
    await waitFor(() => expect(bodies.length).toBe(1), SLOW);
    expect(bodies[0].fit).toEqual({ v: 1, types: ["swimming"] });
  });
});

