// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AttentionPanel } from "../../src/components/admin/AttentionPanel";
import { RosterPanel, supervisorsText } from "../../src/components/admin/RosterPanel";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { WindowOverridesPanel } from "../../src/components/admin/WindowOverridesPanel";
import { LanguageProvider } from "../../src/components/Language";
import { staffTranslator } from "../../src/lib/staff-i18n";
import type { ManagedVenue } from "../../src/components/admin/shared";

/**
 * The screens of ADR 0046: a role's qualification level and the check of its effect, the flag that a recommended qualification is not
 * recorded (advisory), no "let it stand" for a legal requirement; the manager's report of overrides of advisory windows, the venue's
 * settings for them, and the needs-attention line past the limit.
 */

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
let posts: { url: string; body: Record<string, unknown> }[] = [];

const venue = { id: 4, name: "Range Hall", courts: [{ id: 11, name: "Lane 1", sport: "archery", venueId: 4 }] } as unknown as ManagedVenue;
const role = (over: Record<string, unknown>) => ({ id: 1, venueId: 4, key: "range_officer", name: "Range officer", builtin: true, qualification: "Range officer certificate", qualificationLevel: "venue_required", qualificationReference: null, active: true, ...over });
const overview = (roles: unknown[], flags: unknown[] = []) => ({
  roles,
  people: [{ kind: "staff", id: 7, name: "Ann Officer" }],
  qualifications: [],
  shifts: [{ id: 9, roleId: 3, personKind: "staff", personId: 7, weekday: 2, fromMin: 540, toMin: 1020 }],
  exceptions: [],
  rules: [],
  flags,
});
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
const advisory = {
  kind: "booking",
  id: 41,
  code: "MS-XYZ789",
  courtName: "Lane 1",
  date: "2026-11-18",
  startMin: 600,
  endMin: 660,
  name: "Bea Bow",
  people: [{ roleKey: "instructor", roleName: "Instructor", personName: "Ann Officer", qualification: "Instructor certificate", why: "not_recorded" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("a role's qualification level", () => {
  const stub = (roles: unknown[], flags: unknown[] = [], uncovered: unknown[] = [], gaps: unknown[] = []) => {
    posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}"));
          posts.push({ url, body });
          if (body.action === "role_preview") return json({ ok: true, preview: { shiftsWithoutIt: 3, becomeUncovered: [session], becomeCovered: [] } });
          return json({ ok: true, affected: [] });
        }
        if (url.includes("/uncovered")) return json({ sessions: uncovered, advisory: gaps });
        return json(overview(roles, flags));
      })
    );
  };

  it("shows how firmly each role's qualification is asked", async () => {
    stub([role({}), role({ id: 3, key: "instructor", name: "Instructor", qualification: "Instructor certificate", qualificationLevel: "recommended" })]);
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    expect(screen.getByText("asks for Range officer certificate (Required by the venue)")).toBeTruthy();
    expect(screen.getByText("asks for Instructor certificate (Recommended)")).toBeTruthy();
  });

  it("checks what a change would do before it is made, and sends the level and the legal reference when saved", async () => {
    stub([role({})]);
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    const levelSelect = screen.getByLabelText("How firmly Range officer's qualification is asked");
    await act(async () => void fireEvent.change(levelSelect, { target: { value: "legally_required" } }));
    // A legal requirement asks for the venue's reference or wording.
    await act(async () => void fireEvent.change(screen.getByLabelText("Reference or wording of the legal requirement"), { target: { value: "Reg 12" } }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Check the effect" })));
    expect(posts[0].body).toMatchObject({ action: "role_preview", id: 1, qualificationLevel: "legally_required", qualificationReference: "Reg 12" });
    expect(screen.getByRole("status").textContent).toMatch(/3 rostered shifts are held by somebody without it recorded/);
    expect(screen.getByRole("status").textContent).toMatch(/1 session to come would be left without enough people counted/);
    await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]));
    expect(posts[1].body).toMatchObject({ action: "role_save", id: 1, qualificationLevel: "legally_required", qualificationReference: "Reg 12" });
  });

  it("says a flag on a recommended qualification is a reminder, and one on a required one blocks", async () => {
    const flag = (roleId: number, counts: boolean, level: string) => ({ kind: "no_qualification", personKind: "staff", personId: 7, roleId, shiftId: 9, qualification: "X cert", level, counts });
    stub([role({ id: 3, key: "instructor", name: "Instructor", qualificationLevel: "recommended" }), role({})], [flag(3, true, "recommended"), flag(1, false, "venue_required")]);
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    expect(screen.getByText(/It is recommended, not required: their shifts count, and this is a reminder/)).toBeTruthy();
    expect(screen.getByText(/their shifts in this role are not counted until it is/)).toBeTruthy();
  });

  it("lists sessions covered by somebody a recommended qualification is not recorded for, apart from those without cover", async () => {
    stub([role({})], [], [], [advisory]);
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    expect(screen.getByText("Supervised, but a recommended qualification is not recorded")).toBeTruthy();
    expect(screen.getByText("Instructor: Ann Officer has no Instructor certificate recorded")).toBeTruthy();
  });

  it("offers no 'let it stand' for a role whose qualification is a legal requirement", async () => {
    stub([role({ qualificationLevel: "legally_required", qualificationReference: "Reg 12" })], [], [session]);
    render(<RosterPanel venue={venue} />);
    await act(async () => {});
    expect(screen.getByText(/a session cannot be let stand without it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Let it stand" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cover it" })).toBeTruthy();
  });

  it("says on a booking's supervisor line that a recommended qualification is not recorded", () => {
    const t = staffTranslator("en");
    expect(supervisorsText(t, [{ role: "Instructor", roleKey: "instructor", person: "Ann Officer", how: "rostered", qualification: { why: "not_recorded", qualification: "Instructor certificate" } }])).toBe(
      "Supervisor: Instructor: Ann Officer (recommended qualification not recorded)"
    );
    expect(supervisorsText(t, [{ role: "Instructor", roleKey: "instructor", person: "Ann Officer", how: "rostered" }])).toBe("Supervisor: Instructor: Ann Officer");
  });
});

