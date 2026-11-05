import { describe, expect, it } from "vitest";

import { instantOf, parseClock } from "../src/lib/interval";
import {
  MAX_TIDE_GAP_MIN,
  bookableWindows,
  launchDay,
  launchOk,
  launchRefusal,
  minuteInstants,
  reasonFor,
  tideHeightCm,
  type LaunchRuleSpec,
  type TideEvent,
  type TideKind,
} from "../src/lib/launch-day";
import { parseTideCsv } from "../src/lib/tide-import";
import { dayOfWeek } from "../src/lib/time";

/**
 * The daily window of water hire: tide interpolation, the windows a rule leaves of a date, and the CSV a tide table
 * comes in (ADR 0037). Pure: no database. The hours are the court's opening hours that day.
 */

const KL = "Asia/Kuala_Lumpur";
const ev = (date: string, time: string, kind: TideKind, cm: number, zone = KL): TideEvent => ({ atMs: instantOf(date, parseClock(time)!, zone).getTime(), kind, cm });
const sorted = (events: TideEvent[]) => [...events].sort((a, b) => a.atMs - b.atMs);
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const win = (w: { start: number; end: number }) => `${hm(w.start)}-${hm(w.end)}`;

/** A semi-diurnal day in Kuala Lumpur: two highs, two lows. */
const FRIDAY = "2026-11-06";
const table = sorted([
  ev("2026-11-05", "20:15", "low", 50),
  ev(FRIDAY, "02:10", "high", 300),
  ev(FRIDAY, "08:25", "low", 60),
  ev(FRIDAY, "14:30", "high", 320),
  ev(FRIDAY, "20:40", "low", 50),
  ev("2026-11-07", "02:50", "high", 290),
]);

const height = (min: number): RuleOf => ({ source: "tide", weekly: null, tide: { rule: "height", minHeightCm: min }, minWindowMin: 0, returnBufferMin: 0 });
type RuleOf = LaunchRuleSpec;
const OPEN_ALL = { start: 0, end: 1440 };

function day(spec: LaunchRuleSpec, date: string, events: TideEvent[], open = OPEN_ALL, zone = KL) {
  return launchDay(1, spec, { date, zone, weekday: dayOfWeek(date), open, events });
}

describe("the tide between two entries", () => {
  it("is the entries' own at them and a half cosine between: halfway is the average", () => {
    const t = [ev(FRIDAY, "08:00", "low", 100), ev(FRIDAY, "14:00", "high", 300)];
    expect(tideHeightCm(t, t[0].atMs)).toBe(100);
    expect(tideHeightCm(t, t[1].atMs)).toBe(300);
    expect(tideHeightCm(t, t[0].atMs + 3 * 3_600_000)).toBeCloseTo(200, 6);
    // A quarter of the way, a cosine rises slowly then fast: 100 + 200 * (1 - cos(pi/4)) / 2.
    expect(tideHeightCm(t, t[0].atMs + 1.5 * 3_600_000)).toBeCloseTo(100 + (200 * (1 - Math.cos(Math.PI / 4))) / 2, 6);
  });

  it("says nothing before the first entry, after the last, across a gap, or between two of one kind", () => {
    const t = [ev(FRIDAY, "08:00", "low", 100), ev(FRIDAY, "14:00", "high", 300)];
    expect(tideHeightCm(t, t[0].atMs - 1)).toBeNull();
    expect(tideHeightCm(t, t[1].atMs + 1)).toBeNull();
    expect(tideHeightCm([], t[0].atMs)).toBeNull();
    const gap = [ev(FRIDAY, "00:00", "low", 100), ev("2026-11-07", "00:01", "high", 300)];
    expect(gap[1].atMs - gap[0].atMs).toBeGreaterThan(MAX_TIDE_GAP_MIN * 60_000);
    expect(tideHeightCm(gap, gap[0].atMs + 3_600_000)).toBeNull();
    const twoHighs = [ev(FRIDAY, "02:00", "high", 300), ev(FRIDAY, "08:00", "high", 310)];
    expect(tideHeightCm(twoHighs, twoHighs[0].atMs + 3_600_000)).toBeNull();
    // 15 hours exactly is still trusted; a minute more is not.
    const edge = [ev(FRIDAY, "00:00", "low", 100), ev(FRIDAY, "15:00", "high", 300)];
    expect(tideHeightCm(edge, edge[0].atMs + 3_600_000)).not.toBeNull();
  });
});

