// test/hud-damage.mjs — the damage tables (v1.7.0): the 伤害 page with its three tabs (干员 /
// 玩家 / 敌人), the per-tab 「独立窗口」 pop-out that moves the SAME table between the dock and its
// floating window, and the merge rules of the player table:
//   * live events feed the round counter;
//   * m.private stats.dmgDealt / m.result are match-cumulative — a 全局累计 floor only (merging them
//     as a per-round value inflated both columns every round, the 1.6.x bug);
//   * m.public players[].hudDmg (a server with the Reality HUD damage patch) carries the teammates'
//     round + total, stamped with its round, so a stale in-flight frame never lands in the next round;
//   * a hudDmg flagged `settled` (1.7.1) is the round's complete credited value: it SNAPS the row to it
//     in either direction — the local live count is a raw-hit estimate (overkill, element gauge ticks,
//     rounding) and used to keep its own 本回合 number while every teammate saw the server's.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/hud.css"><script>
const listeners = new Map();
const net = { status: "online", lastError: null, playerId: "p1", _listeners: listeners,
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
  send() {},
};
globalThis.__SP__ = { net, store: { get: () => ({ session: { entered: true }, me: { playerId: "p1" } }) } };
</script><script type="module" src="/hud.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, online: 1, rooms: 1, matches: 1 })); return; }
  if (req.url === "/api/players") { res.writeHead(404); res.end(); return; }
  const file = req.url === "/shared/constants.js" ? "test/fixture-constants.js" : req.url.slice(1);
  try { const body = await readFile(join(root, file)); res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/javascript" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const chrome = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", `--user-data-dir=${join(tmpdir(), "reality-hud-damage-test")}`] });
