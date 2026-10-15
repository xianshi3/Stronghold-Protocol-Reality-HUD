import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/hud.css"><script>
const listeners = new Map();
const net = { status: "online", lastError: null, _listeners: listeners,
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
  send() {},
};
globalThis.__SP__ = { net, store: { get: () => ({ session: { entered: true }, me: { playerId: "p1" } }) } };
</script><script type="module" src="/hud.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, online: 1, rooms: 1, matches: 1 })); return; }
  if (req.url === "/api/players") { res.writeHead(404); res.end(); return; }
  const file = req.url === "/shared/constants.js" ? "fixture-constants.js" : req.url.slice(1);
  try { const body = await readFile(join(root, file)); res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/javascript" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const chrome = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", `--user-data-dir=${join(tmpdir(), "reality-hud-damage-test")}`] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#rh-damage-window");
const emit = (msg) => page.evaluate((m) => { for (const fn of (globalThis.__SP__.net._listeners.get("*") || [])) fn(m); }, msg);
await emit({ t: "m.public", round: 1, phase: "COMBAT", lastRound: 14 });
await emit({ t: "m.field", units: [
  { id: "op_1", uid: "u1", name: "测试干员", kind: "op", side: "ally" },
  { id: "enemy_1", name: "敌人", kind: "enemy", side: "enemy" },
] });
await emit({ t: "b.ev", ev: [
  ["atk", "op_1", "enemy_1", "none"],
  ["dmg", "enemy_1", 125, "phys"],
  ["status", "op_1", "shield", 1, 3],
  ["atk", "enemy_1", "op_1", "none"],
  ["dmg", "op_1", 999, "arts"],
] });
await new Promise((r) => setTimeout(r, 80));
const first = await page.evaluate(() => ({
  text: document.querySelector("#rh-damage-window")?.textContent || "",
  rows: [...document.querySelectorAll("#rh-damage-table .rh-damage-row")].map((r) => r.textContent),
}));
if (!first.rows.some((r) => /测试干员/.test(r) && /125/.test(r) && /物理/.test(r))) throw new Error(`damage row missing: ${JSON.stringify(first)}`);
if (first.rows.some((r) => /敌人/.test(r))) throw new Error(`enemy was rendered as operator: ${JSON.stringify(first.rows)}`);
if (!/护盾/.test(first.text) || !/增益/.test(first.text)) throw new Error(`effect missing: ${first.text}`);
await emit({ t: "m.public", round: 2, phase: "ROUND_START", lastRound: 14 });
await new Promise((r) => setTimeout(r, 80));
const second = await page.evaluate(() => [...document.querySelectorAll("#rh-damage-table .rh-damage-row")].map((r) => r.textContent));
if (!second.some((r) => /测试干员/.test(r) && /0/.test(r) && /125/.test(r))) throw new Error(`round reset missing: ${JSON.stringify(second)}`);
await page.click("#rh-menu-btn");
await page.click("#rh-menu-damage");
if (await page.$("#rh-damage-window")) throw new Error("damage window did not close");
await page.click("#rh-menu-btn");
await page.click("#rh-menu-damage");
if (!(await page.$("#rh-damage-window"))) throw new Error("damage window did not reopen");
console.log("damage smoke: pass");
await browser.close();
server.close();
