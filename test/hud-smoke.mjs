// Smoke + interaction test for Reality HUD. Run against a Stronghold Protocol server:
//   npm install
//   node test/hud-smoke.mjs http://127.0.0.1:3000
// CHROME_PATH overrides the Chrome executable; sensible defaults exist for Windows / macOS / Linux.
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH
  || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");
const URL = process.argv[2] || "http://127.0.0.1:3000/";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // /api/players 404s on a server that predates the route (the HUD degrades by design and polls
  // only once) — that is a network log line, not a page error
  if ((m.location()?.url || "").includes("/api/players")) return;
  errors.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(() => localStorage.removeItem("reality-hud.v2"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 7000));

const settle = () => new Promise((r) => setTimeout(r, 300));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const api = await page.evaluate(() => ({
  mounted: !!document.querySelector("#reality-hud"),
  ver: globalThis.__REALITY_HUD__?.version,
  author: globalThis.__REALITY_HUD__?.author,
}));
check("面板已挂载", api.mounted);
check("版本 1.5.0", api.ver === "1.5.0", String(api.ver));
check("作者署名 Reality", api.author === "Reality", String(api.author));

// v1.4.2: no brand text in the chrome, 邀请 leads the sections, the footer links are icons
const chrome = await page.evaluate(() => {
  const root = document.querySelector("#reality-hud");
  return {
    title: root.querySelector(".rh-title")?.textContent,
    visSecs: [...root.querySelectorAll(".rh-body .rh-sec")].filter((s) => !s.hidden).slice(0, 4).map((s) => s.id).join(","),
    footLinks: [...root.querySelectorAll(".rh-foot a")].map((a) => ({ href: a.getAttribute("href"), icon: !!a.querySelector(".rh-icon") })),
    footText: root.querySelector(".rh-foot")?.textContent || "",
  };
});
check("标题为 R HUD（无品牌字）", chrome.title === "R HUD", String(chrome.title));
check("邀请区块在最前", chrome.visSecs === "rh-sec-invite,rh-sec-match,rh-sec-server,rh-sec-perf", chrome.visSecs);
check("页脚两个图标链接（仓库 + 博客）", chrome.footLinks.length === 2
  && chrome.footLinks.every((l) => l.icon)
  && chrome.footLinks.some((l) => l.href.includes("Stronghold-Protocol-Reality-HUD"))
  && chrome.footLinks.some((l) => l.href.includes("reality-blog"))
  && !/reality-blog\.asia/.test(chrome.footText),
  JSON.stringify(chrome.footLinks));

// --- header is down to three buttons ---------------------------------------------------------
const btns = await page.evaluate(() => [...document.querySelectorAll(".rh-head-actions .rh-ibtn")].map((b) => b.id));
check("标题栏只剩 3 个按钮", btns.length === 3, btns.join(","));
check("按钮为 折叠/菜单/关闭", btns.join(",") === "rh-fold,rh-menu-btn,rh-close", btns.join(","));