const page = await browser.newPage();
const failures = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`ok   ${name}`);
  else { failures.push(name); console.log(`FAIL ${name}  ${detail}`); }
};
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.removeItem("reality-hud.v2"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#reality-hud");
const emit = (msg) => page.evaluate((m) => { for (const fn of (globalThis.__SP__.net._listeners.get("*") || [])) fn(m); }, msg);

const playerRows = () => page.evaluate(() => [...document.querySelectorAll("#rh-damage-dock-players .rh-damage-player-row:not(.rh-damage-player-head)")]
  .map((r) => [...r.children].map((c) => c.textContent.trim())));
const operatorRows = () => page.evaluate(() => [...document.querySelectorAll("#rh-damage-dock-operators #rh-damage-table .rh-damage-row")]
  .map((r) => [...r.children].map((c) => c.textContent.trim())));
const rowFor = (rows, name) => rows.find((r) => String(r[0]).includes(name));

// ---- the 伤害 page: card, tabs, docks, no windows by default --------------------------------
await page.click("#rh-card-damage");
await wait();
const pageState = await page.evaluate(() => ({
  active: document.querySelector("#rh-page-damage")?.classList.contains("is-active"),
  docks: ["operators", "players", "enemies"].map((k) => !!document.querySelector(`#rh-damage-dock-${k}`)),
  tabs: ["operators", "players", "enemies"].map((k) => document.querySelector(`#rh-damage-tab-${k}`)?.textContent),
  activeTab: document.querySelector("#rh-damage-tab-operators")?.classList.contains("is-on"),
  tableInDock: !!document.querySelector("#rh-damage-dock-operators #rh-damage-table"),
  windows: ["rh-damage-window", "rh-players-damage-window", "rh-enemies-damage-window"].filter((id) => document.getElementById(id)).length,
  pop: document.querySelector("#rh-damage-pop")?.textContent,
}));
check("伤害页由首页卡片打开", pageState.active === true);
check("三个统计各有一个停靠位", pageState.docks.every(Boolean), JSON.stringify(pageState.docks));
check("标签为 干员/玩家/敌人", pageState.tabs.join(",") === "干员,玩家,敌人", JSON.stringify(pageState.tabs));
check("默认激活干员标签且表格停靠面板内", pageState.activeTab === true && pageState.tableInDock === true);
check("默认没有独立窗口，按钮为『独立窗口』", pageState.windows === 0 && pageState.pop === "独立窗口", JSON.stringify(pageState));

// ---- live frames fill all three tables -------------------------------------------------------
await emit({ t: "m.public", round: 1, phase: "COMBAT", lastRound: 14, players: [{ playerId: "p1", name: "玩家一" }, { playerId: "p2", name: "队友" }] });
await emit({ t: "m.field", units: [
  { id: "op_1", uid: "u1", name: "测试干员", kind: "op", side: "ally", ownerId: "p1" },
  { id: "enemy_1", name: "敌人", kind: "enemy", side: "enemy" },
] });
await emit({ t: "b.ev", ev: [
  ["atk", "op_1", "enemy_1", "none"],
  ["dmg", "enemy_1", 125, "phys"],
  ["status", "op_1", "shield", 1, 3],
  ["atk", "enemy_1", "op_1", "none"],
  ["dmg", "op_1", 999, "arts"],
] });
await wait();
const r1 = await page.evaluate(() => ({
  opsText: document.querySelector("#rh-damage-view-operators")?.textContent || "",
  enemies: [...document.querySelectorAll("#rh-damage-dock-enemies .rh-damage-row")].map((r) => r.textContent),
}));
const op1 = rowFor(await operatorRows(), "测试干员");
check("干员行：本回合 125 物理", op1 && op1[1] === "125" && /物理/.test(op1[3]), JSON.stringify(op1));
check("护盾 / 增益效果出现在干员视图", /护盾/.test(r1.opsText) && /增益/.test(r1.opsText), r1.opsText);
check("敌人表独立成行（敌人 999）", r1.enemies.some((t) => /敌人/.test(t) && /999/.test(t)), JSON.stringify(r1.enemies));
const p1First = rowFor(await playerRows(), "玩家一");
check("自己的玩家行：125 / 125，带『你』标记", p1First && p1First[0] === "玩家一（你）" && p1First[1] === "125" && p1First[2] === "125", JSON.stringify(p1First));

// ---- cumulative reports must not inflate (1.6.x bug) -----------------------------------------
await emit({ t: "m.private", playerId: "p1", name: "玩家一", stats: { dmgDealt: 125 } });
await wait();
let rows = await playerRows();
check("m.private 累计值不重复计入（125/125）", rowFor(rows, "玩家一")[1] === "125" && rowFor(rows, "玩家一")[2] === "125", JSON.stringify(rows));
check("无补丁数据时队友显示 —", rowFor(rows, "队友")[1] === "—" && rowFor(rows, "队友")[2] === "—", JSON.stringify(rows));

// ---- patched server rows (hudDmg) ------------------------------------------------------------
await emit({ t: "m.public", round: 1, phase: "COMBAT", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友", hudDmg: { round: 1, dmg: 80, total: 80 } },
] });
await wait();
rows = await playerRows();
check("补丁数据填充队友（80/80）", rowFor(rows, "队友")[1] === "80" && rowFor(rows, "队友")[2] === "80", JSON.stringify(rows));
const foot = await page.evaluate(() => document.querySelector("#rh-players-damage-foot")?.textContent || "");
check("玩家页脚提示服务器同步", /服务器每回合结算/.test(foot), foot);

// a stale frame (round 1) that arrives after the round advanced must not land in round 2
await emit({ t: "m.public", round: 2, phase: "ROUND_START", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友", hudDmg: { round: 1, dmg: 80, total: 80 } },
] });
await wait();
rows = await playerRows();
check("跨回合旧帧不落进新回合（0/80）", rowFor(rows, "队友")[1] === "0" && rowFor(rows, "队友")[2] === "80", JSON.stringify(rows));

