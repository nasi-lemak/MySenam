/**
 * Loaded into the tournament-day scenario's own server only (NODE_OPTIONS, set by tests/uat/day-support.ts), never by the
 * app and never by the main acceptance server. A tournament cannot be made for today, so a tournament's day cannot be met on
 * the real one: this moves the clock of that one process. The scenario writes how many milliseconds the clock is ahead of
 * the real one into the file named by UAT_CLOCK_FILE, and the clock then runs at the real speed from there. Without
 * UAT_CLOCK_FILE this does nothing. (A proxy, not a subclass of Date: the database engine in the app's process does not
 * start under a subclass.)
 */
import fs from "node:fs";

const file = process.env.UAT_CLOCK_FILE;
if (file) {
  const RealDate = Date;
  let offset = 0;
  let readAt = 0;
  const now = () => {
    const real = RealDate.now();
    if (real - readAt > 50) {
      readAt = real;
      try {
        offset = Number(fs.readFileSync(file, "utf8")) || 0;
      } catch {
        // not written yet: the real clock
      }
    }
    return real + offset;
  };
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget === globalThis.Date ? target : newTarget);
    },
    get(target, prop, receiver) {
      if (prop === "now") return now;
      return Reflect.get(target, prop, receiver);
    },
  });
}
