import fs from "fs";
import { chromium, type Browser } from "playwright-core";

/**
 * A headless Chromium. Where this container keeps its browser it is used as
 * it is; elsewhere (CI) Playwright's own download, or CHROMIUM_PATH.
 */
export async function launch(): Promise<Browser> {
  const local = "/opt/pw-browsers/chromium";
  const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync(local) ? local : undefined);
  return chromium.launch({ executablePath, headless: true });
}
