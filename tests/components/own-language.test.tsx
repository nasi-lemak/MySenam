// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { LanguageProvider, LanguageToggle, STAFF_LANGUAGE_SETTLED } from "../../src/components/Language";
import { useAccountLanguage } from "../../src/components/admin/StaffLanguage";
import { BookingAlertsEditor } from "../../src/components/admin/BookingAlertsEditor";
import { CoachesPanel } from "../../src/components/admin/CoachesPanel";
import CoachLanguage from "../../src/components/CoachLanguage";
import type { ManagedVenue } from "../../src/components/admin/shared";
import { LOCALE_COOKIE } from "../../src/lib/i18n";
import type { StaffLocale } from "../../src/lib/staff-locales";

/**
 * The pickers for a language of one's own: the dashboard's switch saving to
 * the account, the dashboard following the account's language, a venue's
 * alerts, a coach's record, and the coach's own link.
 */

let reload: ReturnType<typeof vi.fn>;
let posted: { url: string; body: Record<string, unknown> }[];
let answer: (url: string, body: Record<string, unknown>) => { ok: boolean; json: () => Promise<unknown> };

beforeEach(() => {
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  posted = [];
  answer = (_url, body) => ({ ok: true, json: async () => ({ locale: body.locale ?? null }) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        posted.push({ url, body });
        return answer(url, body);
      }
      if (url.startsWith("/api/admin/booking-alerts")) return { ok: true, json: async () => ({ alerts: { email: "desk@club.my", phone: null, locale: "zh" } }) };
      if (url.startsWith("/api/admin/coaches"))
        return {
          ok: true,
          json: async () => ({
            coaches: [{ id: 7, venueId: 1, name: "Kumar", bio: null, sports: ["tennis"], rate: 50, active: true, hours: [], timeOff: [] }],
            contacts: { 7: { email: "kumar@coach.my", locale: "ta", linkUntil: null } },
            choice: "customer",
          }),
        };
      return { ok: true, json: async () => ({}) };
    })
  );
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
});

describe("the dashboard's language switch", () => {
  it("saves the choice to the signed-in account, then sets the cookie and reloads", async () => {
    render(
      <LanguageProvider locale="en">
        <LanguageToggle staff />
      </LanguageProvider>
    );
    // Staff screens are English, Malay and Chinese: no Tamil on the dashboard.
    expect(screen.queryByRole("button", { name: "தமிழ்" })).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "ms" }).click();
    });
    expect(posted).toEqual([{ url: "/api/admin/auth/language", body: { locale: "ms" } }]);
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=ms`);
    expect(sessionStorage.getItem(STAFF_LANGUAGE_SETTLED)).toBe("ms");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("still switches when there is no account to save it on (signed out)", async () => {
    answer = () => ({ ok: false, json: async () => ({ error: "Please sign in." }) });
    render(
      <LanguageProvider locale="en">
        <LanguageToggle staff />
      </LanguageProvider>
    );
    await act(async () => {
      screen.getByRole("button", { name: "中文" }).click();
    });
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh`);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("on customers' pages saves nothing to an account", async () => {
    render(
      <LanguageProvider locale="en">
        <LanguageToggle />
      </LanguageProvider>
    );
    screen.getByRole("button", { name: "தமிழ்" }).click();
    expect(posted).toEqual([]);
    expect(reload).toHaveBeenCalledOnce();
  });
});

function Follows({ locale }: { locale: StaffLocale | null }) {
  useAccountLanguage(locale);
  return null;
}