describe("a height rule", () => {
  it("opens the water for the stretches the tide is at least that high, with the edges where it crosses", () => {
    const d = day(height(200), FRIDAY, table);
    expect(d.windows).toHaveLength(2);
    for (const w of d.windows) {
      const at = (m: number) => tideHeightCm(table, minuteInstants(FRIDAY, KL)[m])!;
      // The window's ends are the first and last whole minutes at or above the height.
      expect(at(w.start)).toBeGreaterThanOrEqual(200);
      expect(at(w.end)).toBeGreaterThanOrEqual(200);
      // (The first window runs from midnight: the tide is already up.)
      if (w.start > 0) expect(at(w.start - 1)).toBeLessThan(200);
      if (w.end < 1440) expect(at(w.end + 1)).toBeLessThan(200);
    }
    // Around each high tide (02:10 and 14:30).
    expect(d.windows[0].start).toBeLessThan(2 * 60 + 10);
    expect(d.windows[0].end).toBeGreaterThan(2 * 60 + 10);
    expect(d.windows[1].start).toBeLessThan(14 * 60 + 30);
    expect(d.windows[1].end).toBeGreaterThan(14 * 60 + 30);
    // Worked by hand from the cosine: from 08:25 (60 cm) to 14:30 (320 cm) it reaches 200 at fraction acos(1 - 2 * 140 / 260) / pi of the
    // 365 minutes; from 14:30 to 20:40 (50 cm) it falls to 200 at acos(1 - 2 * 120 / 270) / pi of the 370 minutes.
    const rise = 8 * 60 + 25 + (Math.acos(1 - (2 * 140) / 260) / Math.PI) * 365;
    const fall = 14 * 60 + 30 + (Math.acos(1 - (2 * 120) / 270) / Math.PI) * 370;
    expect(d.windows[1].start).toBe(Math.ceil(rise));
    expect(d.windows[1].end).toBe(Math.floor(fall));
    expect(win(d.windows[1])).toBe("11:37-17:21");
  });

  it("labels what it shuts: low water between, and the stretch the table does not cover", () => {
    const d = day(height(200), FRIDAY, table);
    expect(reasonFor(d, 8 * 60, 9 * 60)).toBe("low_water");
    // The table starts the evening before and its last entry is at 02:50 the next day: 20:40 to midnight is low water too.
    expect(reasonFor(d, 22 * 60, 23 * 60)).toBe("low_water");
    const early = day(height(200), "2026-11-05", table);
    // Before the first entry (20:15 on the 5th) nothing is known.
    expect(reasonFor(early, 6 * 60, 7 * 60)).toBe("no_tide_data");
    // Only the last minutes, once the tide is above it, and after the table begins.
    expect(early.windows.every((w) => w.start >= 20 * 60)).toBe(true);
  });

  it("closes a date the table says nothing about, never opens it", () => {
    const d = day(height(0), "2026-12-25", table);
    expect(d.windows).toEqual([]);
    expect(d.closed).toEqual([{ start: 0, end: 1440, reason: "no_tide_data" }]);
    expect(launchRefusal(d, { start: 600, end: 660 })).toEqual({ code: "TIDE_NO_DATA", vars: {} });
    // A table with a missing entry (two highs in a row) is no data between them too.
    const hole = sorted([ev(FRIDAY, "02:10", "high", 300), ev(FRIDAY, "14:30", "high", 320), ev(FRIDAY, "20:40", "low", 50)]);
    const h = day(height(0), FRIDAY, hole);
    expect(reasonFor(h, 8 * 60, 9 * 60)).toBe("no_tide_data");
    expect(h.windows.every((w) => w.start >= 14 * 60 + 30)).toBe(true);
  });

  it("gives, for any table, windows in order, inside the day, that agree minute by minute with the tide (property)", () => {
    // A seeded generator: tides about every six hours, heights and spacings varying.
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let run = 0; run < 40; run++) {
      const events: TideEvent[] = [];
      let at = instantOf("2026-11-05", 20 * 60, KL).getTime();
      let kind: TideKind = rnd() < 0.5 ? "high" : "low";
      for (let i = 0; i < 12; i++) {
        events.push({ atMs: at, kind, cm: kind === "high" ? 200 + Math.round(rnd() * 150) : Math.round(rnd() * 100) });
        at += Math.round((300 + rnd() * 120) * 60_000 / 60_000) * 60_000;
        kind = kind === "high" ? "low" : "high";
      }
      const minH = 50 + Math.round(rnd() * 250);
      const minWindow = Math.round(rnd() * 90);
      const spec: LaunchRuleSpec = { source: "tide", weekly: null, tide: { rule: "height", minHeightCm: minH }, minWindowMin: minWindow, returnBufferMin: 0 };
      const d = day(spec, FRIDAY, events);
      const at2 = (m: number) => tideHeightCm(events, minuteInstants(FRIDAY, KL)[m]);
      let last = -1;
      for (const w of d.windows) {
        expect(w.start).toBeGreaterThan(last);
        expect(w.end).toBeGreaterThan(w.start);
        expect(w.end).toBeLessThanOrEqual(1440);
        expect(w.end - w.start).toBeGreaterThanOrEqual(Math.max(1, minWindow));
        last = w.end;
        for (let m = w.start; m <= w.end; m++) expect(at2(m)! + 1e-9).toBeGreaterThanOrEqual(minH);
      }
      // A minute interval not in a window is closed for one of the reasons: never silently open.
      for (let m = 0; m < 1440; m++) {
        const inside = d.windows.some((w) => w.start <= m && m < w.end);
        if (!inside) expect(d.closed.some((c) => c.start <= m && m < c.end), `minute ${m}`).toBe(true);
        else expect(d.closed.some((c) => c.start <= m && m < c.end && c.reason !== "return_buffer")).toBe(false);
      }
    }
  });
});

