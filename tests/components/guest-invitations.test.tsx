// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/login" }));

import GuestInvitationPage from "../../src/app/guest-invitation/page";
import LoginPage from "../../src/app/login/page";
import { GuestInvites } from "../../src/components/GuestInvites";
import { LanguageProvider } from "../../src/components/Language";
import { translator } from "../../src/lib/i18n";

/**
 * The resident's guest screen and the page an emailed invitation opens
 * (lib/guest-invites.ts). The resident is told the same thing whether or not
 * the address they gave has an account; the guest accepts signed in.
 */

const en = translator("en");
type Reply = { status: number; body: unknown };
let replies: Record<string, Reply | ((init?: RequestInit) => Reply)>;
let calls: { path: string; init?: RequestInit }[];

beforeEach(() => {
  replies = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url), "http://localhost").pathname;
      calls.push({ path, init });
      const found = replies[`${init?.method ?? "GET"} ${path}`];
      const reply = typeof found === "function" ? found(init) : (found ?? { status: 200, body: {} });
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const guest = (id: number, name: string, linked: boolean, invited: boolean) => ({ id, phone: `01300000${id}`, name, expiresOn: "2026-10-30", linked, invited });
const venue = (guests: ReturnType<typeof guest>[]) => ({ id: 7, name: "Kondo Tujuh", policy: { perResident: 5, days: 3 }, guests });

describe("the resident's guest screen", () => {
  it("shows each guest as linked, invitation sent, or not linked", async () => {
    replies["GET /api/my/guests"] = {
      status: 200,
      body: { venues: [venue([guest(1, "Ali", false, true), guest(2, "Mei", true, false), guest(3, "Raj", false, false)])], phoneChecks: false },
    };
    render(
      <LanguageProvider locale="en">
        <GuestInvites />
      </LanguageProvider>
    );
    const row = async (name: string) => (await screen.findByText(name, { exact: false })).closest("li")!.textContent!;
    expect(await row("Ali")).toContain(en("gi6.invitationSent"));
    expect(await row("Mei")).toContain(en("acc5.linked"));
    expect(await row("Mei")).not.toContain(en("gi6.invitationSent"));
    expect(await row("Raj")).toContain(en("acc5.notLinked"));
  });

  it("says the same neutral thing after inviting with an email, whatever the server knows", async () => {
    const shown: string[] = [];
    for (const linkedOnServer of [false, true]) {
      replies["GET /api/my/guests"] = { status: 200, body: { venues: [venue([])], phoneChecks: false } };
      // Even a server that said more would not change the words: the screen reads nothing about the address back.
      replies["POST /api/my/guests"] = {
        status: 201,
        body: { guest: guest(4, "Visitor", linkedOnServer, true), venues: [venue([guest(4, "Visitor", false, true)])], phoneChecks: false },
      };
      const { unmount } = render(
        <LanguageProvider locale="en">
          <GuestInvites />
        </LanguageProvider>
      );
      fireEvent.click(await screen.findByRole("button", { name: en("guests.invite") }));
      fireEvent.change(screen.getByLabelText(en("guests.phone")), { target: { value: "0130000004" } });
      fireEvent.change(screen.getByLabelText(en("guests.name")), { target: { value: "Visitor" } });
      fireEvent.change(screen.getByLabelText(en("gi6.email")), { target: { value: "visitor@example.my" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en("guests.add") }));
      });
      const note = await screen.findByText(/Invitation submitted/);
      shown.push(note.textContent!);
      unmount();
    }
    expect(shown[0]).toBe(en("gi6.sent", { name: "Visitor" }));
    expect(shown[1]).toBe(shown[0]);
    const posted = JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(posted).toMatchObject({ venueId: 7, phone: "0130000004", email: "visitor@example.my" });
  });
});

describe("the invitation page", () => {
  const token = "t".repeat(32);

  it("asks somebody signed out to sign in or make an account, and to come back", async () => {
    window.history.replaceState({}, "", `/guest-invitation?token=${token}`);
    replies["GET /api/auth/me"] = { status: 200, body: { user: null } };
    render(
      <LanguageProvider locale="en">
        <GuestInvitationPage />
      </LanguageProvider>
    );
    const signIn = await screen.findByRole("link", { name: en("gi6.signIn") });
    const back = encodeURIComponent(`/guest-invitation?token=${token}`);
    expect(signIn.getAttribute("href")).toBe(`/login?next=${back}`);
    expect(screen.getByRole("link", { name: en("gi6.register") }).getAttribute("href")).toBe(`/login?mode=register&next=${back}`);
    expect(screen.queryByRole("button", { name: en("gi6.accept") })).toBeNull();
  });

  it("accepts on a tap, signed in, and says where the guest can now book", async () => {
    window.history.replaceState({}, "", `/guest-invitation?token=${token}`);
    replies["GET /api/auth/me"] = { status: 200, body: { user: { id: 3, name: "Ali", email: "ali@example.my" } } };
    replies["POST /api/guest-invitations"] = { status: 200, body: { venue: { id: 7, name: "Kondo Tujuh" }, expiresOn: "2026-10-30" } };
    render(
      <LanguageProvider locale="en">
        <GuestInvitationPage />
      </LanguageProvider>
    );
    const button = await screen.findByRole("button", { name: en("gi6.accept") });
    expect(calls.some((c) => c.path === "/api/guest-invitations")).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByText(en("gi6.accepted", { venue: "Kondo Tujuh", until: "2026-10-30" }))).toBeTruthy();
    expect(screen.getByRole("link", { name: en("gi6.openVenue", { venue: "Kondo Tujuh" }) }).getAttribute("href")).toBe("/venue/7");
    expect(JSON.parse(String(calls.find((c) => c.path === "/api/guest-invitations")!.init!.body))).toEqual({ token });
  });

  it("gives the one neutral answer when the link cannot be used", async () => {
    window.history.replaceState({}, "", `/guest-invitation?token=${token}`);
    replies["GET /api/auth/me"] = { status: 200, body: { user: { id: 3, name: "Ali", email: "ali@example.my" } } };
    replies["POST /api/guest-invitations"] = {
      status: 404,
      body: { ok: false, error: en("err.GUEST_INVITATION_INVALID"), code: "GUEST_INVITATION_INVALID" },
    };
    render(
      <LanguageProvider locale="ms">
        <GuestInvitationPage />
      </LanguageProvider>
    );
    const button = await screen.findByRole("button", { name: translator("ms")("gi6.accept") });
    await act(async () => {
      fireEvent.click(button);
    });
    expect((await screen.findByRole("alert")).textContent).toBe(translator("ms")("err.GUEST_INVITATION_INVALID"));
  });

  it("sends somebody without an account to the sign-up form, which opens on it", async () => {
    window.history.replaceState({}, "", `/login?mode=register&next=${encodeURIComponent(`/guest-invitation?token=${token}`)}`);
    replies["GET /api/auth/providers"] = { status: 200, body: { google: false } };
    render(
      <LanguageProvider locale="en">
        <LoginPage />
      </LanguageProvider>
    );
    expect(await screen.findByRole("heading", { name: en("auth.createAccount") })).toBeTruthy();
  });

  it("says the link is incomplete when it carries no token", async () => {
    window.history.replaceState({}, "", "/guest-invitation");
    replies["GET /api/auth/me"] = { status: 200, body: { user: null } };
    render(
      <LanguageProvider locale="en">
        <GuestInvitationPage />
      </LanguageProvider>
    );
    expect(await screen.findByText(en("gi6.noToken"))).toBeTruthy();
  });
});