await emit({ t: "m.public", round: 2, phase: "COMBAT", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友", hudDmg: { round: 2, dmg: 120, total: 200 } },
] });
await emit({ t: "m.field", units: [
  { id: "op_1", uid: "u1", name: "测试干员", kind: "op", side: "ally", ownerId: "p1" },
  { id: "enemy_1", name: "敌人", kind: "enemy", side: "enemy" },
] });
await emit({ t: "b.ev", ev: [["atk", "op_1", "enemy_1", "none"], ["dmg", "enemy_1", 75, "phys"]] });
await wait();
rows = await playerRows();
check("第 2 回合：自己 75/200，队友 120/200",
  rowFor(rows, "玩家一")[1] === "75" && rowFor(rows, "玩家一")[2] === "200" && rowFor(rows, "队友")[1] === "120" && rowFor(rows, "队友")[2] === "200",
  JSON.stringify(rows));
await emit({ t: "m.private", playerId: "p1", name: "玩家一", stats: { dmgDealt: 200 } });
await wait();
rows = await playerRows();
check("第 2 回合 m.private 累计 200 不改变本回合 75", rowFor(rows, "玩家一")[1] === "75" && rowFor(rows, "玩家一")[2] === "200", JSON.stringify(rows));

// ---- m.result: the match-cumulative final as a floor, never a per-round delta -----------------
await emit({ t: "m.result", result: { players: [
  { playerId: "p1", name: "玩家一", stats: { dmgDealt: 200 } },
  { playerId: "p2", name: "队友", stats: { dmgDealt: 900 } },
] } });
await wait();
rows = await playerRows();
check("结算：队友全局取终值 900（本回合保留 120）", rowFor(rows, "队友")[1] === "120" && rowFor(rows, "队友")[2] === "900", JSON.stringify(rows));
check("结算：自己不重复计数（75/200）", rowFor(rows, "玩家一")[1] === "75" && rowFor(rows, "玩家一")[2] === "200", JSON.stringify(rows));

// ---- pop-out / dock-back ---------------------------------------------------------------------
await page.click("#rh-damage-pop");
await wait();
const popped = await page.evaluate(() => ({
  win: !!document.getElementById("rh-damage-window"),
  winHasTable: !!document.querySelector("#rh-damage-window #rh-damage-table"),
  placeholder: !!document.querySelector("#rh-damage-dock-operators .rh-damage-detached"),
  label: document.querySelector("#rh-damage-pop")?.textContent,
}));
check("『独立窗口』把干员表弹成 #rh-damage-window", popped.win === true && popped.winHasTable === true, JSON.stringify(popped));
check("停靠位留下『已在独立窗口』占位", popped.placeholder === true, JSON.stringify(popped));
check("按钮变为『收回窗口』", popped.label === "收回窗口", popped.label);
const popRows = await page.evaluate(() => [...document.querySelectorAll("#rh-damage-window #rh-damage-table .rh-damage-row")].map((r) => r.textContent));
check("独立窗口内仍是同一张表（数据在）", popRows.some((t) => /测试干员/.test(t) && /75/.test(t)), JSON.stringify(popRows));

await page.click("#rh-damage-window .rh-ibtn--x");
await wait();
const dockedBack = await page.evaluate(() => ({
  win: !!document.getElementById("rh-damage-window"),
  inDock: !!document.querySelector("#rh-damage-dock-operators #rh-damage-table"),
  label: document.querySelector("#rh-damage-pop")?.textContent,
}));
check("× 收回：窗口消失、表格回到面板、按钮复位", dockedBack.win === false && dockedBack.inDock === true && dockedBack.label === "独立窗口", JSON.stringify(dockedBack));

await page.click("#rh-damage-tab-players");
await page.click("#rh-damage-pop");
await wait();
const playersPop = await page.evaluate(() => ({
  win: !!document.querySelector("#rh-players-damage-window #rh-players-damage-body"),
  dockPlaceholder: !!document.querySelector("#rh-damage-dock-players .rh-damage-detached"),
  keptRows: [...document.querySelectorAll("#rh-players-damage-window .rh-damage-player-row")].length,
}));
check("玩家标签可独立弹出（同一份数据）", playersPop.win === true && playersPop.dockPlaceholder === true && playersPop.keptRows >= 3, JSON.stringify(playersPop));
await page.click("#rh-players-damage-window .rh-ibtn--x");
await wait();