describe("an event rule", () => {
  const around = (kind: TideKind, minutes: number, extra: Partial<LaunchRuleSpec> = {}): LaunchRuleSpec => ({
    source: "tide",
    weekly: null,
    tide: { rule: "event", eventKind: kind, eventMinutes: minutes },
    minWindowMin: 0,
    returnBufferMin: 0,
    ...extra,
  });

  it("opens the minutes either side of each high tide: two highs a day, two windows", () => {
    const d = day(around("high", 90), FRIDAY, table);
    expect(d.windows.map(win)).toEqual(["00:40-03:40", "13:00-16:00"]);
    // Of the lows instead.
    expect(day(around("low", 45), FRIDAY, table).windows.map(win)).toEqual(["07:40-09:10", "19:55-21:25"]);
  });

  it("shuts the rest as low water, and an event at the very edge of the window counts", () => {
    const d = day(around("high", 90), FRIDAY, table);
    expect(reasonFor(d, 5 * 60, 6 * 60)).toBe("low_water");
    expect(launchOk(d, { start: 13 * 60, end: 16 * 60 })).toBe(true);
    expect(launchOk(d, { start: 12 * 60 + 59, end: 16 * 60 })).toBe(false);
    expect(launchOk(d, { start: 13 * 60, end: 16 * 60 + 1 })).toBe(false);
  });

  it("splits at midnight: an event at 23:50 is the evening's window on its date and the early morning's on the next, never one across", () => {
    const night = sorted([ev("2026-11-06", "17:30", "low", 40), ev("2026-11-06", "23:50", "high", 310), ev("2026-11-07", "06:05", "low", 50)]);
    const a = day(around("high", 60), "2026-11-06", night);
    const b = day(around("high", 60), "2026-11-07", night);
    expect(a.windows.map(win)).toEqual(["22:50-24:00"]);
    expect(b.windows.map(win)).toEqual(["00:00-00:50"]);
    // A booking over midnight is in neither: the next minute is the next day's.
    expect(launchOk(a, { start: 23 * 60 + 30, end: 24 * 60 + 30 })).toBe(false);
  });

  it("does not cover a day past the table, even where the event is near", () => {
    const short = [ev(FRIDAY, "02:10", "high", 300), ev(FRIDAY, "08:25", "low", 60)];
    const d = day(around("high", 60), FRIDAY, short);
    // Before its first entry (02:10) the table says nothing either: the window starts where the table does.
    expect(d.windows.map(win)).toEqual(["02:10-03:10"]);
    expect(reasonFor(d, 60, 120)).toBe("no_tide_data");
    // After 08:25 the table says nothing, though the next high is not near either.
    expect(reasonFor(d, 12 * 60, 13 * 60)).toBe("no_tide_data");
  });
});

