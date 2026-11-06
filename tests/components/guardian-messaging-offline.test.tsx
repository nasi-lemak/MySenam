// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import GuardianMessaging from "../../src/components/GuardianMessaging";
import { LanguageProvider } from "../../src/components/Language";

/**
 * The guardian's messaging controls ask the server for the children when the page opens, with nobody waiting on the answer. A
 * connection that is down leaves the section out, as for a guardian with no child in a youth group: it is not an error thrown into
 * nothing (an unhandled rejection, which in a browser is lost and in the test run fails it).
 */
afterEach(() => vi.unstubAllGlobals());

describe("the guardian's messaging controls without a connection", () => {
  it("are left out when the page opens, and throw nothing nobody hears", async () => {
    const lost: unknown[] = [];
    const listen = (e: unknown) => lost.push(e);
    process.on("unhandledRejection", listen);
    const fetchSpy = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      render(
        <LanguageProvider locale="en">
          <GuardianMessaging />
        </LanguageProvider>
      );
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByTestId("guardian-messaging")).toBeNull();
      expect(lost).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });
});
