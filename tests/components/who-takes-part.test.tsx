// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SearchClient from "../../src/app/search/SearchClient";
import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { NeedsLabel } from "../../src/components/WhoTakesPart";
import { translator as makeT } from "../../src/lib/i18n";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * Who is taking part, on the search page (components/WhoTakesPart.tsx): a
 * signed-in account chooses itself, anybody it manages, or several; the
 * choice is this tab's alone and goes to the server with the search; each
 * badge then names each one's status, and the venue's grid follows the same
 * choice. Signed out, or nobody chosen: the requirement only.
 */

const DATE = addDays(todayISO(), 1);
const AISHA = 21;
const BEN = 22;
const PEOPLE = [
  { id: AISHA, displayName: "Aisha" },
  { id: BEN, displayName: "Ben" },
];

const LANE = { id: 5, venueId: 7, name: "Lane 1", sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1, activities: [] };
const result = (eligibility?: unknown) => ({
  venue: { id: 7, name: "Range Tujuh", area: "Putrajaya", amenities: [], access: "public" },
  court: LANE,
  startMin: 600,
  endMin: 660,
  startHour: 10,
  endHour: 11,
  totalPrice: 20,
  alsoFree: 0,
  pricesVary: false,
  needs: "signOff",
  groups: [],
  ...(eligibility ? { eligibility } : {}),
});

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => body });
let signedIn = true;
let fetchMock: ReturnType<typeof vi.fn>;
const searches = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/search"));