describe("a launch window by weekday, composed", () => {
  const friday = (from: number, to: number): LaunchRuleSpec["weekly"] => [null, null, null, null, null, { from, to }, null];

  it("is the window itself on its weekday and nothing on a day without one", () => {
    const spec: LaunchRuleSpec = { source: "weekly", weekly: friday(7 * 60 + 10, 10 * 60 + 40), tide: null, minWindowMin: 0, returnBufferMin: 0 };
    expect(day(spec, FRIDAY, []).windows.map(win)).toEqual(["07:10-10:40"]);
    const saturday = day(spec, "2026-11-07", []);
    expect(saturday.windows).toEqual([]);
    expect(reasonFor(saturday, 9 * 60, 10 * 60)).toBe("outside_launch");
    expect(launchRefusal(saturday, { start: 600, end: 660 })).toEqual({ code: "LAUNCH_CLOSED", vars: {} });
  });

  it("is cut to the opening hours: the narrower wins, and the minutes after midnight are never in a window", () => {
    const spec: LaunchRuleSpec = { source: "weekly", weekly: friday(6 * 60, 12 * 60), tide: null, minWindowMin: 0, returnBufferMin: 0 };
    expect(day(spec, FRIDAY, [], { start: 8 * 60, end: 18 * 60 }).windows.map(win)).toEqual(["08:00-12:00"]);
    // Open until 2 AM: a window to midnight is the most there is.
    const late: LaunchRuleSpec = { source: "weekly", weekly: friday(20 * 60, 1440), tide: null, minWindowMin: 0, returnBufferMin: 0 };
    const d = day(late, FRIDAY, [], { start: 18 * 60, end: 26 * 60 });
    expect(d.windows.map(win)).toEqual(["20:00-24:00"]);
    expect(launchOk(d, { start: 23 * 60, end: 25 * 60 })).toBe(false);
  });

  it("with a tide table too is the intersection, and says which source shut a minute", () => {
    const spec: LaunchRuleSpec = { source: "both", weekly: friday(6 * 60, 15 * 60), tide: { rule: "height", minHeightCm: 200 }, minWindowMin: 0, returnBufferMin: 0 };
    const d = day(spec, FRIDAY, table);
    // The tide's windows are about 00:xx-04:xx and 11:37-17:23; the launch window 06:00-15:00 leaves 11:37-15:00.
    expect(d.windows.map(win)).toEqual(["11:37-15:00"]);
    expect(reasonFor(d, 4 * 60, 5 * 60)).toBe("outside_launch");
    expect(reasonFor(d, 9 * 60, 10 * 60)).toBe("low_water");
    expect(reasonFor(d, 16 * 60, 17 * 60)).toBe("outside_launch");
  });

  it("drops a window shorter than the shortest and says so", () => {
    const spec: LaunchRuleSpec = { source: "both", weekly: friday(6 * 60, 12 * 60 + 20), tide: { rule: "height", minHeightCm: 200 }, minWindowMin: 60, returnBufferMin: 0 };
    const d = day(spec, FRIDAY, table);
    // 11:37-12:20 is 43 minutes.
    expect(d.windows).toEqual([]);
    expect(reasonFor(d, 11 * 60 + 40, 12 * 60)).toBe("short_window");
    const longer = day({ ...spec, minWindowMin: 40 }, FRIDAY, table);
    expect(longer.windows.map(win)).toEqual(["11:37-12:20"]);
  });
});

