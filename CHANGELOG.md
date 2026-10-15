# Changelog

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-10-15

- 新增独立「干员伤害统计」窗口：实时显示本回合 / 全局伤害、伤害类型、增益减益类型与持续时间。
- 兼容 `m.unitStats`、`m.field`、`b.start`、`b.ev`、`b.result`、`m.result` 等新旧战斗帧；旧协议没有来源 id 时显示未归属伤害。

## [Unreleased]

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
