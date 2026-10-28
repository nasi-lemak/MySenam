"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** What can take the keyboard's focus inside the dialog, in order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog, as a keyboard and a screen reader know one (audit R8
 * X2-17): `role="dialog"` and `aria-modal`, named by its heading
 * (`labelledBy`, the id the caller puts on it) and described by what matters
 * most in it (`describedBy`: a booking's code); the focus moved into it when
 * it opens (onto an element marked `data-autofocus`, else the dialog itself,
 * so its name is read first), kept inside it by Tab and Shift+Tab, Escape to
 * close, and the focus given back to where it was when it closes.
 *
 * The one dialog the customer pages use: the booking confirmation and the
 * waiting list on a venue's grid, and enrolling in a class.
 */
export default function Dialog({
  labelledBy,
  describedBy,
  onClose,
  children,
  className = "w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl",
}: {
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  children: ReactNode;
  /** The panel's own classes: its width, padding, scrolling. */
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the focus effect when a parent renders a new function.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    if (el) (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus();
    return () => {
      // Back to what opened it, where that is still on the page (a booking form that closed is not).
      if (before && before.isConnected) before.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.hasAttribute("disabled"));
    if (items.length === 0) {
      e.preventDefault();
      panel.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`${className} focus:outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
