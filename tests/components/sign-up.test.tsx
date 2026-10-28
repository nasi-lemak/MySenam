// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/login" }));

import LoginPage from "../../src/app/login/page";
import RegisterPage from "../../src/app/register/page";
import { LanguageProvider } from "../../src/components/Language";
import { translator } from "../../src/lib/i18n";
import { REGISTRATION_MINUTES, SIGN_UP_NEXT } from "../../src/lib/registration-shared";

/**
 * Signing up in two steps (lib/registration.ts): the form asks for the email
 * address only and always says "check your email"; the emailed link opens a
 * page that shows the address and asks for the rest.
 */

const en = translator("en");
const ms = translator("ms");
type Reply = { status: number; body: unknown };
let replies: Record<string, Reply | ((init?: RequestInit) => Reply)>;
let calls: { path: string; init?: RequestInit }[];

beforeEach(() => {
  replies = { "GET /api/auth/providers": { status: 200, body: { google: false } } };
  calls = [];
  router.push.mockClear();
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
  window.localStorage.clear();
});

const sentBody = (path: string) => JSON.parse(String(calls.find((c) => c.path === path)!.init!.body));

describe("the sign-up form", () => {
  it("asks for the email address only, and says the same whatever the server knows", async () => {
    window.history.replaceState({}, "", `/login?mode=register&next=${encodeURIComponent("/games/groups/7")}`);
    replies["POST /api/auth/register"] = { status: 202, body: { ok: true } };
    render(
      <LanguageProvider locale="en">
        <LoginPage />
      </LanguageProvider>
    );
    expect(await screen.findByRole("heading", { name: en("auth.createAccount") })).toBeTruthy();
    expect(screen.queryByLabelText(en("auth.password"))).toBeNull();
    expect(screen.queryByLabelText(en("auth.name"))).toBeNull();
    expect(screen.queryByLabelText(en("auth.phone"))).toBeNull();
    fireEvent.change(screen.getByLabelText(en("auth.email")), { target: { value: " aina@example.my " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en("su7.send") }));
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(en("su7.checkTitle"));
    expect(status.textContent).toContain(en("su7.check", { email: "aina@example.my", minutes: REGISTRATION_MINUTES }));
    expect(sentBody("/api/auth/register")).toEqual({ email: "aina@example.my", website: "", locale: "en" });
    // Nobody was signed in or sent anywhere; where to go afterwards waits in this browser.
    expect(router.push).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SIGN_UP_NEXT)).toBe("/games/groups/7");
    // Another address: the form again.
    fireEvent.click(screen.getByRole("button", { name: en("su7.otherAddress") }));
    expect(screen.getByLabelText(en("auth.email"))).toBeTruthy();
  });

  it("says too many tries when the client is limited, in the page's language", async () => {
    window.history.replaceState({}, "", "/login?mode=register");
    replies["POST /api/auth/register"] = { status: 429, body: { error: "Too many attempts. Please wait a moment and try again." } };
    render(
      <LanguageProvider locale="ms">
        <LoginPage />
      </LanguageProvider>
    );
    fireEvent.change(await screen.findByLabelText(ms("auth.email")), { target: { value: "aina@example.my" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ms("su7.send") }));
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(sentBody("/api/auth/register").locale).toBe("ms");
  });

  it("still signs in with email and password", async () => {
    window.history.replaceState({}, "", "/login");
    replies["POST /api/auth/login"] = { status: 200, body: { user: { id: 1 } } };
    render(
      <LanguageProvider locale="en">
        <LoginPage />
      </LanguageProvider>
    );
    fireEvent.change(await screen.findByLabelText(en("auth.email")), { target: { value: "aina@example.my" } });
    fireEvent.change(screen.getByLabelText(en("auth.password")), { target: { value: "a password" } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: en("auth.signIn") }).at(-1)!);
    });
    expect(sentBody("/api/auth/login")).toEqual({ email: "aina@example.my", password: "a password" });
    expect(router.push).toHaveBeenCalledWith("/account");
  });
});

