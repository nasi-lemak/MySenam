// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "../../src/components/Language";
import { RegisterPanel, type RegisterKey } from "../../src/components/RegisterPanel";
import { MovedLesson } from "../../src/components/MovedLesson";
import CoachRegister from "../../src/components/CoachRegister";
import { staffTranslator } from "../../src/lib/staff-i18n";
import { translator } from "../../src/lib/i18n";

/**
 * The register as a tap list (components/RegisterPanel.tsx) and the customer's way out of a lesson the venue moved (components/MovedLesson.tsx).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const t = staffTranslator("en");
const say = (key: RegisterKey, vars?: Record<string, string | number>) => t(`clsb.s.${key}`, vars);

const register = (over: Record<string, unknown> = {}) => ({
  session: { kind: "class", id: 1, title: "Junior tennis", where: "Studio", date: "2026-11-06", startMin: 1020, endMin: 1080, seriesCode: null, cancelled: false },
  lines: [
    { key: "c:1", name: "Amira Binti Ali", walkIn: false, booked_for: true, bookingCode: "MS-AAA111", phone: "0123456789", cancelled: false, mark: null, note: null, markedBy: null, markedAt: null, changes: 0 },
    { key: "w:ab12", name: "Drop In Dee", walkIn: true, booked_for: false, bookingCode: null, phone: null, cancelled: false, mark: "present", note: null, markedBy: "Mei", markedAt: "2026-11-06T09:00:00Z", changes: 0 },
  ],
  phase: "open",
  canMark: true,
  canCorrect: false,
  canLock: false,
  locked: null,
  closesOn: "2026-11-20",
  ...over,
});

function wire(reg: ReturnType<typeof register>) {
  const sent: Record<string, unknown>[] = [];
  const load = vi.fn(async () => ({ ok: true, json: async () => ({ register: reg }) }) as Response);
  const send = vi.fn(async (body: Record<string, unknown>) => {
    sent.push(body);
    return { ok: true, json: async () => ({}) } as Response;
  });
  return { load, send, sent };
}

describe("the register", () => {
  it("lists each person with four marks that say whether they are on, named for a screen reader, and marks one with a tap", async () => {
    const w = wire(register());
    render(<RegisterPanel load={w.load} send={w.send} say={say} errorText={(d, f) => t.err(d, f)} />);
    await act(async () => {});
    expect(screen.getByText("Amira Binti Ali")).toBeTruthy();
    const dee = screen.getByRole("button", { name: "Drop In Dee: Present" });
    expect(dee.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Drop In Dee: Absent" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("walk-in")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Amira Binti Ali: Late" }));
    });
    expect(w.sent[0]).toMatchObject({ action: "mark", key: "c:1", mark: "late" });
    // A note has a name of its own and is saved with the mark it belongs to.
    expect(screen.getByLabelText("Drop In Dee: Note")).toBeTruthy();
  });

  it("is read-only before the day, and a manager's closed register asks for a reason before any correction", async () => {
    const early = wire(register({ phase: "early", canMark: false }));
    render(<RegisterPanel load={early.load} send={early.send} say={say} errorText={(d, f) => t.err(d, f)} />);
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Amira Binti Ali: Present" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Walk-in's name")).toBeNull();
    cleanup();
    const closed = wire(register({ phase: "closed", canMark: false, canCorrect: true, canLock: true }));
    render(<RegisterPanel load={closed.load} send={closed.send} say={say} errorText={(d, f) => t.err(d, f)} />);
    await act(async () => {});
    const present = screen.getByRole("button", { name: "Amira Binti Ali: Present" }) as HTMLButtonElement;
    expect(present.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(screen.getByTestId("register-reason"), { target: { value: "Signed in on paper" } });
    });
    expect(present.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(present);
    });
    expect(closed.sent[0]).toMatchObject({ action: "mark", mark: "present", reason: "Signed in on paper" });
  });

  it("adds a walk-in by name", async () => {
    const w = wire(register());
    render(<RegisterPanel load={w.load} send={w.send} say={say} errorText={(d, f) => t.err(d, f)} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Walk-in's name"), { target: { value: "Raj" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(w.sent[0]).toMatchObject({ action: "walkin", name: "Raj" });
  });

  it("is a coach's roll call on their page, in the customer's languages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, json: async () => ({ register: register() }), url }) as unknown as Response)
    );
    render(
      <LanguageProvider locale="ms">
        <CoachRegister token={"x".repeat(30)} lessonId={5} />
      </LanguageProvider>
    );
    const ms = translator("ms");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ms("clsb.c.rollCall") }));
    });
    expect(screen.getByRole("button", { name: `Amira Binti Ali: ${ms("clsb.c.present")}` })).toBeTruthy();
  });
});

describe("a lesson the venue moved", () => {
  it("says where it was and is, that the price stays and until when, and cancels only when the customer presses it", async () => {
    const cancel = vi.fn(async () => ({ ok: true, json: async () => ({ booking: { id: 1, status: "cancelled" }, refunds: [] }) }) as Response);
    const done = vi.fn();
    vi.stubGlobal("confirm", () => true);
    render(
      <LanguageProvider locale="en">
        <MovedLesson
          offer={{ moveId: 1, until: "2026-11-12T10:00:00.000Z", from: { date: "2026-11-09", startMin: 600, endMin: 660 }, to: { date: "2026-11-10", startMin: 660, endMin: 720 }, priceDifference: 20, movedBy: "Dino" }}
          zone="Asia/Kuala_Lumpur"
          cancel={cancel}
          onCancelled={done}
        />
      </LanguageProvider>
    );
    expect(screen.getByText("The venue moved this lesson")).toBeTruthy();
    expect(screen.getByText("The price you agreed stays the same.")).toBeTruthy();
    expect(screen.getByText(/cancel it for everything back until/)).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel for everything back" }));
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalled();
  });

  it("does nothing when the customer says no to the question", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("confirm", () => false);
    render(
      <LanguageProvider locale="en">
        <MovedLesson
          offer={{ moveId: 1, until: "2026-11-12T10:00:00.000Z", from: { date: "2026-11-09", startMin: 600, endMin: 660 }, to: { date: "2026-11-10", startMin: 660, endMin: 720 }, priceDifference: 0, movedBy: "Dino" }}
          zone="Asia/Kuala_Lumpur"
          cancel={cancel}
          onCancelled={() => {}}
        />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel for everything back" }));
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("moving a lesson, as staff see it", () => {
  it("says before anything changes that the lesson keeps the price agreed, what the new time costs, and who changes the price", async () => {
    const { ChangeTime } = await import("../../src/components/ChangeTime");
    const { addDays, todayISO } = await import("../../src/lib/time");
    const day = addDays(todayISO(), 1);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ options: [{ startMin: 1140, startHour: 19, courtId: 3, courtName: "Court 3", price: 40, difference: 20 }] }) })));
    const booking = { code: "MS-LES001", date: day, startMin: 600, endMin: 660, courtId: 3, paymentStatus: "unpaid", coachId: 7 } as never;
    const seen = (unchargedDifference: number) => ({
      from: { date: day, startMin: 600, endMin: 660, courtId: 3, courtName: "Court 3" },
      to: { date: day, startMin: 1140, endMin: 1200, courtId: 3, courtName: "Court 3" },
      priceChange: 0,
      unchargedDifference,
      keepsAgreedPrice: true,
      outcome: "move",
      gameId: null,
      players: [],
      pending: { invited: 0, requested: 0, waitlisted: 0, offered: 0 },
      clashes: 0,
      sharesPaid: 0,
    });
    for (const [diff, words] of [
      [20, /new time costs .*20.* more, which is not charged/],
      [-20, /new time costs .*20.* less, which is not given back/],
      [0, /keeps the price agreed\.$/],
    ] as const) {
      cleanup();
      render(
        <LanguageProvider locale="en">
          <ChangeTime
            booking={booking}
            staff
            optionsUrl={(d) => `options-for-${d}`}
            preview={(async () => ({ ok: true, json: async () => ({ preview: seen(diff) }) })) as never}
            submit={(async () => ({ ok: true, json: async () => ({}) })) as never}
            onDone={() => {}}
            onClose={() => {}}
          />
        </LanguageProvider>
      );
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /7:00 PM–8:00 PM/ }));
      });
      expect(screen.getByTestId("keeps-price").textContent).toMatch(words);
      expect(screen.getByText(/a manager uses Adjust price/)).toBeTruthy();
    }
  });
});