describe("the manager's report of overrides of advisory windows", () => {
  const report = {
    settings: { enabled: true, reasonMin: 15, weeklyAlert: 5, own: { reasonMin: false, weeklyAlert: false } },
    days: 30,
    alert: { count: 6, limit: 5 },
    overrides: [
      { id: 1, bookingCode: "MS-ABC123", classId: null, who: "Paddler Pat", courtName: "Kayak 1", date: "2026-11-12", startMin: 720, endMin: 780, code: "LAUNCH_WINDOW", action: "booked", window: "7:10 AM–10:40 AM", reason: "Guests asked for the late tide", adminName: "Mina Manager", ruleId: 3, createdAt: "2026-11-05T09:30:00.000Z" },
    ],
  };

  const stub = () => {
    posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
          return json({ settings: report.settings });
        }
        return json(report);
      })
    );
  };

  it("lists each override with who, when, why and the window, and the alert past the limit", async () => {
    stub();
    render(<WindowOverridesPanel venueId={4} />);
    await act(async () => {});
    expect(screen.getByText("Overrides of advisory windows: 1 in the last 30 days")).toBeTruthy();
    expect(screen.getByText("6 overrides in the last 7 days, past this venue's limit of 5.")).toBeTruthy();
    expect(screen.getByText(/booking MS-ABC123, Paddler Pat/)).toBeTruthy();
    expect(screen.getByText("Why: Guests asked for the late tide")).toBeTruthy();
    expect(screen.getByText("The window was: 7:10 AM–10:40 AM")).toBeTruthy();
    expect(screen.getByText(/by Mina Manager, 2026-11-05 09:30/)).toBeTruthy();
  });

  it("saves the venue's settings, an empty figure taking the install's", async () => {
    stub();
    render(<WindowOverridesPanel venueId={4} />);
    await act(async () => {});
    await act(async () => void fireEvent.click(screen.getByLabelText("Managers may override advisory windows")));
    await act(async () => void fireEvent.change(screen.getByLabelText("Shortest reason (characters)"), { target: { value: "25" } }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(posts[0]).toMatchObject({ url: "/api/admin/window-overrides", body: { venueId: 4, enabled: false, reasonMin: 25, weeklyAlert: null } });
  });

  it("is shown to a manager only: the desk is shown nothing and asks for nothing", async () => {
    stub();
    const { container } = render(
      <StaffMayProvider may={{ windowOverrides: false }}>
        <WindowOverridesPanel venueId={4} />
      </StaffMayProvider>
    );
    await act(async () => {});
    expect(container.textContent).toBe("");
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe("the needs-attention panel", () => {
  it("shows a manager's line when overrides of advisory windows are past the venue's limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ open: [], recent: [], windowOverrideAlerts: [{ venueId: 4, count: 7, limit: 5, days: 7 }] }))
    );
    render(
      <LanguageProvider locale="en">
        <AttentionPanel />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByText("Managers overrode advisory windows 7 times in the last 7 days, past the venue's limit of 5.")).toBeTruthy();
  });
});