describe("the dashboard following the account's language", () => {
  it("switches to it once a session where the browser reads another", () => {
    const { rerender } = render(
      <LanguageProvider locale="en">
        <Follows locale="zh" />
      </LanguageProvider>
    );
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh`);
    expect(reload).toHaveBeenCalledOnce();
    // A browser that kept the old language (the cookie refused): not reloaded again and again.
    rerender(
      <LanguageProvider locale="ms">
        <Follows locale="zh" />
      </LanguageProvider>
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing with none chosen, the same language, or after the reader chose with the switch", () => {
    render(
      <LanguageProvider locale="en">
        <Follows locale={null} />
      </LanguageProvider>
    );
    render(
      <LanguageProvider locale="ms">
        <Follows locale="ms" />
      </LanguageProvider>
    );
    sessionStorage.setItem(STAFF_LANGUAGE_SETTLED, "en");
    render(
      <LanguageProvider locale="en">
        <Follows locale="zh" />
      </LanguageProvider>
    );
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("the language of a venue's booking alerts", () => {
  it("shows the one chosen and saves a change with the address", async () => {
    render(<BookingAlertsEditor venueId={3} />);
    await act(async () => {});
    const choice = screen.getByRole("combobox", { name: "Alerts written in" }) as HTMLSelectElement;
    expect(choice.value).toBe("zh");
    expect([...choice.options].map((o) => o.value)).toEqual(["", "en", "ms", "zh"]);
    expect(choice.options[0].textContent).toBe("Usual language (English)");
    answer = () => ({ ok: true, json: async () => ({ alerts: { email: "desk@club.my", phone: null, locale: null } }) });
    fireEvent.change(choice, { target: { value: "" } });
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });
    expect(posted).toEqual([{ url: "/api/admin/booking-alerts", body: { venueId: 3, email: "desk@club.my", phone: "", locale: null, cancellations: false, changes: false, withinHours: 24 } }]);
  });
});

describe("a coach's language on their record", () => {
  it("shows theirs, among every language the install offers, and saves a change", async () => {
    answer = () => ({
      ok: true,
      json: async () => ({ coaches: [{ id: 7, venueId: 1, name: "Kumar", bio: null, sports: ["tennis"], rate: 50, active: true, hours: [], timeOff: [] }], contacts: { 7: { email: "kumar@coach.my", locale: "ms", linkUntil: null } } }),
    });
    render(<CoachesPanel venue={{ id: 1, name: "Club", courts: [{ id: 1, sport: "tennis", activities: [] }] } as unknown as ManagedVenue} />);
    await act(async () => {});
    const choice = screen.getByRole("combobox", { name: /Kumar's language/ }) as HTMLSelectElement;
    expect(choice.value).toBe("ta");
    expect([...choice.options].map((o) => o.value)).toEqual(["", "en", "ms", "zh", "ta"]);
    await act(async () => {
      fireEvent.change(choice, { target: { value: "ms" } });
    });
    expect(posted).toEqual([{ url: "/api/admin/coaches", body: { venueId: 1, id: 7, action: "locale", locale: "ms" } }]);
    expect((screen.getByRole("combobox", { name: /Kumar's language/ }) as HTMLSelectElement).value).toBe("ms");
  });
});

describe("a coach choosing at their own link", () => {
  it("saves it and reloads the page in it", async () => {
    render(
      <LanguageProvider locale="en">
        <CoachLanguage token="tok123" chosen={null} />
      </LanguageProvider>
    );
    const choice = screen.getByRole("combobox") as HTMLSelectElement;
    expect(choice.value).toBe("");
    expect(choice.options[0].textContent).toBe("Not chosen (emails in English)");
    await act(async () => {
      fireEvent.change(choice, { target: { value: "ta" } });
    });
    expect(posted).toEqual([{ url: "/api/coach/tok123/language", body: { locale: "ta" } }]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("says when it could not be saved, and keeps the one before", async () => {
    answer = () => ({ ok: false, json: async () => ({ error: "This link is no longer in use." }) });
    render(
      <LanguageProvider locale="ms">
        <CoachLanguage token="tok123" chosen="ms" />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "zh" } });
    });
    expect(screen.getByText(/no longer in use|tidak lagi digunakan/)).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("ms");
    expect(reload).not.toHaveBeenCalled();
  });
});