beforeEach(() => {
  window.sessionStorage.clear();
  signedIn = true;
  fetchMock = vi.fn(async (url: string) => {
    const u = new URL(String(url), "http://localhost");
    if (u.pathname === "/api/my/people") return signedIn ? json({ people: PEOPLE, own: null }) : json({ error: "Please sign in." }, false);
    if (u.pathname === "/api/search") {
      const taking = u.searchParams.get("taking");
      // What the server would say for each choice.
      const lines =
        taking === `${AISHA}`
          ? [{ participant: AISHA, status: "eligible" }]
          : taking === `${AISHA},${BEN}`
            ? [
                { participant: AISHA, status: "eligible" },
                { participant: BEN, status: "required" },
              ]
            : taking === "self"
              ? [{ participant: null, status: "inPerson" }]
              : undefined;
      return json({ date: DATE, sport: "archery", results: [result(signedIn ? lines : undefined)], areas: ["Putrajaya"], covers: {}, needsArea: false });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const badge = () => screen.getByText((_, el) => el?.getAttribute("data-needs") === "signOff" && el.tagName === "SPAN");

describe("choosing who is taking part on the search page", () => {
  it("shows a signed-out visitor the requirement only, and no choice", async () => {
    signedIn = false;
    render(<SearchClient sports={["archery"]} start={{ sport: "archery", date: DATE }} />);
    await act(async () => {});
    expect(screen.queryByTestId("taking-picker")).toBeNull();
    expect(badge().textContent).toBe("needs the venue's sign-off");
    expect(searches().every((u) => !u.includes("taking="))).toBe(true);
  });

  it("asks a signed-in account to choose, and assumes nobody until it does", async () => {
    render(<SearchClient sports={["archery"]} start={{ sport: "archery", date: DATE }} />);
    await act(async () => {});
    const picker = screen.getByTestId("taking-picker");
    expect(within(picker).getAllByRole("button").map((b) => b.textContent)).toEqual(["Myself", "Aisha", "Ben"]);
    expect(within(picker).getByText(/Choose who is taking part/)).toBeTruthy();
    expect(badge().textContent).toBe("needs the venue's sign-off");
    expect(badge().getAttribute("data-eligibility")).toBeNull();
    expect(searches().every((u) => !u.includes("taking="))).toBe(true);
  });

  it("names one child's status, then each of two, never the pair as approved when one is not", async () => {
    render(<SearchClient sports={["archery"]} start={{ sport: "archery", date: DATE }} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Aisha" })));
    expect(searches().at(-1)).toContain(`taking=${AISHA}`);
    expect(badge().textContent).toBe("Aisha: approved");
    expect(badge().getAttribute("data-eligibility")).toBe("eligible");
    // Kept for this tab, and only for it.
    expect(window.sessionStorage.getItem("mysenam.taking")).toBe(`${AISHA}`);
    expect(screen.getByText(/the venue checks again when you book/)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ben" })));
    expect(searches().at(-1)).toContain(`taking=${AISHA}%2C${BEN}`);
    expect(badge().textContent).toBe("Aisha: approved; Ben: approval required");
    expect(badge().getAttribute("data-eligibility")).toBe("not-all");
    expect(screen.getByRole("button", { name: "Ben" }).getAttribute("aria-pressed")).toBe("true");

    // Both off again: back to the requirement.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Aisha" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ben" })));
    expect(window.sessionStorage.getItem("mysenam.taking")).toBeNull();
    expect(badge().textContent).toBe("needs the venue's sign-off");
  });

  it("names the account holder themself as 'You', from the tab's earlier choice", async () => {
    window.sessionStorage.setItem("mysenam.taking", "self");
    render(<SearchClient sports={["archery"]} start={{ sport: "archery", date: DATE }} />);
    await act(async () => {});
    expect(searches()[0]).toContain("taking=self");
    expect(screen.getByRole("button", { name: "Myself" }).getAttribute("aria-pressed")).toBe("true");
    expect(badge().textContent).toBe("You: in-person assessment due");
  });

  it("forgets a choice once the account is signed out", async () => {
    window.sessionStorage.setItem("mysenam.taking", `self,${AISHA}`);
    signedIn = false;
    render(<SearchClient sports={["archery"]} start={{ sport: "archery", date: DATE }} />);
    await act(async () => {});
    expect(window.sessionStorage.getItem("mysenam.taking")).toBeNull();
    expect(searches().at(-1)).not.toContain("taking=");
    expect(badge().textContent).toBe("needs the venue's sign-off");
  });
});

describe("the label itself", () => {
  it("says each status in the customer's language, a certification as a certification", () => {
    const ms = makeT("ms");
    render(
      <>
        <NeedsLabel t={ms} needs="signOff" lines={[{ participant: null, status: "pending" }, { participant: 9, status: "expired" }]} people={[{ id: 9, displayName: "Chen" }]} />
        <NeedsLabel t={makeT("en")} needs="certification" lines={[{ participant: null, status: "required" }]} variant="line" />
        <NeedsLabel t={makeT("zh")} needs="signOff" lines={[{ participant: null, status: "info" }]} />
        <NeedsLabel t={makeT("ta")} needs="signOff" lines={[{ participant: null, status: "eligible" }]} />
      </>
    );
    expect(screen.getByText("Anda: permohonan menunggu semakan; Chen: kelulusan telah tamat tempoh")).toBeTruthy();
    expect(screen.getByText("You: certification required")).toBeTruthy();
    expect(screen.getByText("您：需补充资料")).toBeTruthy();
    expect(screen.getByText("நீங்கள்: ஒப்புதல் கிடைத்தது")).toBeTruthy();
  });
});

describe("the venue's grid", () => {
  const HOURLY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 240, lengths: null, defaultLength: 60, noticeMinutes: 0 };
  const row = (needs: "signOff" | null) => ({
    court: { ...LANE, id: needs ? 5 : 6, name: needs ? "Lane 1" : "Practice net", sport: "archery" },
    grid: 60,
    unit: 1,
    policy: { ...HOURLY, needs },
    slots: [8, 9, 10].map((hour) => ({ minute: hour * 60, hour, available: true, rate: 20, booked: 0, capacity: 1, blocked: false, className: null })),
    starts: [8, 9, 10].map((h) => ({ minute: h * 60, maxLength: 180 })),
  });
  const board = () =>
    render(
      <LanguageProvider locale="en">
        <BookingBoard venueId={7} sports={["archery"]} dates={[DATE]} />
      </LanguageProvider>
    );

  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = new URL(String(url), "http://localhost");
      if (u.pathname === "/api/my/people") return json({ people: PEOPLE, own: null });
      if (u.pathname === "/api/auth/me") return json({ user: null });
      if (u.pathname === "/api/availability")
        return json({
          availability: [row("signOff"), row(null)],
          closure: null,
          memberRates: false,
          ...(u.searchParams.get("taking")
            ? { eligibility: { signOff: [{ participant: null, status: "required" }, { participant: AISHA, status: "eligible" }] } }
            : {}),
        });
      return json({});
    });
  });

  it("follows the choice made on the search page", async () => {
    window.sessionStorage.setItem("mysenam.taking", `self,${AISHA}`);
    await act(async () => void board());
    const asked = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.startsWith("/api/availability"))!;
    expect(asked).toContain(`taking=self,${AISHA}`);
    const labels = [...screen.getByRole("table").querySelectorAll("[data-needs]")];
    expect(labels.map((l) => l.textContent)).toEqual(["You: approval required; Aisha: approved"]);
    expect(labels[0].getAttribute("data-eligibility")).toBe("not-all");
  });

  it("says the requirement only when nobody was chosen, and asks nothing about the account", async () => {
    await act(async () => void board());
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.find((u) => u.startsWith("/api/availability"))).not.toContain("taking=");
    expect(urls.some((u) => u.startsWith("/api/my/people"))).toBe(false);
    const labels = [...screen.getByRole("table").querySelectorAll("[data-needs]")];
    expect(labels.map((l) => l.textContent)).toEqual(["needs the venue's sign-off"]);
  });
});
