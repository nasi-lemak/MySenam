// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AccessEditor } from "../../src/components/admin/AccessEditor";
import { ParticipantsPanel } from "../../src/components/admin/ParticipantsPanel";
import { LanguageProvider } from "../../src/components/Language";

/**
 * Phone checks recommended, never required (docs/features/venue-operations.md#phone-checks-recommended-not-required):
 * where a venue relies on numbers (a members-only or private venue's list,
 * guardians recorded by name and number), the operator is told what phone
 * checks give, what happens without them and that they are recommended;
 * with them on, a line saying so; a public venue is told nothing.
 */

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url), "http://localhost");
      const key = Object.keys(routes).find((k) => `${u.pathname}${u.search}`.startsWith(k));
      return { ok: true, status: 200, json: async () => (key ? routes[key] : { ok: true }) };
    })
  );
}
afterEach(() => vi.unstubAllGlobals());

const access = (mode: "public" | "members" | "private", phoneChecks: boolean) => ({
  settings: { access: mode, listed: true, note: null },
  list: [],
  phoneChecks,
  guests: { perResident: 0, days: 3 },
});

async function openEditor(locale: "en" | "ms" = "en") {
  render(
    <LanguageProvider locale={locale}>
      <AccessEditor venueId={7} />
    </LanguageProvider>
  );
  await act(async () => void fireEvent.click(screen.getByRole("button")));
}

describe("a venue's access settings", () => {
  it("members only or private without phone checks: what they enable, what happens without them, and the recommendation", async () => {
    for (const mode of ["private", "members"] as const) {
      stub({ "/api/admin/venue-access": access(mode, false) });
      await openEditor();
      const note = screen.getByTestId("phone-check-advice");
      expect(note.textContent).toContain("Phone checks are recommended here, not required");
      expect(note.textContent).toContain("proves their number with a one-time code");
      expect(note.textContent).toContain("you link each resident's or member's account to their entry yourself");
      expect(note.textContent).toContain("ask whoever runs this site to switch phone checks on");
      expect(note.textContent).toContain("Nothing is switched on for you");
      document.body.innerHTML = "";
    }
  });

  it("with phone checks on, says so in a line; a public venue is told nothing, until private is chosen", async () => {
    stub({ "/api/admin/venue-access": access("private", true) });
    await openEditor();
    expect(screen.getByTestId("phone-check-advice").textContent).toBe(
      "Phone checks are on: a number proved with a one-time code counts online by itself; a number only typed on an account still counts for nothing."
    );
    document.body.innerHTML = "";

    stub({ "/api/admin/venue-access": access("public", false) });
    await openEditor();
    expect(screen.queryByTestId("phone-check-advice")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByLabelText(/Private/)));
    expect(screen.getByTestId("phone-check-advice").textContent).toContain("Phone checks are recommended here, not required");
  });

  it("is in the staff member's language", async () => {
    stub({ "/api/admin/venue-access": access("private", false) });
    await openEditor("ms");
    expect(screen.getByTestId("phone-check-advice").textContent).toContain("Semakan telefon disyorkan di sini, bukan diwajibkan");
  });
});

describe("guardians recorded by name and number", () => {
  const found = (claimsPossible: boolean) => ({ codesPossible: true, claimsPossible, participants: [] });

  async function lookUp(claimsPossible: boolean) {
    stub({ "/api/admin/participants?": found(claimsPossible) });
    render(<ParticipantsPanel venues={[{ id: 3, name: "Guardian Centre" } as never]} role="desk" />);
    await act(async () => void fireEvent.change(screen.getByLabelText("Guardian's phone number"), { target: { value: "0177000001" } }));
    await act(async () => void fireEvent.click(screen.getByText("Look up")));
  }

  it("without phone checks: claim codes need them, what staff do instead, and the recommendation", async () => {
    await lookUp(false);
    const note = screen.getByTestId("phone-check-advice");
    expect(note.textContent).toContain("cannot take the relationship over with an account");
    expect(note.textContent).toContain("invite their account as another guardian instead");
    expect(note.textContent).toContain("a manager records the guardian's agreement given in person");
    expect(note.textContent).toContain("switch phone checks on");
  });

  it("with them on, nothing extra", async () => {
    await lookUp(true);
    expect(screen.queryByTestId("phone-check-advice")).toBeNull();
  });
});
