// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";

import { LanguageProvider, LanguageToggle, useT } from "../../src/components/Language";
import { LOCALE_COOKIE } from "../../src/lib/i18n";

afterEach(() => {
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
  vi.restoreAllMocks();
});

describe("the language a page is in", () => {
  it("hands the right words to everything below it", () => {
    function Says() {
      const t = useT();
      return <p>{t("nav.classes")}</p>;
    }
    render(
      <LanguageProvider locale="ms">
        <Says />
      </LanguageProvider>
    );
    expect(screen.getByText("Kelas")).toBeTruthy();
  });

  it("falls back to English outside a provider, rather than showing a key", () => {
    function Says() {
      const t = useT();
      return <p>{t("nav.classes")}</p>;
    }
    render(<Says />);
    expect(screen.getByText("Classes")).toBeTruthy();
  });

  /**
   * The one that matters.
   *
   * `translator()` builds a new object per call, and `t` sits in the dependency
   * list of the callback that checks a customer in. If the provider hands down
   * a fresh one whenever anything above it re-renders, that effect fires again
   * — which means checking somebody in over and over. The provider memoises on
   * the locale, so a re-render that does not change the language changes
   * nothing below it.
   */
  it("hands back the same lookup when something above it re-renders", () => {
    const seen: unknown[] = [];
    let bumpParent: () => void = () => {};

    function Watches() {
      seen.push(useT());
      return null;
    }
    function Above() {
      const [n, setN] = useState(0);
      bumpParent = () => setN(n + 1);
      return (
        <LanguageProvider locale="en">
          <Watches />
        </LanguageProvider>
      );
    }

    render(<Above />);
    act(() => bumpParent());
    act(() => bumpParent());
    expect(seen.length, "the provider did not actually re-render").toBeGreaterThan(2);
    expect(new Set(seen).size, "a re-render above handed down a fresh lookup").toBe(1);
  });

  it("does not re-run an effect that depends on it", () => {
    const ran = { count: 0 };
    let renders = 0;
    let bumpParent: () => void = () => {};

    function ChecksIn() {
      renders++;
      const t = useT();
      const label = useRef("");
      useEffect(() => {
        ran.count++;
        label.current = t("checkin.working");
      }, [t]);
      return null;
    }
    function Above() {
      const [n, setN] = useState(0);
      bumpParent = () => setN(n + 1);
      return (
        <LanguageProvider locale="en">
          <ChecksIn />
        </LanguageProvider>
      );
    }

    render(<Above />);
    act(() => bumpParent());
    act(() => bumpParent());
    expect(renders, "the component did not actually re-render").toBeGreaterThan(2);
    expect(ran.count, "the effect fired again on a re-render above").toBe(1);
  });

  it("gives a different lookup when the language actually changes", () => {
    const seen: string[] = [];
    function Says() {
      const t = useT();
      seen.push(t("nav.classes"));
      return null;
    }
    const { rerender } = render(
      <LanguageProvider locale="en">
        <Says />
      </LanguageProvider>
    );
    rerender(
      <LanguageProvider locale="ms">
        <Says />
      </LanguageProvider>
    );
    expect(seen[0]).toBe("Classes");
    expect(seen[seen.length - 1]).toBe("Kelas");
  });
});

describe("switching language", () => {
  it("writes the cookie and reloads, so the server agrees with the page", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(
      <LanguageProvider locale="en">
        <LanguageToggle />
      </LanguageProvider>
    );
    screen.getByRole("button", { name: "ms" }).click();

    expect(document.cookie).toContain(`${LOCALE_COOKIE}=ms`);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing when you pick the language you are already in", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(
      <LanguageProvider locale="en">
        <LanguageToggle />
      </LanguageProvider>
    );
    screen.getByRole("button", { name: "en" }).click();
    expect(reload).not.toHaveBeenCalled();
  });

  it("marks which one is current, for a reader who cannot see the colour", () => {
    render(
      <LanguageProvider locale="ms">
        <LanguageToggle />
      </LanguageProvider>
    );
    expect(screen.getByRole("button", { name: "ms" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "en" }).getAttribute("aria-current")).toBe(null);
  });
});