// --- collapsed shrinks to a pill -------------------------------------------------------------
const expanded = await page.evaluate(() => {
  const r = document.querySelector("#reality-hud").getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
await page.click("#rh-fold");
await settle();
const collapsed = await page.evaluate(() => {
  const el = document.querySelector("#reality-hud");
  const r = el.getBoundingClientRect();
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    collapsed: el.classList.contains("is-collapsed"),
    bodyHidden: getComputedStyle(el.querySelector(".rh-body")).display === "none",
    onlyFold: [...el.querySelectorAll(".rh-head-actions .rh-ibtn")]
      .filter((b) => getComputedStyle(b).display !== "none").map((b) => b.id),
  };
});
check("折叠后明显变窄", collapsed.collapsed && collapsed.w < expanded.w * 0.55, `${expanded.w} -> ${collapsed.w}px`);
check("折叠后只剩标题条", collapsed.bodyHidden && collapsed.h < expanded.h * 0.5, `${expanded.h} -> ${collapsed.h}px`);
check("折叠后只显示折叠按钮", collapsed.onlyFold.join(",") === "rh-fold", collapsed.onlyFold.join(","));

// expanding restores the previous width
await page.click("#rh-fold");
await settle();
const reExpanded = await page.evaluate(() => Math.round(document.querySelector("#reality-hud").getBoundingClientRect().width));
check("展开后恢复原宽度", Math.abs(reExpanded - expanded.w) <= 2, `${expanded.w} -> ${reExpanded}`);

// --- menu -------------------------------------------------------------------------------------
await page.click("#rh-menu-btn");
await settle();
const menuOpen = await page.evaluate(() => {
  const m = document.querySelector("#rh-menu");
  return {
    open: m.classList.contains("is-open"),
    visible: getComputedStyle(m).display !== "none",
    rows: [...m.querySelectorAll(".rh-menu-row")].map((r) => r.id),
  };
});
check("菜单能打开", menuOpen.open && menuOpen.visible);
check("菜单含 5 项", menuOpen.rows.join(",") === "rh-menu-pin,rh-menu-mini,rh-menu-pause,rh-menu-damage,rh-menu-settings", menuOpen.rows.join(","));

// toggling a row flips its own state text
const pinToggle = await page.evaluate(() => {
  const before = document.querySelector("#rh-menu-pin .rh-menu-state").textContent;
  document.querySelector("#rh-menu-pin").click();
  const after = document.querySelector("#rh-menu-pin .rh-menu-state").textContent;
  return { before, after, cls: document.querySelector("#rh-menu-pin").className };
});
check("菜单开关状态翻转", pinToggle.before !== pinToggle.after, `${pinToggle.before} -> ${pinToggle.after}`);

// mini mode via the menu
await page.evaluate(() => document.querySelector("#rh-menu-mini").click());
await settle();
const mini = await page.evaluate(() => document.querySelector("#reality-hud").classList.contains("rh-mini"));
check("菜单能开迷你模式", mini);
await page.evaluate(() => document.querySelector("#rh-menu-mini").click());
await settle();

// pause via the menu
await page.evaluate(() => document.querySelector("#rh-menu-pause").click());
await settle();
const paused = await page.evaluate(() => ({
  cfg: globalThis.__REALITY_HUD__.state.cfg.paused,
  perf: document.querySelector("#rh-perf-grid").textContent.trim(),
}));
check("菜单能暂停采样", paused.cfg === true, paused.perf);
await page.evaluate(() => document.querySelector("#rh-menu-pause").click());
await settle();

// v1.4.0: a real pointer press on a menu row must reach the row — the header drag used to start
// on any press that was not a header button, capturing the pointer on the header and retargeting
// the click away, so every menu row was dead (the synthetic .click() above bypassed that bug)
await page.click("#rh-menu-mini");
await settle();
check("真实点按菜单行（迷你开）", await page.evaluate(() => globalThis.__REALITY_HUD__.state.cfg.mini === true));
await page.click("#rh-menu-mini");
await settle();
check("真实点按菜单行（迷你关）", await page.evaluate(() => globalThis.__REALITY_HUD__.state.cfg.mini === false));

// 打开设置 must actually open it: the default preset has the section switched off AND folded
await page.click("#rh-menu-settings");
await settle();
const settingsShown = await page.evaluate(() => {
  const sec = document.querySelector("#rh-sec-settings");
  return !!sec && !sec.hidden && globalThis.__REALITY_HUD__.state.cfg.show.settings === true;
});
check("打开设置真正显示设置栏", settingsShown);

// regression for the buildSection boolean misuse (log head in v1.3.1, settings head in v1.4.0):
// a stray `true` argument used to render as visible text in the section header
const strayHeads = await page.evaluate(() => [...document.querySelectorAll(".rh-sec-head")]
  .map((h) => ({ label: h.querySelector(".rh-sec-label")?.textContent || "", stray: [...h.childNodes].some((n) => n.nodeType === 3 && /^true$/i.test(n.textContent.trim())) }))
  .filter((h) => h.stray));
check("分区标题无残留布尔文本", strayHeads.length === 0, JSON.stringify(strayHeads));

// that row closes the menu itself; reopen it so 「点击外部关闭菜单」 below starts from open
await page.click("#rh-menu-btn");
await settle();

// clicking outside closes the menu
await page.click("#rh-menu-btn");
await settle();
await page.evaluate(() => document.querySelector("#reality-hud .rh-sub").click());
await settle();
const closed = await page.evaluate(() => !document.querySelector("#rh-menu").classList.contains("is-open"));
check("点击外部关闭菜单", closed);

// --- the removed header buttons no longer exist ------------------------------------------------
const gone = await page.evaluate(() => ["rh-pin", "rh-pause", "rh-settings", "rh-mini-toggle"]
  .filter((id) => document.getElementById(id)));
check("旧按钮已移除", gone.length === 0, gone.join(","));

// --- FPS / latency still work ------------------------------------------------------------------
await new Promise((r) => setTimeout(r, 2000));
const perf = await page.evaluate(() => [...document.querySelectorAll("#rh-perf-grid .rh-metric")].map((m) => m.textContent.trim()));
check("FPS 有数值", perf.some((r) => /FPS\s*\d+/.test(r)), perf.join(" "));

// --- resize grip + drag still work --------------------------------------------------------------
const w0 = await page.evaluate(() => document.querySelector("#reality-hud").offsetWidth);
const grip = await (await page.$("#rh-grip")).boundingBox();
await page.mouse.move(grip.x + 8, grip.y + 8);
await page.mouse.down();
await page.mouse.move(grip.x - 60, grip.y + 8, { steps: 8 });
await page.mouse.up();
await settle();
const w1 = await page.evaluate(() => document.querySelector("#reality-hud").offsetWidth);
check("手柄可调宽度", Math.abs(w1 - w0) > 30, `${w0} -> ${w1}`);

const onScreen = await page.evaluate(() => {
  const r = document.querySelector("#reality-hud").getBoundingClientRect();
  return { right: Math.round(r.right), vw: innerWidth };
});
check("加宽后仍在屏内", onScreen.right <= onScreen.vw, `right=${onScreen.right} vw=${onScreen.vw}`);

// --- invite section v1.3.0: 免密钥 link · roster · incoming banner ------------------------------
const inviteSection = await page.evaluate(() => {
  const el = document.getElementById("rh-sec-invite");
  return el ? { visible: el.offsetParent !== null, label: el.querySelector(".rh-sec-label")?.textContent || "" } : null;
});
check("邀请分区存在且可见", !!inviteSection && inviteSection.visible && inviteSection.label === "邀请", JSON.stringify(inviteSection));

const inviteHint = await page.evaluate(() => document.getElementById("rh-invite-head")?.textContent || "");
check("未在同盟时提示免密钥链接", /未在同盟中/.test(inviteHint), inviteHint.slice(0, 40));

// the roster comes from GET /api/players (polls while the section is on screen).
// on a server that predates the route the HUD degrades instead (404 → hint, supported=false)
const roster = await page.evaluate(() => {
  const s = globalThis.__REALITY_HUD__.state;
  return { players: s.players, supported: s.playersSupported, err: s.playersError };
});
check("在线名单已拉取或旧服务端降级 (/api/players)",
  Array.isArray(roster.players) ? !roster.err : roster.supported === false,
  JSON.stringify({ supported: roster.supported, err: roster.err }));

const listText = await page.evaluate(() => document.getElementById("rh-invite-list")?.textContent || "");
check("名单渲染出提示或玩家行", /不支持在线名单|没有其他玩家在线|大厅|同盟中|对局中/.test(listText), listText.slice(0, 40));

// simulate being in a room: the免密钥 link appears.
// the HUD's frame handling hangs on net's '*' listener (the real _onMessage fires _emit(t) *and*
// _emit('*', msg)), so drive that directly — a typed emit would only hit the game's own listeners.
const fire = (msg) => page.evaluate((m) => { [...(globalThis.__SP__.net._listeners.get("*") || [])].forEach((fn) => fn(m)); }, msg);
await fire({ t: "room.state", code: "AB12CD", mode: "coop", difficulty: "NORMAL", seats: [], spectators: [], inMatch: false });
await settle();
const copyBtn = await page.evaluate(() => ({
  text: document.getElementById("rh-invite-copy-link")?.textContent || "",
  code: document.getElementById("rh-invite-code")?.textContent || "",
  url: document.querySelector(".rh-invite-url")?.textContent || "",
}));
check("在同盟时给出房间码与复制按钮", copyBtn.text === "复制邀请链接" && copyBtn.code === "AB12CD", JSON.stringify(copyBtn));
check("链接格式 ?room=CODE", copyBtn.url.includes("?room=AB12CD"), copyBtn.url);

// a room.invited push becomes a banner with 立即加入 / 忽略
await fire({ t: "room.invited", from: "p_smoke", name: "烟测好友", code: "ZZ99YY" });
await settle();
const toast = await page.evaluate(() => {
  const el = document.getElementById("rh-invite-toast");
  return el && !el.hidden
    ? { text: el.textContent, join: !!document.getElementById("rh-invite-join"), dismiss: !!document.getElementById("rh-invite-dismiss") }
    : null;
});
check("收到邀请弹出横幅", !!toast && /烟测好友/.test(toast.text) && /ZZ99YY/.test(toast.text) && toast.join && toast.dismiss, JSON.stringify(toast)?.slice(0, 90));

// fold every section: the banner sits above the hero and stays visible
await page.evaluate(() => document.querySelectorAll(".rh-sec-head .rh-mini[title^='折叠']").forEach((b) => { if (b.textContent === "−") b.click(); }));
await settle();
const toastFolded = await page.evaluate(() => { const el = document.getElementById("rh-invite-toast"); return !!el && !el.hidden && el.offsetParent !== null; });
check("折叠分区也不遮挡邀请横幅", toastFolded);

// 立即加入 with no session entered: a warning, the banner stays, nothing throws
await page.evaluate(() => document.getElementById("rh-invite-join")?.click());
await settle();
check("未进入游戏时加入被拦下并提示", await page.evaluate(() => globalThis.__REALITY_HUD__.state.logs.some((e) => /请先/.test(e.text))));
check("加入被拦下后横幅仍在", await page.evaluate(() => !document.getElementById("rh-invite-toast").hidden));

// 忽略 clears the banner
await page.evaluate(() => document.getElementById("rh-invite-dismiss")?.click());
await settle();
check("忽略后横幅消失", await page.evaluate(() => document.getElementById("rh-invite-toast").hidden && globalThis.__REALITY_HUD__.state.invites.length === 0));

// unfold everything again, then leave the simulated room
await page.evaluate(() => document.querySelectorAll(".rh-sec-head .rh-mini[title^='折叠']").forEach((b) => { if (b.textContent === "+") b.click(); }));
await fire({ t: "room.closed", reason: "empty" });
await settle();

// --- server error detail is still surfaced ------------------------------------------------------
const logDetail = await page.evaluate(async () => {
  globalThis.__REALITY_HUD__.state.logs.length = 0;
  const handlers = globalThis.__SP__.net._listeners.get("*");
  handlers.forEach((fn) => fn({ t: "error", code: "BAD_MSG", msg: "无效的请求", detail: "bad field difficulty", rid: 7 }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return [...document.querySelectorAll("#rh-log .rh-line")].map((r) => ({
    cls: r.className,
    head: r.querySelector(".rh-line-head")?.textContent.trim(),
    body: r.querySelector(".rh-line-body")?.textContent.trim() || null,
  }));
});
const errRow = logDetail.find((r) => r.cls.includes("is-error"));
check("错误详情含 detail 与错误码", !!errRow && /bad field difficulty/.test(errRow.body || "") && /BAD_MSG/.test(errRow.body || ""), errRow?.body?.slice(0, 70));

// --- perf -----------------------------------------------------------------------------
const cost = await page.evaluate(async () => {
  const N = 120;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    globalThis.__REALITY_HUD__.state.pingHistory.push(100 + (i % 7));
    document.querySelector("#rh-ping").textContent = String(100 + (i % 7));
  }
  const perUpdate = (performance.now() - t0) / N;
  const frames = [];
  await new Promise((res) => {
    let n = 0, prev = performance.now();
    const step = (t) => { frames.push(t - prev); prev = t; if (++n < 60) requestAnimationFrame(step); else res(); };
    requestAnimationFrame(step);
  });
  frames.shift();
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  return { perUpdate, avgFrameMs: avg, fps: Math.round(1000 / avg) };
});
check("单次更新 < 1ms", cost.perUpdate < 1, `${cost.perUpdate.toFixed(3)}ms`);
check("平均帧间隔正常", cost.avgFrameMs < 20, `${cost.avgFrameMs.toFixed(1)}ms (~${cost.fps}fps)`);

// hide → the recall pill appears → tap it → the panel is back (the phone's way home, v1.4.0)
await page.click("#rh-close");
await new Promise((r) => setTimeout(r, 300));
const afterHide = await page.evaluate(() => ({
  mounted: globalThis.__REALITY_HUD__.state.mounted,
  pill: !!document.querySelector("#rh-recall") && !document.querySelector("#rh-recall").hidden,
}));
check("隐藏后浮标出现", !afterHide.mounted && afterHide.pill, JSON.stringify(afterHide));
await page.click("#rh-recall");
await new Promise((r) => setTimeout(r, 400));
const afterRecall = await page.evaluate(() => ({
  mounted: globalThis.__REALITY_HUD__.state.mounted,
  pillHidden: document.querySelector("#rh-recall")?.hidden !== false,
}));
check("点浮标唤回面板", afterRecall.mounted && afterRecall.pillHidden, JSON.stringify(afterRecall));

check("无页面错误", errors.length === 0, errors.slice(0, 2).join(" | "));

await page.evaluate(() => { if (!globalThis.__REALITY_HUD__.state.mounted) globalThis.__REALITY_HUD__.show(); });
await page.click("#rh-fold");
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: "hud-collapsed.png", clip: { x: 1000, y: 0, width: 440, height: 200 } });
await page.evaluate(() => { if (!globalThis.__REALITY_HUD__.state.mounted) globalThis.__REALITY_HUD__.show(); });
// the fold click above left the panel collapsed — expand again so hud-open.png really shows it open
if (await page.evaluate(() => document.querySelector("#reality-hud").classList.contains("is-collapsed"))) {
  await page.click("#rh-fold");
}
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: "hud-open.png", clip: { x: 820, y: 0, width: 620, height: 1000 } });

