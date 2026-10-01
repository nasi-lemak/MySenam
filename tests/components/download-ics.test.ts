// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadIcs, icsContent } from "../../src/lib/booking-links";
import type { BookingShareInfo } from "../../src/lib/booking-links";

/**
 * The download itself, which only exists in a browser: the calendar file is
 * built, wrapped in a blob and handed to an anchor nobody ever sees. Worth
 * pinning because a wrong filename or type is the difference between a file
 * that opens in a calendar and one that opens in a text editor.
 */

const booking: BookingShareInfo = {
  code: "MS-7K2PQX",
  date: "2026-10-04",
  startHour: 20,
  endHour: 22,
  courtName: "Badminton Court 3",
  venueName: "Arena MySenam",
  totalPrice: 50,
};

afterEach(() => vi.restoreAllMocks());

describe("saving the booking to a calendar", () => {
  it("hands over a calendar file named after the booking", () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return "blob:fake";
      },
      revokeObjectURL: vi.fn(),
    });
    const click = vi.fn();
    const anchor = { href: "", download: "", click } as unknown as HTMLAnchorElement;
    vi.spyOn(document, "createElement").mockReturnValue(anchor);

    downloadIcs(booking);

    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("mysenam-MS-7K2PQX.ics");
    expect(anchor.href).toBe("blob:fake");
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/calendar");
    vi.unstubAllGlobals();
  });

  it("lets the blob go afterwards rather than leaking it", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:fake", revokeObjectURL: revoke });
    vi.spyOn(document, "createElement").mockReturnValue({
      href: "",
      download: "",
      click: vi.fn(),
    } as unknown as HTMLAnchorElement);

    downloadIcs(booking);
    expect(revoke).toHaveBeenCalledWith("blob:fake");
    vi.unstubAllGlobals();
  });

  it("writes the same file the rest of the app would", async () => {
    const seen: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => {
        seen.push(b);
        return "blob:fake";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(document, "createElement").mockReturnValue({
      href: "",
      download: "",
      click: vi.fn(),
    } as unknown as HTMLAnchorElement);

    downloadIcs(booking);
    expect(await seen[0].text()).toBe(icsContent(booking));
    vi.unstubAllGlobals();
  });
});
