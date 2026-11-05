// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AttentionPanel } from "../../src/components/admin/AttentionPanel";
import { RosterPanel } from "../../src/components/admin/RosterPanel";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { LanguageProvider } from "../../src/components/Language";
import type { ManagedVenue } from "../../src/components/admin/shared";

/**
 * The roster's screen (ADR 0036): a manager edits it, front desk sees it and cannot, the warnings say what is wrong, the
 * sessions without their supervisors are listed with what a manager does, and the needs-attention panel counts them.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
let posts: { url: string; body: Record<string, unknown> }[] = [];

const venue = { id: 4, name: "Range Hall", courts: [{ id: 11, name: "Lane 1", sport: "archery", venueId: 4 }] } as unknown as ManagedVenue;

const overview = {
  roles: [
    { id: 1, venueId: 4, key: "range_officer", name: "Range officer", builtin: true, qualification: "Range officer certificate", active: true },
    { id: 2, venueId: 4, key: "lifeguard", name: "Lifeguard", builtin: true, qualification: "Lifeguard certificate", active: true },
  ],
  people: [
    { kind: "staff", id: 7, name: "Ann Officer" },
    { kind: "coach", id: 3, name: "Coach Dina" },
  ],
  qualifications: [{ id: 5, venueId: 4, personKind: "staff", personId: 7, qualification: "Range officer certificate", reference: "RO-1", expiresOn: "2027-01-31", recordedByName: "Mira", createdAt: "x" }],
  shifts: [{ id: 9, roleId: 1, personKind: "staff", personId: 7, weekday: 2, fromMin: 540, toMin: 1020 }],
  exceptions: [],
  rules: [{ id: 2, venueId: 4, courtId: 11, activity: "archery", roleId: 1, needed: 1 }],
  flags: [{ kind: "expires", personKind: "staff", personId: 7, roleId: 1, shiftId: 9, qualification: "Range officer certificate", expiresOn: "2027-01-31" }],
};

const session = {
  kind: "booking",
  id: 40,
  code: "MS-ABC234",
  venueId: 4,
  courtId: 11,
  courtName: "Lane 1",
  sport: "archery",
  date: "2026-11-17",
  startMin: 660,
  endMin: 720,
  name: "Aziz Archer",
  roles: [{ roleId: 1, roleKey: "range_officer", roleName: "Range officer", needed: 1, gaps: [{ start: 660, end: 720 }] }],
};

beforeEach(() => {
  posts = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      posts.push({ url, body });
      if (url.includes("uncovered")) return json({ sessions: [] });
      return json({ ok: true, affected: body.action === "shift_remove" ? [session] : [] });
    }
    if (url.includes("/uncovered")) return json({ sessions: [session] });
    return json(overview);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the roster panel", () => {
  it("shows the roles, the rules, the week and what is wrong, in the staff language", async () => {
    render(
      <LanguageProvider locale="ms">
        <RosterPanel venue={venue} />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Siapa menyelia sesi" })).toBeTruthy();
    // The starter role in Malay; its qualification as the venue named it.
    expect(screen.getAllByText("Pegawai range").length).toBeGreaterThan(0);
    // The qualification that ends before shifts to come is said.
    expect(screen.getByText(/tamat pada 2027-01-31/)).toBeTruthy();
    // The shift is in the week's grid.
    expect(screen.getByRole("button", { name: /Buang syif Ann Officer/ })).toBeTruthy();
  });

  it("lets a manager take a shift off, and says what it left without a supervisor; nothing is cancelled", async () => {
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Remove Ann Officer's shift/ })));
    expect(posts[0]).toMatchObject({ url: "/api/admin/roster", body: { venueId: 4, action: "shift_remove", id: 9 } });
    expect(screen.getByText(/1 session now has nobody rostered to supervise it\. It stays booked/)).toBeTruthy();
  });

  it("adds a shift that runs past midnight as ending the next day", async () => {
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    const selects = screen.getAllByRole("combobox");
    const byLabel = (name: string) => selects.find((s) => s.getAttribute("aria-label") === name)!;
    // The shift form's person, role and weekday come first (the rules' own selects have other labels).
    const person = screen.getAllByLabelText("Person")[0];
    fireEvent.change(person, { target: { value: "coach:3" } });
    fireEvent.change(screen.getAllByLabelText("Role")[1], { target: { value: "1" } });
    fireEvent.change(byLabel("Weekday"), { target: { value: "5" } });
    fireEvent.change(screen.getAllByLabelText("Shift starts")[0], { target: { value: "22:00" } });
    fireEvent.change(screen.getAllByLabelText("Shift ends")[0], { target: { value: "06:00" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add a shift" })));
    expect(posts.at(-1)!.body).toMatchObject({ action: "shift_add", personKind: "coach", personId: 3, roleId: 1, weekday: 5, fromMin: 1320, toMin: 1800 });
  });

  it("is read-only for the front desk, which still sees the roster and the list", async () => {
    render(
      <StaffMayProvider may={{ roster: false, rosterDecide: false }}>
        <RosterPanel venue={venue} />
      </StaffMayProvider>
    );
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Who supervises sessions" })).toBeTruthy();
    expect(screen.getAllByText(/Ann Officer/).length).toBeGreaterThan(0);
    // Inside a disabled fieldset: no control can be used (a button is hidden by its style, a field is disabled).
    for (const control of screen.getAllByRole("combobox")) expect((control as HTMLSelectElement).disabled || !!control.closest("fieldset[disabled]")).toBe(true);
    expect(screen.getByText("Aziz Archer", { exact: false })).toBeTruthy();
  });

  it("lists a session without its supervisor and lets a manager cover it or let it stand with a reason", async () => {
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    expect(screen.getByText(/booking MS-ABC234, Aziz Archer/)).toBeTruthy();
    expect(screen.getByText(/Needs 1 × Range officer; short/)).toBeTruthy();
    // A reason is needed to let it stand.
    const stand = screen.getByRole("button", { name: "Let it stand" }) as HTMLButtonElement;
    expect(stand.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why it may stand without/), { target: { value: "Owner on the range" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Let it stand" })));
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/roster/uncovered", body: { action: "override", kind: "booking", id: 40, roleId: 1, reason: "Owner on the range" } });
  });
});

describe("the needs-attention panel", () => {
  it("counts the sessions without a supervisor, and says where they are decided", async () => {
    fetchMock.mockImplementation(async () => json({ open: [], recent: [], uncovered: [session] }));
    render(<AttentionPanel />);
    await act(async () => {});
    expect(screen.getByText("1 session has nobody rostered to supervise it")).toBeTruthy();
    expect(screen.getByText(/MS-ABC234: needs 1 × Range officer/)).toBeTruthy();
  });
});