describe("the return buffer", () => {
  const spec: LaunchRuleSpec = { source: "weekly", weekly: [null, null, null, null, null, { from: 7 * 60 + 10, to: 10 * 60 + 40 }, null], tide: null, minWindowMin: 0, returnBufferMin: 30 };

  it("takes the last minutes of a window off what may be booked, and a booking must end by then", () => {
    const d = day(spec, FRIDAY, []);
    expect(d.windows.map(win)).toEqual(["07:10-10:40"]);
    expect(bookableWindows(d).map(win)).toEqual(["07:10-10:10"]);
    expect(launchOk(d, { start: 8 * 60, end: 10 * 60 + 10 })).toBe(true);
    expect(launchOk(d, { start: 8 * 60, end: 10 * 60 + 11 })).toBe(false);
    expect(reasonFor(d, 10 * 60 + 15, 10 * 60 + 20)).toBe("return_buffer");
    expect(launchRefusal(d, { start: 8 * 60, end: 10 * 60 + 30 })).toEqual({ code: "LAUNCH_RETURN", vars: { back: "10:10 AM", minutes: 30 } });
    // Starting before the window opens is the window's, not the return's.
    expect(launchRefusal(d, { start: 7 * 60, end: 8 * 60 })).toEqual({ code: "LAUNCH_WINDOW", vars: { window: "7:10 AM–10:40 AM" } });
  });

  it("is the whole window or more: a buffer longer than the window leaves nothing to book", () => {
    const d = day({ ...spec, returnBufferMin: 240 }, FRIDAY, []);
    expect(bookableWindows(d)).toEqual([]);
    expect(launchOk(d, { start: 8 * 60, end: 9 * 60 })).toBe(false);
  });
});

describe("where the clocks change", () => {
  const LONDON = "Europe/London";

  it("reads a date as the zone had it: 29 March 2026 has 23 hours, and a tide at 12:00 UTC is 13:00 on the clock", () => {
    const instants = minuteInstants("2026-03-29", LONDON);
    expect(instants).toHaveLength(1441);
    expect((instants[1440] - instants[0]) / 60_000).toBe(23 * 60);
    const t = sorted([
      { atMs: Date.UTC(2026, 2, 29, 5, 55), kind: "low", cm: 50 },
      { atMs: Date.UTC(2026, 2, 29, 12, 0), kind: "high", cm: 300 },
      { atMs: Date.UTC(2026, 2, 29, 18, 20), kind: "low", cm: 60 },
    ]);
    const spec: LaunchRuleSpec = { source: "tide", weekly: null, tide: { rule: "event", eventKind: "high", eventMinutes: 60 }, minWindowMin: 0, returnBufferMin: 0 };
    const d = launchDay(1, spec, { date: "2026-03-29", zone: LONDON, weekday: dayOfWeek("2026-03-29"), open: OPEN_ALL, events: t });
    // 12:00 UTC is 13:00 BST: 12:00–14:00 on the clock.
    expect(d.windows.map(win)).toEqual(["12:00-14:00"]);
    // The same instant the day after the clocks go back is 12:00 GMT.
    const back = sorted([
      { atMs: Date.UTC(2026, 9, 25, 5, 55), kind: "low", cm: 50 },
      { atMs: Date.UTC(2026, 9, 25, 12, 0), kind: "high", cm: 300 },
      { atMs: Date.UTC(2026, 9, 25, 18, 20), kind: "low", cm: 60 },
    ]);
    const e = launchDay(1, spec, { date: "2026-10-25", zone: LONDON, weekday: dayOfWeek("2026-10-25"), open: OPEN_ALL, events: back });
    expect(e.windows.map(win)).toEqual(["11:00-13:00"]);
  });
});

