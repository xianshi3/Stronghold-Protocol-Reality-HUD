# 服务端补丁（可选）

Reality HUD 的核心功能（延迟、服务状态、本局、性能、日志、**伤害页**、**免密钥邀请链接**）**不需要任何服务端改动**，在原版 Stronghold Protocol 上即装即用。

两个补丁都是可选增强，互相独立、可只打一个（改动文件不重叠，应用顺序无关）：

| 补丁 | 给什么 | 规模 |
|---|---|---|
| `reality-hud-invite.patch` | 在线名单 + 一键邀请 | 4 个代码文件 + 1 个文档 |
| `reality-hud-damage.patch` | 队友伤害实时同步（`m.public` 玩家行 `hudDmg` + 客户端战斗的 `m.hudDmg` 实时上报）+ 命中归属来源 id | 9 个代码文件 + 3 篇文档 + 3 个测试 |

## 应用

两个补丁都基于上游 [Stronghold Protocol](https://github.com/sganggs/Stronghold-Protocol) **v0.2.6** 生成：

```bash
cd Stronghold-Protocol            # 游戏仓库，v0.2.6
git apply reality-hud-invite.patch
git apply reality-hud-damage.patch
# 验证后重启服务器使新代码生效：
systemctl restart stronghold      # 会断开所有连接、结束内存中的对局，请挑空闲时段
curl -s http://127.0.0.1:3000/api/players   # 应返回 {"ok":true,"players":[...]}
```

反向撤销：`git apply -R reality-hud-damage.patch`（invite 版同理）。

## 补丁内容 · 在线名单 + 一键邀请

| 文件 | 改动 |
|---|---|
| `shared/protocol.js` | C2S 增加 `room.invite { playerId }`；S2C 增加 `room.invited { from, name, code }`（文档表） |
| `server/lobby.js` | `invite()` 处理器：发送者必须在自己的房间里（否则 `NOT_IN_ROOM` / 观战席 `SPECTATOR`）；目标必须是另一个在线会话（未知 / 离线 / 本人 / 已在同房间 → `BAD_TARGET`）；通过后把 `{ t:'room.invited', from, name, code }` 定向推给目标 |
| `server/net.js` | `room.invite` 加入重桶（`HEAVY_TYPES`，2/s、突发 6）防刷邀请 |
| `server/http/routes.js` | `GET /api/players`：返回 `{ ok, players: [{ id, name, inRoom, inMatch }] }`，永不缓存 |
| `docs/design/network.md` | 协议文档同步 |

## 补丁内容 · 队友伤害同步

| 文件 | 改动 |
|---|---|
| `server/match/match/views.js` | `_hudDmgView(ps)`：组装 `m.public.players[].hudDmg { round, dmg, total, settled }` —— 本回合伤害（结算盖章 + 仍在进行的实时份额：Boss 轮客户端战场的 `f.bossBy` 分摊，或 HUD 自己上报的 `m.hudDmg`）、整场累计（`stats.dmgDealt` + 尚未结算的实时份额，两者绝不重复）与 `settled` 标记（本回合是否已盖章完整——客户端据此把本地实时估算**校正**为服务器值，可升可降；未标记的帧只作下限）；`_hudCreditDmg(ps, d)`：结算盖章并清除上报值；`publicView` 玩家行加 `hudDmg` 字段、顶层加 `hudRelay: true` 广告 |
| `server/match/PlayerState.js` | `hudRound` / `hudDmg` 字段初始化 + `hudLiveRound` / `hudLiveDmg` / `hudLiveAt`（HUD 实时上报暂存） |
| `server/match/match/reports.js` | `_onHudDmg(ps, msg)`：接受 `m.hudDmg { dmg }`（仅客户端战斗模式的 COMBAT / 联防；每人限流 1.5s；非法值 `BAD_MSG`；数值未变不上报）；盖章后自动失效 |
| `server/match/match/intents.js` | C2S 路由增加 `case 'm.hudDmg'` |
| `server/match/match/platform.js` | 消息白名单增加 `m.hudDmg`（HUD 专属扩展类型，原版客户端不会发送） |
| `shared/protocol.js` | C2S 协议表注册 `m.hudDmg { dmg }`——客户端 `validateC2S` 白名单放行，否则 HUD 的上报会被客户端直接拒发 |
| `server/match/match/settle.js` | 普通回合结算（本场结果 + 联防分摊）后盖章本回合伤害 |
| `server/match/match/bossRounds.js` | `_finishFinal` 把 Boss 伤害写进 `stats.dmgDealt` 的同刻盖章（该伤害自此只算一次） |
| `server/sim/damage.js` | 带来源的命中事件追加权威来源单位 id（元组第 6 项；无来源命中保持 4 元素旧形状，游戏自身客户端只读前几项、不受影响）——HUD 从此不再按攻击顺序猜归属 |
| `docs/design/network.md`、`docs/META.md`、`docs/SIM.md` | 协议文档同步 |
| `test/match/reality-hud-damage.test.js` | 7 例：视图数学（回合戳 / 实时份额 / 不重复 / `settled` 判定）、普通回合盖章与回合切换清零、Boss 轮实时值（未结算）与结算不重复计数、联防回合归属、`m.hudDmg` 上报（广告 / 限流 / 非法值 / 结算清除 / 服务器运行模式忽略）、协议校验放行 |
| `test/sim/damage-attribution.test.js` | 3 例：来源标注形状（带 / 不带标记槽）、来源 id 正确性（含 `defIgnorePct` 命中） |
| `test/sim/battle.test.js` | 战斗事件流 wire format 断言更新（带来源事件为 6 元素元组，末位为已 spawn 单位 id） |

## 语义与安全

- **只多字段 / 只加尾巴**：不新增消息类型、不改任何现有字段名与顺序。`m.public` 玩家行多一个 `hudDmg` 字段；仿真 `dmg` 事件只在带来源时于元组**末尾追加**来源单位 id（无来源命中保持旧形状）。原版客户端对多余字段（宽松存储）与超长元组（按索引读取前几项）都无感；HUD 检测到 `hudDmg` 才把队友从「结算可见」升级为实时，检测到来源 id 才按权威归属记账、否则退回按序推算。
- **回合戳防错帧**：`dmg` 带 `round`；客户端只在与当前回合同步时消费它，飞行中的旧帧不会落进下一回合的 本回合。`total` 只作全局累计的下限（HUD 取 max），绝不重复计数。
- **结算快照校正（v1.7.1）**：`settled: true` 的帧表示该回合已盖章完整（且没有仍在场外的实时份额）。HUD 侧的实时数字由原始命中事件累加（击杀溢出、元素条积累、逐跳取整会略高于实际扣血），因此带标记的帧会把本回合与全局累计**直接写为服务器值**（可升可降，类型拆分成比例跟随）——修复「本回合每个人屏幕上的数字不一样」；Boss 轮的实时帧与未打本补丁的旧服务器不带标记，沿用只上不下的旧行为。
- **命中归属来源 id（v1.7.1）**：仿真事件流的伤害事件原本不带来源，HUD 只能按攻击先后顺序猜配对——近战即时命中插队到还在飞行的远程弹道之间时两次命中互换，元素条与多段攻击还会多吞队列条目；共享战场（联防 / Boss 配对，视角内含队友单位）时互换跨玩家，显示成**队友的名字**。现在带来源的命中事件让 HUD 直接采信权威单位 id（无来源命中、vanilla / 旧补丁服务器照旧走按序回退路径）——修复「我打的伤害显示的是别人的名字」。
- **Boss 轮实时值**：来自客户端上报的共享血量池分摊（`f.bossBy`），沿用原版 `_creditBoss` 的场地时钟预算封顶（反作弊不变）；最终仍以客户端 `b.result` 为准。
- **正常回合 / 联防实时上报（v1.8.0）**：客户端战斗模式下服务器看不见客户端上正在模拟的战场伤害，此前队友的本回合伤害要等回合结算才可见。新补丁在 `m.public` 顶层加 `hudRelay: true` 广告；HUD 看到广告后，每 2 秒把**自己**的实时伤害经 `m.hudDmg { dmg }` 上报（仅 COMBAT / 联防、伤害为正时才发），服务器并入 `m.public.players[].hudDmg` 的实时份额——所有队友屏幕实时可见，回合结算照旧盖章校正（上报值被清除，绝不重复计数）。限流 1.5s/人；未装 HUD 的玩家不报（其行照旧结算才可见）；HUD 只在看到广告后才上报，旧服务器收不到任何未知消息。
- **不泄露新信息**：这些数字在 `m.result` 结算时本来就发给全员，补丁只是把它提前到回合结算时（Boss 轮约每秒；正常回合经上报约每 2 秒）——没有房间码、token 或任何私密视图。

## 验证

- `node --test test/match/reality-hud-damage.test.js` —— 伤害补丁 7 例（视图数学 / 普通回合盖章 / Boss 轮实时与不重复计数 / 联防回合归属 / `m.hudDmg` 实时上报 / 协议校验放行）
- `node --test test/sim/damage-attribution.test.js` —— 仿真事件归属契约 3 例（带 / 不带标记槽的形状、来源 id 正确性）
- `node --test test/lobby-invite.test.js` —— 邀请补丁 5 例
- `node test/hud-smoke.mjs http://127.0.0.1:3000` —— HUD 侧 67 项断言（含伤害页、模拟 `room.invited` 横幅与旧服务器降级路径）
- `node test/hud-damage.mjs` —— 伤害页 41 项断言（自带假服务器，含结算快照校正与精确归属：跨玩家不串行、带标记空来源不吃队列）
