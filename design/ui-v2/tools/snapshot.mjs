// Save the rendered DOM of a running page so tools/audit.py can check JS-rendered screens.
// Usage (repo root, app running on :3000):
//   node design/ui-v2/tools/snapshot.mjs http://localhost:3000/ out/Home.html [width]
// Uses Playwright (npm i -D playwright, or a global install). Sign in first in a headed run if the page needs a session.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const [url, out, width = "412"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: snapshot.mjs <url> <out.html> [width]"); process.exit(2); }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
writeFileSync(out, "<!doctype html>\n" + (await page.content()));
await page.screenshot({ path: out.replace(/\.html$/, ".png"), fullPage: true });
console.log(`saved ${out} (compatMode ${await page.evaluate(() => document.compatMode)})`);
await browser.close();
