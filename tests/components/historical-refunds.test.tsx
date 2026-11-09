// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { HistoricalRefunds } from "../../src/components/admin/HistoricalRefunds";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";

/**
 * The manager's review of cancellations from before money owed back was written down (ADR 0078): loaded when opened, each credit note with its
 * evidence, the form, the preview in words (today's cash-up, the note's day not changed, a counted day named), and the acknowledgement a
 * counted day needs before it can be recorded. Front desk sees none of it.
 */

const candidate = {
  kind: "cancellation", venueId: 1, venueName: "Arena", bookingId: 5, bookingCode: "MS-OLD001", withdrawalId: null, creditNoteId: 77, creditNote: "CN-000077",
  noteTotal: 20, noteDay: "2026-03-01", paidWith: "cash", logEvidence: ["payment.paid_out"], otherNotes: { count: 1, total: 35 }, storedCredit: 0, paidOutOnBooking: 35,
  possibleDuplicate: true,
};
const record = {
  id: 9, venueId: 1, bookingCode: "MS-OLD002", kind: "cancellation", creditNote: "CN-000078", noteTotal: 20, paidWith: "cash", finding: "earlier",
  earlier: { amount: 20, on: "2026-03-02", via: "cash" }, now: null, amount: 20, remainder: 0, remainderReason: null, evidence: "Till sheet", reason: "Customer said so",
  verifiedBy: "Mona", recordedAt: "2026-11-09T04:00:00Z", countedDaysAcknowledged: false,
};
const preview = {
  candidate, finding: "now", amount: 20, remainder: 0, writes: { owedRow: true, payout: { amount: 20, via: "cash" }, creditNote: false },
  today: { day: "2026-11-09", amount: 20, via: "cash", counts: [] }, noteDay: { day: "2026-03-01", counts: [{ by: "Mike Manager", at: "2026-03-01T14:00:00Z" }] },
  earlierDay: null, needsAcknowledgement: true,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      return { ok: true, json: async () => (body.preview ? { preview } : { preview, recordId: 10 }) };
    }
    return { ok: true, json: async () => ({ since: "2026-11-07T10:00:00Z", candidates: [candidate], records: [record] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").map((c) => JSON.parse(c[1].body));

describe("cancellations from before money owed back was written down", () => {
  it("loads when opened, lists the credit note with its evidence and the records, and records only after a preview and the acknowledgement", async () => {
    const done = vi.fn();
    render(<HistoricalRefunds onDone={done} onError={() => {}} />);
    // Nothing is fetched until the manager opens it.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByText(/Cancellations from before money owed back was written down/));
    });
    const box = screen.getByTestId("historical-refunds");
    expect(box.textContent).toContain(": cancellations to review");
    expect(box.textContent).toContain("MS-OLD001");
    expect(box.textContent).toContain("CN-000077");
    const evidence = within(box).getByTestId("historical-evidence").textContent ?? "";
    expect(evidence).toContain("Activity log: payment.paid_out");
    expect(evidence).toContain("1 other credit note(s) on the booking");
    expect(evidence).toContain("already handed back at the counter on this booking");
    expect(evidence).toContain("may already be back");
    // A record: completed, historical, when it was handed back and when it was recorded.
    const records = within(box).getByTestId("historical-records").textContent ?? "";
    expect(records).toContain("Completed (historical reconciliation)");
    expect(records).toContain("as a historical reconciliation");
    expect(records).toContain("Verified by Mona");

    fireEvent.click(within(box).getByText("Review"));
    const form = within(box).getByTestId("historical-form");
    fireEvent.change(within(form).getByDisplayValue("Handed back at the time"), { target: { value: "now" } });
    const [evidenceInput, reasonInput] = within(form).getAllByRole("textbox");
    fireEvent.change(evidenceInput, { target: { value: "Till sheet of 1 March" } });
    fireEvent.change(reasonInput, { target: { value: "Customer asked; never handed back" } });
    // No record button before a preview.
    expect(within(form).queryByText("Record it")).toBeNull();
    await act(async () => {
      fireEvent.click(within(form).getByText("Preview"));
    });
    const words = within(form).getByTestId("historical-preview").textContent ?? "";
    expect(words).toContain("marked as a historical reconciliation");
    expect(words).toContain("No new credit note");
    expect(words).toContain("A payout of");
    expect(words).toContain("Today's cash-up");
    expect(words).toContain("not changed (it counted this credit note as handed back on");
    expect(words).toContain("A till count is recorded for");
    expect(words).toContain("by Mike Manager");
    const save = within(form).getByText("Record it") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(form).getByRole("checkbox"));
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    const sent = posts();
    expect(sent[0]).toMatchObject({ creditNoteId: 77, finding: "now", now: { amount: 20, via: "cash" }, preview: true, evidence: "Till sheet of 1 March" });
    expect(sent[1]).toMatchObject({ creditNoteId: 77, finding: "now", acknowledgeCountedDays: true, reason: "Customer asked; never handed back" });
    expect(sent[1].preview).toBeUndefined();
    expect(done).toHaveBeenCalledWith(expect.stringContaining("Recorded for MS-OLD001"));
  });

  it("is not shown to front desk", () => {
    const { container } = render(
      <StaffMayProvider may={{ historicalRefunds: false }}>
        <HistoricalRefunds onDone={() => {}} onError={() => {}} />
      </StaffMayProvider>
    );
    expect(container.textContent).toBe("");
  });
});
