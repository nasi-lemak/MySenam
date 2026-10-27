// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ParticipantsPanel } from "../../src/components/admin/ParticipantsPanel";
import { LanguageProvider } from "../../src/components/Language";

/**
 * The one-time code staff send to a guardian recorded by name and number
 * (lib/contact-guardians.ts) goes in the language staff choose for it, as
 * the waiting-list counter form's offer does: one of the install's customer
 * languages, starting from the one the member of staff reads the site in.
 * Without a choice the server would write it in the install's first.
 */

let posts: Record<string, unknown>[];

function stub(codesPossible = true) {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
      const found = String(url).startsWith("/api/admin/participants?");
      return {
        ok: true,
        status: 200,
        json: async () =>
          found
            ? {
                codesPossible,
                participants: [
                  {
                    id: 41,
                    displayName: "Alya",
                    birthYear: 2016,
                    linked: false,
                    guardians: [
                      { id: 5, name: "Puan Aminah", relationship: "parent", provenance: "counter", account: false, suspended: false, review: null, reviewNote: null, contactVerified: false, claimed: false },
                    ],
                    requests: [],
                  },
                ],
              }
            : { ok: true, expiresAt: "2026-10-27T10:00:00.000Z", channel: "sms" },
      };
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

async function find(phone = "Guardian's phone number", look = "Look up") {
  await act(async () => void fireEvent.change(screen.getByLabelText(phone), { target: { value: "0177000001" } }));
  await act(async () => void fireEvent.click(screen.getByText(look)));
}

describe("the language of a guardian's code", () => {
  it("starts from the language staff read the site in, and sends the one they choose", async () => {
    stub();
    render(
      <LanguageProvider locale="ms">
        <ParticipantsPanel venues={[{ id: 3, name: "Guardian Centre" } as never]} role="desk" />
      </LanguageProvider>
    );
    // The dashboard in Malay, as the site: the message starts in Malay too.
    await find("Nombor telefon penjaga", "Cari");
    const language = screen.getByLabelText("Bahasa mesej kod") as HTMLSelectElement;
    expect(language.value).toBe("ms");
    // The install's customer languages, by their own names.
    expect([...language.options].map((o) => o.value)).toEqual(["en", "ms", "zh", "ta"]);

    await act(async () => void fireEvent.click(screen.getByText("Semak nombor mereka dengan kod")));
    expect(posts.at(-1)).toEqual({ venueId: 3, action: "sendCode", guardianId: 5, purpose: "verify", locale: "ms" });

    fireEvent.change(language, { target: { value: "ta" } });
    vi.stubGlobal("confirm", vi.fn(() => true));
    await act(async () => void fireEvent.click(screen.getByText("Mereka menamatkan hubungan sendiri (dengan kod)")));
    expect(posts.at(-1)).toEqual({ venueId: 3, action: "sendCode", guardianId: 5, purpose: "withdraw", locale: "ta" });
  });

  it("is not asked where no code can be sent", async () => {
    stub(false);
    render(<ParticipantsPanel venues={[{ id: 3, name: "Guardian Centre" } as never]} role="manager" />);
    await find();
    expect(screen.queryByLabelText("Language of the code message")).toBeNull();
  });
});
