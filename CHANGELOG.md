# Changelog

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [1.8.0] - 2026-10-16

### Added

- **正常回合 / 联防队友伤害实时同步（服务端补丁扩展）**：客户端战斗模式下，服务器看不见客户端上正在模拟的战场伤害——此前队友的本回合伤害要等**回合结算**（Boss 轮约每秒）才可见，就是「只有结束才算伤害」。现在打上新版补丁的服务器在 `m.public` 顶层带 `hudRelay` 广告；HUD 看到广告后，在自家战场战斗（COMBAT / 联防）时每 2 秒把**自己**的实时伤害经 `m.hudDmg { dmg }` 上报，服务器并入 `m.public players[].hudDmg` 的实时份额（未 settled）——所有队友屏幕实时看到各自的伤害；回合结算照旧用服务器结算值校正（上报值被清除，绝不重复计数）。
- **上报零打扰**：HUD 只在看到 `hudRelay` 广告后才上报——旧服务器 / 未打补丁服务器收不到任何未知消息（也就不会弹错误提示）；服务器侧限流 1.5s/人、只收 COMBAT / 联防、非法值拒绝、服务器运行模式自动忽略；未装 HUD 的玩家不报，其行照旧结算才可见。

### Changed

- 服务端补丁更新（`server-patch/reality-hud-damage.patch` 重新生成：8 个代码文件 + 3 篇文档 + 3 个测试）：`m.public.hudRelay` 广告、C2S `m.hudDmg` 路由与限流、`_hudDmgView` 并入上报值、结算盖章清除上报；协议文档同步。已打 1.7.1 补丁的服务器**建议更新**（旧补丁照常工作，只是没有实时上报）。
- 测试：`npm run test:damage` 49 项（新增 2 项上报用例）；服务端补丁测试 4 → 6 例。

## [1.7.2] - 2026-10-16

### Fixed