describe("the page the emailed link opens", () => {
  const token = "t".repeat(32);

  it("shows the address, takes the rest, and goes back where the sign-up started", async () => {
    window.history.replaceState({}, "", `/register?token=${token}`);
    window.localStorage.setItem(SIGN_UP_NEXT, "/games/groups/7");
    replies["POST /api/auth/register/link"] = { status: 200, body: { email: "aina@example.my" } };
    replies["POST /api/auth/register/complete"] = { status: 201, body: { user: { id: 9 } } };
    render(
      <LanguageProvider locale="en">
        <RegisterPage />
      </LanguageProvider>
    );
    expect(await screen.findByText(en("su7.finishIntro", { email: "aina@example.my" }))).toBeTruthy();
    expect(sentBody("/api/auth/register/link")).toEqual({ token });
    fireEvent.change(screen.getByLabelText(en("auth.name")), { target: { value: "Nur Aina" } });
    fireEvent.change(screen.getByLabelText(en("auth.phone")), { target: { value: "0123456789" } });
    fireEvent.change(screen.getByLabelText(en("auth.password")), { target: { value: "a long enough password" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en("auth.creating") }));
    });
    expect(sentBody("/api/auth/register/complete")).toEqual({ token, name: "Nur Aina", phone: "0123456789", password: "a long enough password" });
    expect(router.push).toHaveBeenCalledWith("/games/groups/7");
    expect(window.localStorage.getItem(SIGN_UP_NEXT)).toBeNull();
  });

  it("goes to the account page when it is opened in another browser", async () => {
    window.history.replaceState({}, "", `/register?token=${token}`);
    replies["POST /api/auth/register/link"] = { status: 200, body: { email: "aina@example.my" } };
    replies["POST /api/auth/register/complete"] = { status: 201, body: { user: { id: 9 } } };
    render(
      <LanguageProvider locale="en">
        <RegisterPage />
      </LanguageProvider>
    );
    await screen.findByText(en("su7.finishIntro", { email: "aina@example.my" }));
    fireEvent.change(screen.getByLabelText(en("auth.name")), { target: { value: "Nur Aina" } });
    fireEvent.change(screen.getByLabelText(en("auth.phone")), { target: { value: "0123456789" } });
    fireEvent.change(screen.getByLabelText(en("auth.password")), { target: { value: "a long enough password" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en("auth.creating") }));
    });
    expect(router.push).toHaveBeenCalledWith("/account");
  });

  it("gives the one neutral answer for a link that cannot be used, with sign-in and a new link", async () => {
    window.history.replaceState({}, "", `/register?token=${token}`);
    replies["POST /api/auth/register/link"] = { status: 400, body: { ok: false, error: en("err.REGISTRATION_INVALID"), code: "REGISTRATION_INVALID" } };
    render(
      <LanguageProvider locale="ms">
        <RegisterPage />
      </LanguageProvider>
    );
    expect((await screen.findByRole("alert")).textContent).toBe(ms("err.REGISTRATION_INVALID"));
    expect(screen.getByRole("link", { name: ms("su7.signIn") }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: ms("su7.startAgain") }).getAttribute("href")).toBe("/login?mode=register");
    expect(screen.queryByLabelText(ms("auth.password"))).toBeNull();
  });

  it("says the same when the link is used up while the form is open (another tab, Google)", async () => {
    window.history.replaceState({}, "", `/register?token=${token}`);
    replies["POST /api/auth/register/link"] = { status: 200, body: { email: "aina@example.my" } };
    replies["POST /api/auth/register/complete"] = { status: 400, body: { ok: false, error: en("err.REGISTRATION_INVALID"), code: "REGISTRATION_INVALID" } };
    render(
      <LanguageProvider locale="en">
        <RegisterPage />
      </LanguageProvider>
    );
    await screen.findByText(en("su7.finishIntro", { email: "aina@example.my" }));
    fireEvent.change(screen.getByLabelText(en("auth.name")), { target: { value: "Nur Aina" } });
    fireEvent.change(screen.getByLabelText(en("auth.phone")), { target: { value: "0123456789" } });
    fireEvent.change(screen.getByLabelText(en("auth.password")), { target: { value: "a long enough password" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en("auth.creating") }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(en("err.REGISTRATION_INVALID"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows a refusal of what was typed beside the form", async () => {
    window.history.replaceState({}, "", `/register?token=${token}`);
    replies["POST /api/auth/register/link"] = { status: 200, body: { email: "aina@example.my" } };
    replies["POST /api/auth/register/complete"] = { status: 400, body: { ok: false, error: "Please provide a valid phone number." } };
    render(
      <LanguageProvider locale="ms">
        <RegisterPage />
      </LanguageProvider>
    );
    await screen.findByText(ms("su7.finishIntro", { email: "aina@example.my" }));
    fireEvent.change(screen.getByLabelText(ms("auth.name")), { target: { value: "Nur Aina" } });
    fireEvent.change(screen.getByLabelText(ms("auth.phone")), { target: { value: "0123456789" } });
    fireEvent.change(screen.getByLabelText(ms("auth.password")), { target: { value: "a long enough password" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ms("auth.creating") }));
    });
    expect(await screen.findByText("Sila berikan nombor telefon yang sah.")).toBeTruthy();
    expect(screen.getByLabelText(ms("auth.name"))).toBeTruthy();
  });

  it("says the link is incomplete when it carries no token", async () => {
    window.history.replaceState({}, "", "/register");
    render(
      <LanguageProvider locale="en">
        <RegisterPage />
      </LanguageProvider>
    );
    expect(await screen.findByText(en("su7.noToken"))).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/auth/register/link")).toBe(false);
  });
});