// ---- round reset: 本回合 clears, 全局累计 stays -----------------------------------------------
await emit({ t: "m.public", round: 3, phase: "ROUND_START", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友", hudDmg: { round: 3, dmg: 0, total: 200 } },
] });
await wait();
const op3 = rowFor(await operatorRows(), "测试干员");
check("回合切换：干员本回合清零、全局保留 200", op3 && op3[1] === "0" && op3[2] === "200", JSON.stringify(op3));

// ---- several teammates: every row keeps its own numbers (no swap, no double count) ------------
// 队友此前累计 900（上面的结算），本回合 +61 → 961；小队长是全新一行，233 不翻倍
const teamFrame = (order) => {
  const rows = {
    p1: { playerId: "p1", name: "玩家一" },
    p2: { playerId: "p2", name: "队友", hudDmg: { round: 4, dmg: 61, total: 961 } },
    p3: { playerId: "p3", name: "小队长", hudDmg: { round: 4, dmg: 233, total: 233 } },
  };
  return { t: "m.public", round: 4, phase: "COMBAT", lastRound: 14, players: order.map((k) => rows[k]) };
};
await emit(teamFrame(["p1", "p2", "p3"]));
await wait();
rows = await playerRows();
check("三个队友各归各：队友 61/961、小队长 233/233",
  rowFor(rows, "队友")[1] === "61" && rowFor(rows, "队友")[2] === "961"
  && rowFor(rows, "小队长")[1] === "233" && rowFor(rows, "小队长")[2] === "233", JSON.stringify(rows));
check("自己的行不混入队友数字（0/200）",
  rowFor(rows, "玩家一")[1] === "0" && rowFor(rows, "玩家一")[2] === "200", JSON.stringify(rows));
// the same frame again (the server refreshes the view): the high-water guard must not add it twice
await emit(teamFrame(["p1", "p2", "p3"]));
await wait();
rows = await playerRows();
check("同一帧重复到达不重复计入（仍 61/961 与 233/233）",
  rowFor(rows, "队友")[1] === "61" && rowFor(rows, "队友")[2] === "961"
  && rowFor(rows, "小队长")[2] === "233", JSON.stringify(rows));
// the server lists them in another order: rows follow playerId, never the position in the frame
await emit(teamFrame(["p3", "p1", "p2"]));
await wait();
rows = await playerRows();
check("乱序帧不按位置串行（队友 61/961、小队长 233/233）",
  rowFor(rows, "队友")[2] === "961" && rowFor(rows, "小队长")[2] === "233", JSON.stringify(rows));
// a later frame of the same round tops up only the difference and keeps the other row untouched
await emit({ t: "m.public", round: 4, phase: "COMBAT", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友", hudDmg: { round: 4, dmg: 90, total: 990 } },
  { playerId: "p3", name: "小队长", hudDmg: { round: 4, dmg: 233, total: 233 } },
] });
await wait();
rows = await playerRows();
check("同回合刷新只补差额（队友 90/990，小队长不动）",
  rowFor(rows, "队友")[1] === "90" && rowFor(rows, "队友")[2] === "990"
  && rowFor(rows, "小队长")[1] === "233" && rowFor(rows, "小队长")[2] === "233", JSON.stringify(rows));