// phone widths (v1.4.1): the collapsed strip is the resting state — tiny; the pill is 36px
// (was 42px) and an invisible ring keeps its tap target ≈48px
await page.setViewport({ width: 390, height: 844 });
await settle();
await page.evaluate(() => { if (!globalThis.__REALITY_HUD__.state.mounted) globalThis.__REALITY_HUD__.show(); });
if (!(await page.evaluate(() => document.querySelector("#reality-hud").classList.contains("is-collapsed")))) {
  await page.click("#rh-fold");
  await settle();
}
const phoneStrip = await page.evaluate(() => {
  const r = document.querySelector("#reality-hud").getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
check("手机上折叠条更小", phoneStrip.w <= 90 && phoneStrip.h <= 25, `${phoneStrip.w}x${phoneStrip.h}px`);
await page.click("#rh-fold");
await settle();
await page.click("#rh-close");
await new Promise((r) => setTimeout(r, 300));
const phonePill = await page.evaluate(() => {
  const p = document.querySelector("#rh-recall");
  const r = p.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), visible: !p.hidden };
});
check("手机上浮标 36px", phonePill.visible && phonePill.w === 36 && phonePill.h === 36, `${phonePill.w}x${phonePill.h}px`);
await page.click("#rh-recall");
await new Promise((r) => setTimeout(r, 400));
check("手机上点浮标仍能唤回", await page.evaluate(() => globalThis.__REALITY_HUD__.state.mounted));

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(", "));
await browser.close();
process.exit(failed.length ? 1 : 0);
