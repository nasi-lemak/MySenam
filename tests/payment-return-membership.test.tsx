import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

// The customer's language, as the switch in the header sets it.
let cookieLang: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && cookieLang ? { value: cookieLang } : undefined) }),
}));

// A gateway's signed return, stood in for: the bill in the address is believed. Settling is the gateways' own tests'.
vi.mock("../src/lib/gateways", async (actual) => ({
  ...(await actual<typeof import("../src/lib/gateways")>()),
  allGateways: () => [
    {
      readRedirect: (q: URLSearchParams) => {
        const billId = q.get("bill");
        return billId ? { billId, verify: async () => ({ billId, paid: true }) } : null;
      },
    },
  ],
}));
vi.mock("../src/lib/payments", async (actual) => ({
  ...(await actual<typeof import("../src/lib/payments")>()),
  accountForBill: async () => ({}),
  settleBill: async () => null,
}));

import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { createVenue, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import PaymentReturnPage from "../src/app/payments/return/page";

/**
 * The page a customer comes back to after paying a membership online
 * (app/payments/return): it says whose membership it is — the buyer's own,
 * a child's (or other participant's) own, and whom a family one covers —
 * in the customer's language.
 */

let venueId: number;
let n = 0;

const page = async (bill: string) => renderToStaticMarkup(await PaymentReturnPage({ searchParams: Promise.resolve({ bill }) }));

/** A parent with two children, Alya and Badrul (one membership a number at a venue: a new family each time). */
async function family() {
  const phone = `0177123${String(++n).padStart(3, "0")}`;
  const made = await registerUser({ name: "Puan Siti", email: `return-parent${n}@example.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  const parent = { id: made.user.id, name: made.user.name, phone };
  const kid = async (displayName: string) => {
    const k = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
    if (!k.ok) throw new Error(k.error);
    return k.person.id;
  };
  return { parent, alya: await kid("Alya"), badrul: await kid("Badrul") };
}

/** A membership made by a paid online fee, as settling one leaves it. */
async function paidFor(input: (f: Awaited<ReturnType<typeof family>>) => { holderParticipantId?: number; covers?: number[] }): Promise<string> {
  const f = await family();
  const { parent } = f;
  const made = await sellMembership({
    venueId,
    holderName: parent.name,
    holderPhone: parent.phone,
    userId: parent.id,
    startsOn: todayISO(),
    expiresOn: addDays(todayISO(), 30),
    price: 50,
    paidVia: "Online (Stripe)",
    ...input(f),
  });
  if (!made.ok) throw new Error(made.error);
  const bill = `cs_test_return${++n}`;
  await getDb()
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, member_user_id, membership_id)
       VALUES ('stripe', ?, '', ?, 50, 'paid', ?, ?, 'membership', ?, ?)`
    )
    .run(bill, venueId, parent.name, parent.phone, parent.id, made.membership.id);
  return bill;
}

beforeAll(async () => {
  const v = await createVenue({ name: "Kelab Renang", area: "PJ", address: "x", phone: "0377771234" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
});

afterEach(() => {
  cookieLang = undefined;
});

describe("coming back from paying a membership", () => {
  it("for oneself says you are a member, as before", async () => {
    const html = await page(await paidFor(() => ({})));
    expect(html).toContain("You&#x27;re a member");
    expect(html).not.toContain("is a member");
    expect(html).not.toContain("covers");
  });

  it("for a child's own membership names the child, not the buyer", async () => {
    const bill = await paidFor((f) => ({ holderParticipantId: f.alya }));
    const html = await page(bill);
    expect(html).toContain("Alya is a member");
    expect(html).toMatch(/Alya&#x27;s membership M?[\w-]+ at Kelab Renang runs from/);
    expect(html).not.toContain("You&#x27;re a member");
    cookieLang = "ms";
    expect(await page(bill)).toContain("Alya kini ahli");
    cookieLang = "zh";
    expect(await page(bill)).toContain("Alya已成为会员");
    cookieLang = "ta";
    expect(await page(bill)).toContain("Alya இப்போது உறுப்பினர்");
  });

  it("for a family membership names whom it covers besides its holder", async () => {
    const bill = await paidFor((f) => ({ covers: [f.alya, f.badrul] }));
    const html = await page(bill);
    expect(html).toContain("You&#x27;re a member");
    expect(html).toContain("It covers Alya, Badrul too.");
    cookieLang = "ms";
    expect(await page(bill)).toContain("Keahlian ini juga meliputi Alya, Badrul.");
  });

  it("a child's own membership covering a sibling names both", async () => {
    const html = await page(await paidFor((f) => ({ holderParticipantId: f.alya, covers: [f.badrul] })));
    expect(html).toContain("Alya is a member");
    expect(html).toContain("It covers Badrul too.");
  });
});