- **共享战场里「谁打都算我的」**：战斗事件用**每场战斗重新计数的运行时单位 id** 指认单位，而伤害记录按**干员 uid** 建行——两个 id 空间都是小整数，运行时 id 与某个 uid 撞号时，命中会记到那条 uid 记录（恰是别人、或自己的别位干员）头上；两处战场复用同一个运行时 id 时（观战队友、或同一块场地的下一场），还会按注册顺序串到先注册的那条。**队友帮忙防（联防）**里这最显眼：帮防队友的单位带着全新小 id 部署，撞上被帮防者（或任意玩家）低 uid 的干员行——「谁打都算我的」。1.7.1 的服务端来源标注挡不住这两条路径（来源 id 本身也要在正确的 id 空间里解析）。现在每个战场上下文（field / battle）维护一份 **运行时 id → 干员记录** 索引：命中在自己的战场里解析，绝不跨场；uid 只用于把同一干员的各场数据（本场、联防、结算快照）合并成一行。**来自 [Kriss-wq](https://github.com/Kriss-wq) 的 [PR #4](https://github.com/xianshi3/Stronghold-Protocol-Reality-HUD/pull/4)**（按其方案在 v1.7.1 代码上重做，保留 uid 合并与三表页面）。
- **无来源帧的保守归属（vanilla 服务器）**：没有来源 id 的旧帧仍按攻击顺序推算，但同一目标上出现**多名不同攻击者**在飞时不再按队列顺序硬猜（记入 未归属），只有队列里只剩一个攻击者时才照常归属；同一干员的多段攻击不受影响。

### Changed

- 测试：`npm run test:damage` 新增 6 项（运行时 id 撞 uid、跨战场同号 id、联防帮防各归各、双攻击者不猜、单一攻击者照常）——41 → 47 项。
- 服务端补丁无变化：本次为纯 HUD 修复，`server-patch/reality-hud-damage.patch` 与 1.7.1 相同，**无需重新部署**；未打补丁的服务器同样受益。

## [1.7.1] - 2026-10-16

### Fixed

- **同一回合各屏数字不一致**：本地实时统计累加的是**原始命中值**（击杀溢出、元素条积累、每跳四舍五入），而服务器结算记录的是**实际扣血**——两者天然有偏差；旧合并逻辑"只升不降"，于是**自己的屏幕**永远保留本地偏高的数字，**队友的屏幕**显示服务器值，同一回合每个人看到的数都不一样（「本回合每个人显示的伤害不一样」）。现在服务端结算帧带 `settled` 标记：带该标记的快照会把本回合与全局累计**直接校正**为服务器值（可升可降），类型拆分按比例跟随——每回合结束后所有屏幕收敛到同一个数。
- **伤害归属串行（我打的伤害显示成别人的名字）**：仿真的伤害事件（`dmg`）原本不带来源 id，HUD 只能按攻击先后顺序为每次命中"猜"归属——近战即时命中插队到还在飞行的远程弹道之间时两次命中会互换，元素条与多段攻击还会多吞队列条目；共享战场（联防 / Boss 配对，视角内含队友单位）时互换跨玩家，显示的便是**队友的名字**。现在**服务端补丁**在带来源的命中事件里追加权威来源单位 id（无来源命中保持旧形状），HUD 直接采信、不再猜；未打补丁 / 旧补丁服务器继续走按序猜配对的回退路径，行为与 1.7.0 一致。
- 旧行为保留为回退路径：未打补丁 / 未更新补丁的服务器不带 `settled` 也不带来源 id，合并与归属逻辑与 1.7.0 完全一致，不会回归。

### Changed

- **服务端补丁更新（两处修复）**：`hudDmg` 新增 `settled` 字段（`views.js`）；仿真伤害事件在带来源时追加来源单位 id（`sim/damage.js`，游戏自身客户端只读前几项、不受影响）。`server-patch/reality-hud-damage.patch` 重新生成（5 个代码文件 + 3 篇文档 + 3 个测试）；已打旧补丁的服务器按上述回退路径工作，**建议**更新到新补丁以获得两处修复。
- 测试：`npm run test:damage` 新增 7 项结算快照 + 3 项精确归属用例（31 → 41 项）；服务端补丁测试 4 例补充 `settled` 断言，仿真伤害归属契约测试 3 例（新增 `test/sim/damage-attribution.test.js`）。

## [1.7.0] - 2026-10-16

### Added

- **「伤害」页**：干员 / 玩家 / 敌人三张统计表整合进新页面（卡片排在「本局」之后），页内标签切换，不再是三个各自飘着的窗口。页头「独立窗口」把当前这张表弹成独立悬浮窗（拖动 / 缩放 / 折叠照旧），窗口 `×` 或停靠位上的「收回」放回页面——**同一份数据、同一个滚动位置与列宽**，两边不会重复渲染；旧的窗口 id（`#rh-damage-window`、`#rh-players-damage-window`、`#rh-enemies-damage-window`）作为弹出版保留。
- **队友伤害实时同步（服务端补丁，可选）**：`m.public` 玩家行新增 `hudDmg: { round, dmg, total }`——普通回合在结算后广播本回合伤害与整场累计，Boss 轮约每秒刷新。HUD 检测到该字段即实时显示队友两列，玩家表页脚注明数据来源（未打补丁时显示「仅结算可见」）。补丁见 `server-patch/reality-hud-damage.patch` 与 [docs/server-patch.md](docs/server-patch.md)。

### Fixed

- **全局累计被重复计数**：`m.private.stats.dmgDealt` 与 `m.result` 给的是**整场累计**，旧合并逻辑按「每回合差值」处理——每回合都把累计值再计一次，本回合与全局两列同时虚高。现在累计值只作为全局列的下限，绝不参与本回合计算。
- **跨回合错帧**：`hudDmg` 带回合戳，只有戳与当前回合一致时才计入本回合，飞行中的旧帧不会再落进新回合。

### Changed

- 菜单「伤害统计窗口」改为「伤害统计」，点按打开伤害页（行状态跟随当前页面）。
- 配置：`damageWindow.visible` 由 `popped.{operators,players,enemies}`（各自是否独立）与 `tab`（当前标签）替代；旧存档一律默认停靠在伤害页，不再自动弹出三个窗口。
- 设置页「伤害文字」滑条同时作用于伤害页与弹出的独立窗口。
- 测试：`npm run test:damage` 重写为伤害页自测（26 项：标签 / 停靠 / 弹窗归位 / 累计合并 / 跨回合戳）；冒烟 60 → 67，手机 8 → 10。

## [1.6.0] - 2026-10-16

### Added

- **分页式界面（重设计）**：悬浮窗改为「首页 + 子页」。首页是一屏总览——延迟 RTT 大数字与折线、连接状态摘要、在线 / 房间 / 对局三个计数器——下面是进入各页的卡片；点卡片切换页面，页内左上角「‹ 首页」返回，开的哪页会被记住。此前所有分区堆在一列滚动，信息挤在一起。
- **卡片实时摘要**：每张卡片直接显示该页的当前状态（同盟码或「未在同盟」、服务版本与在线数、FPS、异常数、新邀请数……），日志有异常、收到新邀请时卡片高亮提示。
- 设置页新增「首页显示这些页面」开关（替代原分区开关），当前页被隐藏时自动回到首页。

### Changed

- **版式重排**：统一「返回 + 标题」页头，日志筛选独立成工具条；面板改为圆角卡片风（总览卡、内容卡、卡片网格），页面切换带轻微淡入。
- **旧配置自动迁移**：1.5.x 存档里被默认关闭的「设置 / 关于」在这次升级时自动开启一次，避免作为页面不可达（此后记忆用户自己的开关）。
- **许可变更**：MIT → **GPL-3.0-or-later**（与所附加的游戏一致）；`LICENSE`、README、`package.json` / `mod.json` 与界面上的许可文案同步更新。
- **README 重写**：移除博客链接行，新增贡献者展示（[@Kriss-wq](https://github.com/Kriss-wq) 的实时伤害统计窗口，PR #3）；`package.json` / `mod.json` 的 `homepage` 指向仓库地址。

### Removed

- **布局预设（精简 / 标准 / 全部）**：分页后不再是「一列折叠组合」的模型，由页面开关与宽度滑条替代。
- **分区折叠与眼睛按钮**：页面本身就是入口，不再需要逐分区折叠（伤害统计窗口内部的折叠保留）。
- **设置栏无用的「拖动这里也能改宽度」按钮**：它拖不动、也不改宽度，点按只会把设置栏折叠起来，已删除；调宽度用「面板宽度」滑条或面板右下角手柄即可（烟测「旧按钮已移除」断言同步覆盖其不再存在）。

## [1.5.1] - 2026-10-15

### Fixed

- **退出同盟后，邀请栏仍把旧同盟当成「当前房间」**: the section only knew a room from `room.state` / `room.closed` pushes, but a voluntary `room.leave` answers the leaver with a bare `ok` — the server tells the leaver nothing — so the old code/link kept showing and 邀请 clicks went into a server `NOT_IN_ROOM` failure. The overlay now reads the current room from the game's own store (`__SP__.store.get().room`, what the game's screens themselves show — it clears on leave, kick and session reset alike) with the old mirror kept only as a fallback, and repaints the moment the store's room changes.
- **在同盟中时无法接受邀请**: 立即加入 refused locally (「你已在其他同盟中」) although `room.join` switches rooms server-side (it drops the old seat first) — the exact flow the banner exists for. It now sends the join; only a running match still refuses, with the reason in the log, and a join that left another room says so.
- Smoke grew 46 → 50: the stale-room case (store cleared while the mirror is stale → the link is gone), the room-switching 立即加入 and the running-match refusal are asserted.

## [1.5.0] - 2026-10-15

- 新增独立「干员伤害统计」窗口：实时显示本回合 / 全局伤害、伤害类型、增益减益类型与持续时间。
- 兼容 `m.unitStats`、`m.field`、`b.start`、`b.ev`、`b.result`、`m.result` 等新旧战斗帧；旧协议没有来源 id 时显示未归属伤害。

## [1.4.2] - 2026-10-15

### Changed

- **邀请最前**: the panel now runs 邀请 → 本局 → 服务 → 性能 → 事件日志 (was 服务 → 本局 → 邀请 → …), so the actionable part sits right under the latency strip; the settings toggle list follows the same order.
- **去品牌字**: the panel chrome no longer prints "REALITY HUD" — the header, the collapsed strip, the footer note and the About role line all read `R HUD`, and the recall pill's tooltip follows. The mobile-only `R HUD` swap is gone because `R HUD` is the title everywhere (the desktop collapsed strip shrinks along with it).
- **页脚图标**: the footer's two link texts (GitHub profile, blog address) become two small inline SVG icons — GitHub mark → the repository, globe → the blog; both keep tooltips and open in a new tab. The About section's GitHub row now points at the repository as well. `authorDetail` gains `repo`/`repoLabel`; `links` gains `repo`.
- Smoke grew 43 → 46: the `R HUD` title, the 邀请-first section order and the footer icon links are asserted.

## [1.4.1] - 2026-10-15

### Changed

- The optional server patch is rebased on upstream **v0.2.6**: `server-patch/reality-hud-invite.patch` was regenerated against the 0.2.6 tree and `git apply --check` verified clean (same 4 code files + 1 doc).
- README compatibility statement now covers game versions `0.1.3` – `0.2.6`: the production server (patched fork + this HUD) was upgraded to v0.2.6 on 2026-10-15 with the smoke suite passing 40/40 against it.
- **更小的悬浮窗**: the collapsed strip (fold state) is smaller everywhere — ~124×28px → **119×25px** — and shrinks further on phones (≤560px) to **71×24px**: the title shortens to `R HUD`, and the dot, paddings and fold button shrink with it. The recall pill is back to 36px on a narrow viewport (the 42px of 1.4.0 felt too big on a phone); an invisible ring around it keeps the tap target ≈48px for fingers.
- Smoke fixes and growth 40 → 43 assertions: phone-width collapsed-strip and pill sizes are checked, and `hud-open.png` is now captured with the panel actually expanded (it used to catch the collapsed strip).

## [1.4.0] - 2026-10-14

### Added

- **Recall pill (mobile-friendly)**: after hiding the panel (`×`), a 36px `R` pill appears in the bottom-right corner — tap it to bring the HUD back. On a phone there is no Shift+H, so a hidden HUD used to be unreachable until a page reload. The pill is draggable (position remembered); desktop Shift+H still works.

### Fixed

- **Menu rows were unclickable** (一直存在的 bug): pressing a menu row started a header drag, which captured the pointer on the header and retargeted the click away — 固定采样 / 暂停采样 / 迷你模式 / 打开设置 all silently did nothing with a real pointer (the old synthetic-`.click()` tests bypassed it). Dragging now only starts from the header's blank areas.
- **「打开设置」现在真的会打开**: with the default preset the settings section is switched off *and* folded, so the row used to toggle fold state on a hidden section — no visible effect. The row now reveals, unfolds and scrolls the section into view (the body is a scroll container; below the fold on phones at 58vh).
- **Red 「已连接」 on the title screen**: the steady `connected` state (socket open, heartbeat alive, no session — what the title screen sits in forever) graded as bad. It now grades green like the game's own indicator; a `lastError` (e.g. a rejected hello) still grades it down.
- **Panel bottom off-screen after rotating to landscape**: position clamping assumed an 80px stub; it now clamps against the panel's real height, so a short viewport keeps the whole panel reachable.
- **Stray "TRUE" in the 设置 section header**: another `buildSection` boolean argument — the v1.3.1 log-head twin, hidden behind the default-off settings section. `h()` now refuses boolean children outright, and the smoke walks every section header for stray boolean text, so this class of mistake cannot land again.

### Changed

- Touch polish: no grey tap flash on Android / iOS; the panel's inner scrollers no longer chain-scroll the game page behind them (`overscroll-behavior: contain`); the pill grows to 42px on narrow screens for an easier tap target. Header drag no longer cancels `pointerdown` on touch pointers (`touch-action: none` already blocks scrolling, and per spec cancelling it suppresses the compat click of that tap).
- Smoke suite grew 36 → 39 assertions: real-pointer menu rows, 打开设置 reveal, hide → recall pill → restore.

## [1.3.1] - 2026-10-13

### Fixed

- Stray `true` text next to the 事件日志 (event log) section title — `buildSection` was mistakenly passed a boolean as an extra header element.
- `TypeError` when a `room.state` frame lacks the `spectators` field — `renderMatch` now tolerates partial frames, so one odd frame can no longer stall the panel's render loop.

### Changed

- `mod.json` gains a `repository` metadata field; docs and version strings synced.

## [1.3.0] - 2026-10-13

### Added

- **Invite friends**, end to end:
  - The 邀请 (invite) section shows the password-free `?room=CODE` link while you are in an alliance, with one-click copy (an `execCommand` fallback for plain-HTTP origins) plus a copy-the-code-only button.
  - An online roster from `GET /api/players` (lobby / in-room / in-match badges) with a per-player 邀请 button (`room.invite` → the server forwards a targeted `room.invited` push, rate-limited by the heavy bucket).
  - An incoming invitation appears as a top banner with 立即加入 (join via the game's own `room.join`) / 忽略 (dismiss); joining before entering the game is refused with a hint.
  - Graceful degradation: on a server without `/api/players` the roster hides itself after a single notice and stops polling; copying the invite link keeps working.
- The settings panel and layout presets cover the new 邀请 section.

### Changed

- The roster poll (every 10 s) runs only while the invite section is visible, the tab is in the foreground and the panel is not paused.

## [1.2.0] - 2026-10-12

First entry into the game repository with the 0.2.5 upgrade (the 1.0–1.2 evolution predates the imported history).

### Added

- Latency RTT from the game's own heartbeat with a 60-sample sparkline, jitter, loss and clock offset.
- Connection state, reconnect attempts, last error detail.
- Server panel from `/healthz` (players, rooms, matches, version, uptime).
- Match panel (room code, mode, difficulty, seats, phase, round, countdown).
- Performance panel (FPS / frame time — battles are simulated client-side, so this is the stutter metric).
- Colour-graded event log with server `detail` lines, filters, expand-all and copy.
- Draggable, collapsible, mini mode, pause, layout presets, position memory; `Shift+H` to recall; author credits.
