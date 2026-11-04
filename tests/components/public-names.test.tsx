// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import PublicNamesPanel from "../../src/components/PublicNames";
import { LanguageProvider } from "../../src/components/Language";

/**
 * A guardian's page for what the public sees of a child's name (lib/public-name-consents.ts; docs/architecture/privacy.md#minors-names-on-public-pages):
 * the plain explanation, nothing on until the box is ticked, the choice of one event or one venue, the wording's language sent with it,
 * and each authorisation in force with a way to withdraw it.
 */

let calls: { url: string; method: string; body: Record<string, unknown> | null }[];

function stub(view: unknown) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: init?.method === "POST" ? 201 : 200, json: async () => (init?.method === "POST" ? { ok: true } : view) };
    })
  );
}
afterEach(() => vi.unstubAllGlobals());

const KID = { id: 41, displayName: "Aina Quillfeather" };
const VIEW = {
  participant: KID,
  choices: [{ kind: "tournament", id: 7, name: "Spring Cup", venueId: 3, venueName: "Subang Hall", until: "2026-11-20" }],
  venues: [{ id: 3, name: "Subang Hall" }],
  consents: [],
  months: 12,
};

function open() {
  return render(
    <LanguageProvider locale="en">
      <PublicNamesPanel person={KID} />
    </LanguageProvider>
  );
}

describe("names on public pages, for a guardian", () => {
  it("explains what is public and what the guardian may allow, and sends nothing until the box is ticked", async () => {
    stub(VIEW);
    open();
    await act(async () => {});
    expect(screen.getByText(/by first name and the initial of the next name/)).toBeTruthy();
    expect(screen.getByText(/You can withdraw it at any time/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Allow the full name" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Allow the full name for"), { target: { value: "tournament:7" } });
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button.disabled).toBe(false);
    await act(async () => void fireEvent.click(button));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      url: "/api/my/people/public-name",
      method: "POST",
      body: { action: "authorise", id: 41, confirm: true, locale: "en", scope: "event", kind: "tournament", eventId: 7 },
    });
  });

  it("can allow every entry at a venue, and withdraws what is in force", async () => {
    stub({ ...VIEW, consents: [{ id: 5, participantId: 41, scope: "event", venueId: 3, venueName: "Subang Hall", eventKind: "tournament", eventId: 7, eventName: "Spring Cup", grantedAt: "", expiresAt: "2026-11-20T16:00:00.000Z", byYou: true, wording: "", wordingLocale: "en" }] });
    open();
    await act(async () => {});
    expect(screen.getByText(/Spring Cup at Subang Hall: until the event or season ends, or you withdraw it/)).toBeTruthy();
    expect(screen.getByText("All Aina Quillfeather's entries at Subang Hall, for 12 months", { selector: "option" })).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Withdraw: Spring Cup/ })));
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/api/my/people/public-name", method: "POST", body: { action: "withdraw", consentId: 5 } });
  });

  it("says there is nothing to allow when the child holds no place anywhere", async () => {
    stub({ ...VIEW, choices: [], venues: [] });
    open();
    await act(async () => {});
    expect(screen.getByText(/has no place in an event, league or ladder just now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow the full name" })).toBeNull();
  });
});
