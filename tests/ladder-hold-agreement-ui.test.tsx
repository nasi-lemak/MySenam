// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { AgreeAfterLook, HoldAgreement, type HoldLook } from "../src/components/HoldAgreement";
import { LOCALES, translator } from "../src/lib/i18n";

/**
 * The acceptance screen for a ladder challenge whose court the venue holds (ADR 0050): before the player agrees it shows the court that would be held (and says it
 * is only reserved if the hold succeeds), the day, start and duration, the charges (the hold is free and moves no money; the venue's own court hire terms apply; no price
 * is invented), and what it means (what releases it, what replaces it, what happens if the court becomes unavailable, what a later change they did not both agree does),
 * in all four languages. The preview equals the court actually held is proved against the real database in tests/ladder-agreement-and-active-holds.test.ts.
 */

const look: HoldLook = { applies: true, courtId: 7, court: "Court Seven", date: "2026-12-01", startMin: 18 * 60 + 45, endMin: 21 * 60, minutes: 135, effect: "confirmed", replaces: null };

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

afterEach(() => vi.unstubAllGlobals());

describe("what the acceptance screen shows before the tap", () => {
  for (const locale of LOCALES) {
    it(`says the court, the time, the duration, the charges and the implications, in ${locale}`, () => {
      const t = translator(locale, "Senam Courts");
      const { container } = render(<HoldAgreement t={t} look={look} kind="accept" name="Aisha" />);
      const text = container.textContent ?? "";
      expect(text).toContain("Court Seven");
      expect(text).toContain("2026-12-01");
      expect(text).toContain("18:45");
      expect(text).toContain("21:00");
      expect(text).toContain("135");
      // The sentences are the dictionary's own, filled with the site and the other player.
      for (const key of ["lad4.ui.title", "lad4.ui.courtNote", "lad4.ui.charges", "lad4.ui.implications", "lad4.ui.imp.release", "lad4.ui.imp.booking", "lad4.ui.imp.unavailable", "lad4.ui.imp.change"] as const)
        expect(text).toContain(t(key));
      expect(text).toContain(t("lad4.ui.effect.confirmed", { name: "Aisha" }));
      expect(text).toContain("Senam Courts");
      expect(text).not.toContain("{");
      expect(text).not.toContain("MySenam");
      // Four things it means, and a region a screen reader can name.
      expect(container.querySelectorAll("li")).toHaveLength(4);
      expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(t("lad4.ui.title"));
    });
  }

  it("says the hold is free and invents no price", () => {
    const t = translator("en", "Senam Courts");
    const { container } = render(<HoldAgreement t={t} look={look} kind="accept" name="Aisha" />);
    const text = container.textContent ?? "";
    expect(text).toContain("holding the court is free and moves no money");
    expect(text).toContain("court hire terms");
    expect(text).not.toMatch(/RM\s?\d/);
  });

  it("says what agreeing does: confirmed at once for an exact agreement, tentative for anything else, and for asking, that nothing is held until the other agrees", () => {
    const t = translator("en", "Senam Courts");
    const { container, rerender } = render(<HoldAgreement t={t} look={look} kind="accept" name="Aisha" />);
    expect(container.textContent).toContain("the court is confirmed as soon as it is held");
    rerender(<HoldAgreement t={t} look={{ ...look, effect: "tentative" }} kind="accept" name="Aisha" />);
    expect(container.textContent).toContain("held but tentative: both of you must confirm it");
    rerender(<HoldAgreement t={t} look={look} kind="propose_move" name="Aisha" />);
    expect(container.textContent).toContain("Nothing is held until they agree");
  });

  it("names the court it would replace when the challenge already has one", () => {
    const t = translator("en", "Senam Courts");
    const { container } = render(<HoldAgreement t={t} look={{ ...look, replaces: { court: "Court Two", date: "2026-11-28", startMin: 19 * 60 } }} kind="agree_move" name="Aisha" />);
    expect(container.textContent).toContain("This replaces the court held now: Court Two, 2026-11-28 at 19:00.");
  });
});

describe("looking first, then agreeing", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("asks for the look, shows it, and the act then carries the court that was shown; 'not now' changes nothing", async () => {
    const fetch = vi.fn(async () => json({ preview: look }));
    vi.stubGlobal("fetch", fetch);
    const onGo = vi.fn(async () => true);
    const t = translator("en", "Senam Courts");
    render(<AgreeAfterLook t={t} url="/api/ladders/1/challenges/2" kind="accept" name="Aisha" check={t("lad4.ui.check")} go={t("lad4.ui.go")} onGo={onGo} />);
    // Nothing is shown, and nothing is sent, until the player asks to check.
    expect(screen.queryByText("Check before you agree")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check the court and accept" }));
    await screen.findByText("Court: Court Seven");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/ladders/1/challenges/2");
    expect(JSON.parse(init.body)).toEqual({ action: "preview_hold", for: "accept" });
    expect(onGo).not.toHaveBeenCalled();
    // Not now: back to the first button, nothing agreed.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Court: Court Seven")).toBeNull();
    expect(onGo).not.toHaveBeenCalled();
    // Check again, then accept: the act is told the court it was shown.
    fireEvent.click(screen.getByRole("button", { name: "Check the court and accept" }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept this exact time" }));
    await waitFor(() => expect(onGo).toHaveBeenCalledWith(7));
  });

  it("asking for a move sends the day and time to look at, and acts only when the player says so", async () => {
    const fetch = vi.fn(async () => json({ preview: { ...look, replaces: { court: "Court Two", date: "2026-11-28", startMin: 19 * 60 } } }));
    vi.stubGlobal("fetch", fetch);
    const onGo = vi.fn(async () => true);
    const t = translator("en", "Senam Courts");
    render(<AgreeAfterLook t={t} url="/u" kind="propose_move" name="Aisha" when={{ onDate: "2026-12-01", minute: 1125 }} check={t("lad4.ui.checkAsk", { name: "Aisha" })} go={t("lad4.ui.goAsk")} onGo={onGo} />);
    fireEvent.click(screen.getByRole("button", { name: "Check the court and ask Aisha" }));
    await screen.findByText("Court: Court Seven");
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ action: "preview_hold", for: "propose_move", onDate: "2026-12-01", minute: 1125 });
    expect(onGo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send the request" }));
    await waitFor(() => expect(onGo).toHaveBeenCalledWith(7));
  });

  it("a refusal is shown in the application's words and nothing is agreed; where no court would be held there is nothing to show and the act is made straight away", async () => {
    const t = translator("en", "Senam Courts");
    const onGo = vi.fn(async () => true);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The court shown, Court Seven, is no longer free on 2026-12-01 at 18:45, so nothing was held and nothing has changed.", code: "LAD4_COURT_CHANGED", vars: { court: "Court Seven", date: "2026-12-01", time: "18:45" } }, 409)));
    const { unmount } = render(<AgreeAfterLook t={t} url="/u" kind="accept" name="Aisha" check="Check" go="Go" onGo={onGo} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect((await screen.findByRole("alert")).textContent).toContain("is no longer free");
    expect(onGo).not.toHaveBeenCalled();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => json({ preview: { applies: false } })));
    render(<AgreeAfterLook t={t} url="/u" kind="accept" name="Aisha" check="Check" go="Go" onGo={onGo} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(onGo).toHaveBeenCalledWith(null));
  });
});