describe("a tide table as CSV", () => {
  const read = (text: string, times: "venue" | "utc" = "venue", zone = KL) => parseTideCsv(text, { zone, times });

  it("reads a table, with its dates and times on the venue's clock, heights to the centimetre", () => {
    const r = read("date,time,type,height_m\n2026-11-06,05:42,high,3.1\n2026-11-06,11:58,low,0.6\n2026-11-06,18:03,HW,3.14");
    expect(r.errors).toEqual([]);
    expect(r.events.map((e) => [e.date, e.time, e.kind, e.cm, e.line])).toEqual([
      ["2026-11-06", "05:42", "high", 310, 2],
      ["2026-11-06", "11:58", "low", 60, 3],
      ["2026-11-06", "18:03", "high", 314, 4],
    ]);
    expect(r.events[0].atMs).toBe(Date.UTC(2026, 10, 5, 21, 42));
    expect(r.rows).toBe(3);
  });

  it("reads times as UTC where it is told to", () => {
    const r = read("date,time,type,height_m\n2026-11-06,05:42,high,3.1", "utc");
    expect(r.events[0].atMs).toBe(Date.UTC(2026, 10, 6, 5, 42));
  });

  it("reads other separators, column orders, day-first dates and a byte order mark", () => {
    const r = read("﻿type;height_m;date;time\nlow;0,6;06/11/2026;5:07\nhigh;3,1;6/11/2026;11:20");
    expect(r.errors).toEqual([]);
    expect(r.events.map((e) => [e.date, e.time, e.cm])).toEqual([
      ["2026-11-06", "5:07", 60],
      ["2026-11-06", "11:20", 310],
    ]);
  });

  it("converts units: feet and centimetres by the column or by the figure, and refuses a figure that disagrees with its column", () => {
    const ft = read("date,time,type,height_ft\n2026-11-06,05:42,high,10.2\n2026-11-06,11:58,low,2ft");
    expect(ft.errors).toEqual([]);
    expect(ft.events.map((e) => e.cm)).toEqual([311, 61]);
    const cm = read("date,time,type,height_cm\n2026-11-06,05:42,high,310");
    expect(cm.events[0].cm).toBe(310);
    const plain = read("date,time,type,height\n2026-11-06,05:42,high,3.1m\n2026-11-06,11:58,low,60cm");
    expect(plain.events.map((e) => e.cm)).toEqual([310, 60]);
    const bad = read("date,time,type,height_m\n2026-11-06,05:42,high,10ft");
    expect(bad.errors).toEqual([{ line: 2, code: "unit", vars: { value: "10ft" } }]);
  });

  it("names every bad row by its line, with the file's blank lines counted, and reads no table with a fault", () => {
    const r = read(
      [
        "date,time,type,height_m",
        "2026-11-06,05:42,high,3.1",
        "",
        "2026-13-06,05:42,high,3.1", // 4: month 13
        "2026-11-06,25:00,high,3.1", // 5: hour
        "2026-11-06,05:42,medium,3.1", // 6: type
        "2026-11-06,05:42,high,tall", // 7: height
        "2026-11-06,05:42,high,99", // 8: out of range
        "2026-11-06,06:00,high", // 9: short
        "2026-11-06,05:42,low,0.5", // 10: same instant as line 2
      ].join("\n")
    );
    expect(r.errors.map((e) => [e.line, e.code])).toEqual([
      [4, "date"],
      [5, "time"],
      [6, "type"],
      [7, "height"],
      [8, "height_range"],
      [9, "short_row"],
      [10, "dup_in_file"],
    ]);
    expect(r.errors[6].vars).toEqual({ first: 2 });
  });

  it("refuses a file without the columns it needs, and an empty one", () => {
    expect(read("date,time,type\n2026-11-06,05:42,high").errors).toEqual([{ line: 1, code: "columns", vars: { missing: "height" } }]);
    expect(read("").errors[0].code).toBe("columns");
    expect(read("when,what\nx,y").errors[0].vars).toEqual({ missing: "date, time, type, height" });
  });

  it("refuses a time the clocks skip or repeat, rather than guess which moment it was", () => {
    const London = "Europe/London";
    const skipped = read("date,time,type,height_m\n2026-03-29,01:30,high,3.1\n2026-03-29,02:30,low,0.5", "venue", London);
    expect(skipped.errors).toEqual([{ line: 2, code: "clock", vars: { date: "2026-03-29", time: "01:30" } }]);
    expect(read("date,time,type,height_m\n2026-10-25,01:30,high,3.1", "venue", London).errors[0].code).toBe("clock");
    // The same minutes are fine in UTC.
    expect(read("date,time,type,height_m\n2026-03-29,01:30,high,3.1", "utc", London).errors).toEqual([]);
  });

  it("warns, without refusing, of two of a kind in a row and of a long gap", () => {
    const r = read("date,time,type,height_m\n2026-11-06,02:00,high,3.1\n2026-11-06,08:00,high,3.0\n2026-11-08,08:00,low,0.5");
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => [w.line, w.code])).toEqual([
      [3, "same_kind_neighbours"],
      [4, "long_gap"],
    ]);
  });

  it("stops at the row limit", () => {
    const rows = Array.from({ length: 5002 }, (_, i) => `2026-11-06,${String(i % 24).padStart(2, "0")}:00,high,3`).join("\n");
    const r = read(`date,time,type,height_m\n${rows}`);
    expect(r.errors.some((e) => e.code === "too_many")).toBe(true);
  });
});
