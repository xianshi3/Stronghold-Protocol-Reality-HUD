# 服务端补丁（可选）

Reality HUD 的核心功能（延迟、服务状态、本局、性能、日志、**伤害页**、**免密钥邀请链接**）**不需要任何服务端改动**，在原版 Stronghold Protocol 上即装即用。

两个补丁都是可选增强，互相独立、可只打一个（改动文件不重叠，应用顺序无关）：

| 补丁 | 给什么 | 规模 |
|---|---|---|
| `reality-hud-invite.patch` | 在线名单 + 一键邀请 | 4 个代码文件 + 1 个文档 |
| `reality-hud-damage.patch` | 队友伤害实时同步（`m.public` 玩家行 `hudDmg`） | 4 个代码文件 + 2 个文档 + 1 个测试 |

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
| `server/match/match/views.js` | `_hudDmgView(ps)`：组装 `m.public.players[].hudDmg { round, dmg, total, settled }` —— 本回合伤害（结算盖章 + Boss 轮仍在进行的客户端战场 `f.bossBy` 实时分摊）、整场累计（`stats.dmgDealt` + 尚未结算的 Boss 实时份额，两者绝不重复）与 `settled` 标记（本回合是否已盖章完整——客户端据此把本地实时估算**校正**为服务器值，可升可降；未标记的帧只作下限）；`_hudCreditDmg(ps, d)`：结算盖章；`publicView` 玩家行加 `hudDmg` 字段 |
| `server/match/PlayerState.js` | `hudRound` / `hudDmg` 字段初始化 |
| `server/match/match/settle.js` | 普通回合结算（本场结果 + 联防分摊）后盖章本回合伤害 |
| `server/match/match/bossRounds.js` | `_finishFinal` 把 Boss 伤害写进 `stats.dmgDealt` 的同刻盖章（该伤害自此只算一次） |
| `docs/design/network.md`、`docs/META.md` | 协议文档同步 |
| `test/match/reality-hud-damage.test.js` | 4 例：视图数学（回合戳 / 实时份额 / 不重复 / `settled` 判定）、普通回合盖章与回合切换清零、Boss 轮实时值（未结算）与结算不重复计数、联防回合归属 |

## 语义与安全

- **只多一个字段**：不新增消息类型、不改任何现有字段。原版客户端对它一无所知（宽松存储，多余字段无害）；HUD 检测到 `hudDmg` 才把队友从「结算可见」升级为实时。
- **回合戳防错帧**：`dmg` 带 `round`；客户端只在与当前回合同步时消费它，飞行中的旧帧不会落进下一回合的 本回合。`total` 只作全局累计的下限（HUD 取 max），绝不重复计数。
- **结算快照校正（v1.7.1）**：`settled: true` 的帧表示该回合已盖章完整（且没有仍在场外的实时份额）。HUD 侧的实时数字由原始命中事件累加（击杀溢出、元素条积累、逐跳取整会略高于实际扣血），因此带标记的帧会把本回合与全局累计**直接写为服务器值**（可升可降，类型拆分成比例跟随）——修复「本回合每个人屏幕上的数字不一样」；Boss 轮的实时帧与未打本补丁的旧服务器不带标记，沿用只上不下的旧行为。
- **Boss 轮实时值**：来自客户端上报的共享血量池分摊（`f.bossBy`），沿用原版 `_creditBoss` 的场地时钟预算封顶（反作弊不变）；最终仍以客户端 `b.result` 为准。
- **不泄露新信息**：这些数字在 `m.result` 结算时本来就发给全员，补丁只是把它提前到回合结算时（Boss 轮约每秒）——没有房间码、token 或任何私密视图。

## 验证

- `node --test test/match/reality-hud-damage.test.js` —— 伤害补丁 4 例（视图数学 / 普通回合盖章 / Boss 轮实时与不重复计数 / 联防回合归属）
- `node --test test/lobby-invite.test.js` —— 邀请补丁 5 例
- `node test/hud-smoke.mjs http://127.0.0.1:3000` —— HUD 侧 67 项断言（含伤害页、模拟 `room.invited` 横幅与旧服务器降级路径）
- `node test/hud-damage.mjs` —— 伤害页 38 项断言（自带假服务器，含结算快照校正）