// ---- settled snapshots: the round's server number wins over the local live estimate (1.7.1) ----------
// The 1.7.1 bug: live counting sums raw hit events (overkill on killing blows, element gauge ticks, per-hit
// rounding), so the own row read e.g. 300 while the settlement credited 180 — and the old top-up-only merge
// kept 300 on this screen forever while every teammate saw 180. A `settled` frame now snaps 本回合 AND
// 全局累计 to the server's numbers, in either direction.
await emit({ t: "m.public", round: 5, phase: "COMBAT", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友", hudDmg: { round: 4, dmg: 90, total: 990 } },
  { playerId: "p3", name: "小队长", hudDmg: { round: 4, dmg: 233, total: 233 } },
] });
await emit({ t: "m.field", units: [
  { id: "op_1", uid: "u1", name: "测试干员", kind: "op", side: "ally", ownerId: "p1" },
  { id: "enemy_1", name: "敌人", kind: "enemy", side: "enemy" },
] });
await emit({ t: "b.ev", ev: [["atk", "op_1", "enemy_1", "none"], ["dmg", "enemy_1", 300, "phys"]] });
await wait();
rows = await playerRows();
check("结算前：本行按本地事件读到 300 / 500",
  rowFor(rows, "玩家一")[1] === "300" && rowFor(rows, "玩家一")[2] === "500", JSON.stringify(rows));
const settledFrame = () => ({ t: "m.public", round: 5, phase: "SETTLE", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一", hudDmg: { round: 5, dmg: 180, total: 380, settled: true } },
  { playerId: "p2", name: "队友", hudDmg: { round: 5, dmg: 250, total: 1240, settled: true } },
  { playerId: "p3", name: "小队长", hudDmg: { round: 5, dmg: 0, total: 233, settled: true } },
] });
await emit(settledFrame());
await wait();
rows = await playerRows();
check("结算快照把本行 300 → 180、500 → 380（修正为服务器值，可降）",
  rowFor(rows, "玩家一")[1] === "180" && rowFor(rows, "玩家一")[2] === "380", JSON.stringify(rows));
check("队友行同样取结算值（250 / 1.2k）",
  rowFor(rows, "队友")[1] === "250" && rowFor(rows, "队友")[2] === "1.2k", JSON.stringify(rows));
check("结算后的类型拆分跟随新值缩放（物理 180）", /物理 180/.test(rowFor(rows, "玩家一")[3]), JSON.stringify(rowFor(rows, "玩家一")));
await emit(settledFrame());
await wait();
rows = await playerRows();
check("重复结算帧幂等（仍 180 / 380）",
  rowFor(rows, "玩家一")[1] === "180" && rowFor(rows, "玩家一")[2] === "380", JSON.stringify(rows));
await emit({ t: "m.public", round: 6, phase: "ROUND_START", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一" },
  { playerId: "p2", name: "队友" },
  { playerId: "p3", name: "小队长" },
] });
await wait();
rows = await playerRows();
check("下一回合：本回合清零、全局维持结算值 380",
  rowFor(rows, "玩家一")[1] === "0" && rowFor(rows, "玩家一")[2] === "380", JSON.stringify(rows));
// a frame without the flag keeps the old floor rule: top up only, never lower
await emit({ t: "m.public", round: 6, phase: "COMBAT", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一", hudDmg: { round: 6, dmg: 40, total: 380 } },
] });
await emit({ t: "m.public", round: 6, phase: "COMBAT", lastRound: 14, players: [
  { playerId: "p1", name: "玩家一", hudDmg: { round: 6, dmg: 25, total: 380 } },
] });
await wait();
rows = await playerRows();
check("无 settled 的实时帧只上不下（40 保持、累计随实时增量到 420，25 被忽略）",
  rowFor(rows, "玩家一")[1] === "40" && rowFor(rows, "玩家一")[2] === "420", JSON.stringify(rows));

// ---- the menu row opens the page -------------------------------------------------------------
await page.click("#rh-page-damage .rh-back");
await wait();
await page.click("#rh-menu-btn");
await page.click("#rh-menu-damage");
await wait();
check("菜单『伤害统计』打开伤害页", await page.evaluate(() => document.querySelector("#rh-page-damage")?.classList.contains("is-active") === true));

await browser.close();
server.close();
if (failures.length) {
  console.log(`damage smoke: ${failures.length} FAIL of ${checks}`);
  process.exit(1);
}
console.log(`damage smoke: pass (${checks} checks)`);
