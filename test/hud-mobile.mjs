// Phone-shaped verification for Reality HUD: viewport fit, the recall pill (hide → tap → back),
// the settings row, touch drag, landscape clamp. Run against a Stronghold Protocol server:
//   npm install
//   node test/hud-mobile.mjs http://127.0.0.1:3000
//   npm run test:mobile -- [URL]
// CHROME_PATH overrides the Chrome executable; sensible defaults exist for Windows / macOS / Linux.
// Screenshots (mob-*.png) land in the OS temp dir, printed at the end.
//
// NOTE: all taps happen BEFORE the touch-drag — headless Chromium's CDP touch emulation swallows
// the compat click of the first tap after a touch-drag (a static div reproduces it; real devices
// are fine), so the drag stays the last pointer interaction that a tap must follow.
import puppeteer from "puppeteer-core";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH
  || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");
const URL = process.argv[2] || "http://127.0.0.1:3000/";
const OUT = process.argv[3] || tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // /api/players 404s on a server that predates the route (the HUD degrades by design) — not a
  // page error
  if ((m.location()?.url || "").includes("/api/players")) return;
  // the game page pulls Google Fonts; on a network that cannot reach fonts.googleapis.com the
  // load dies with net::ERR_CONNECTION_CLOSED — environmental, not a page error
  if (/fonts\.(googleapis|gstatic)\.com/.test(m.location()?.url || "")) return;
  errors.push(`console: ${m.text()}`);
});

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(() => localStorage.removeItem("reality-hud.v2"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#reality-hud", { timeout: 30000 });
await sleep(7000);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const shot = (name) => page.screenshot({ path: join(OUT, name) });

// 1) the panel fits the phone viewport
const fit = await page.evaluate(() => {
  const r = document.querySelector("#reality-hud").getBoundingClientRect();
  return { left: Math.round(r.left), width: Math.round(r.width), right: Math.round(r.right), vw: innerWidth, vh: innerHeight };
});
check("面板适配手机宽度", fit.right <= fit.vw && fit.left >= 0 && fit.width <= 390, JSON.stringify(fit));
await shot("mob-open.png");

// 2) hide → the recall pill appears, on screen (the phone's way home: there is no Shift+H)
await page.tap("#rh-close");
await sleep(400);
const pill = await page.evaluate(() => {
  const p = document.querySelector("#rh-recall");
  if (!p || p.hidden) return null;
  const r = p.getBoundingClientRect();
  return { w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
});
check("隐藏后浮标出现在屏内", !!pill && pill.left >= 0 && pill.bottom <= pill.vh, JSON.stringify(pill));
await shot("mob-pill.png");

// 3) tap the pill → the panel is back
await page.tap("#rh-recall");
await sleep(500);
const back = await page.evaluate(() => ({
  mounted: globalThis.__REALITY_HUD__.state.mounted,
  pillHidden: document.querySelector("#rh-recall")?.hidden !== false,
}));
check("点浮标唤回面板", back.mounted && back.pillHidden, JSON.stringify(back));

// 4) menu → 打开设置 on a phone screen (before the drag below — see the note at the top)
await page.tap("#rh-menu-btn");
await sleep(300);
await page.tap("#rh-menu-settings");
await sleep(500);
const setFits = await page.evaluate(() => {
  const p = document.querySelector("#rh-page-settings");
  return !!p && p.classList.contains("is-active") && p.offsetParent !== null && globalThis.__REALITY_HUD__.state.cfg.show.settings === true;
});
check("手机上可打开设置页", setFits);
await shot("mob-settings.png");

// 4b) touch navigation: back to the home grid, then a card opens its page
await page.tap("#rh-page-settings .rh-back");
await sleep(400);
await page.tap("#rh-card-perf");
await sleep(400);
check("手机上点卡片切页", await page.evaluate(() => document.querySelector("#rh-page-perf").classList.contains("is-active")));
await page.tap("#rh-page-perf .rh-back");
await sleep(300);

// 5) drag the panel by its header with touch — the last interaction a tap must follow
const hb = await (await page.$(".rh-head")).boundingBox();
await page.touchscreen.touchStart(hb.x + 60, hb.y + 12);
await page.touchscreen.touchMove(hb.x - 60, hb.y + 260);
await page.touchscreen.touchEnd();
await sleep(300);
const pos = await page.evaluate(() => {
  const r = document.querySelector("#reality-hud").getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top) };
});
check("触屏拖动面板生效", pos.left < hb.x && pos.top > hb.y, `head was ${Math.round(hb.x)},${Math.round(hb.y)} → now ${pos.left},${pos.top}`);

// 6) rotate to landscape: the height-aware clamp keeps the whole panel on screen
await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await sleep(700);
const land = await page.evaluate(() => {
  const r = document.querySelector("#reality-hud").getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight };
});
check("横屏仍在屏内", land.left >= 0 && land.top >= 0 && land.right <= land.vw && land.bottom <= land.vh, JSON.stringify(land));
await shot("mob-landscape.png");

check("全程无页面异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n===== mobile: ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(", "));
console.log(`screenshots: ${OUT}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
