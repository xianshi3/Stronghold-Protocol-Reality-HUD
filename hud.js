/**
 * Reality HUD — a draggable in-page overlay for Stronghold Protocol.
 *
 * Author: Reality · @xianshi3 · https://reality-blog.asia
 * License: GPL-3.0-or-later (see LICENSE in this folder), the same license as the game
 * it attaches to; this overlay is loaded at runtime and never modifies game code.
 *
 * What it shows (client-side only — it never asks the server for anything beyond the public
 * `/healthz` and `/api/players`):
 *   · connection state, reconnect attempts, last error, clock offset
 *   · real RTT (the game's own heartbeat), jitter, loss, a 60-sample sparkline
 *   · online players / rooms / matches from /healthz
 *   · the current room code, round x/14, phase name, countdown, your seat
 *   · 邀请: the room code with a copy-invite-link button (?room=CODE — the game joins it natively),
 *     the players online right now (from /api/players) with one-tap room.invite pushes, and a
 *     banner for an incoming room.invited with 立即加入 (server/lobby.js invite)
 *   · an event log of the frames worth knowing about, colour-graded
 *   · FPS + frame time (combat is simulated locally, so this is what stutters on weak machines)
 *
 * Performance — this runs next to a WebGL battle loop, so it stays out of the way:
 *   · everything subscribes to events the game already emits; nothing is polled per frame
 *   · one rAF loop runs only while the panel is visible, and it does arithmetic only (no layout reads)
 *   · /healthz polls every 5 s, /api/players every 10 s (invite section shown only) and both stop
 *     while the tab is hidden or the panel is closed
 *   · the DOM is built once, then only changed nodes are touched; the log is capped and diffed
 *   · prefers-reduced-motion and the "pause" switch cut the loop and all timers entirely
 *
 * Data sources, all optional — the overlay degrades instead of breaking if one is missing:
 *   /shared/constants.js     PHASE_NAMES          — served to the browser by the game
 *   globalThis.__SP__        { store, net }        — set by js/main.js once the app boots
 *   /healthz                                       — public JSON status endpoint
 *   /api/players                                   — public JSON roster (a 404 hides the invite list)
 */

import { PHASE_NAMES } from '/shared/constants.js';

// ---------------------------------------------------------------------------------------------
// config & persistence
// ---------------------------------------------------------------------------------------------

const STORAGE_KEY = 'reality-hud.v2';

/** Who made this. One place, so the footer / About panel / dev handle can never drift apart. */
const AUTHOR = Object.freeze({
  name: 'Reality',
  github: 'https://github.com/xianshi3',
  githubHandle: 'xianshi3',
  blog: 'https://reality-blog.asia',
  blogLabel: 'reality-blog.asia',
  repo: 'https://github.com/xianshi3/Stronghold-Protocol-Reality-HUD',
  repoLabel: 'xianshi3/Stronghold-Protocol-Reality-HUD',
});

const MOD_VERSION = '1.7.2';

const DEFAULTS = {
  x: null,               // null = park it on the right edge (computed on first show)
  y: null,
  rx: null,              // recall pill position (null = bottom-right corner)
  ry: null,
  width: 380,             // 260 … 720, via the resize grip
  opacity: 0.94,          // 0.35 … 1
  collapsed: false,
  pinned: true,           // false = dims to `idleOpacity` when the pointer is elsewhere
  idleOpacity: 0.3,
  mini: false,            // mini = only the RTT line, everything else folded away
  paused: false,          // paused = stop every timer and the rAF loop
  page: 'home',           // the visible page: home | invite | match | damage | server | perf | log | settings | about
  show: {                 // per-page visibility (its card on the home grid), driven by the settings panel
    server: true,
    match: true,
    damage: true,
    invite: true,
    perf: true,
    log: true,
    settings: true,
    about: true,
  },
  damageWindow: {
    // v1.7.0: the three tables live in the 伤害 page; `popped` says which of them float in their
    // own window instead. The legacy `visible` flag is ignored (an old config simply starts docked).
    popped: { operators: false, players: false, enemies: false },
    tab: 'operators',       // the 伤害 page's active tab: operators | players | enemies
    x: null,
    y: null,
    width: 620,
    height: null,
    fontScale: 1,
    playersCollapsed: false,
    operatorsCollapsed: false,
    columnWidths: {},
    collapsed: false,
    windows: {
      operators: { x: null, y: null, width: 620, height: null, collapsed: false, columnWidths: {} },
      players: { x: null, y: null, width: 420, height: null, collapsed: false, columnWidths: {} },
      enemies: { x: null, y: null, width: 480, height: null, collapsed: false, columnWidths: {} },
    },
  },
  folded: {},             // legacy (v1.5.x per-section folds) — kept so old configs load, no longer used
  logFilter: 'all',       // all | warn | state
  logExpanded: [],        // log ids whose detail is open
  logWrap: false,         // wrap long detail lines instead of clipping
};

const WIDTH_MIN = 260;
const WIDTH_MAX = 720;

/** The pages behind the home grid, in card order. `id` doubles as the DOM suffix (#rh-page-<id>). */
const PAGES = [
  { id: 'invite', label: '邀请', icon: 'invite' },
  { id: 'match', label: '本局', icon: 'match' },
  { id: 'damage', label: '伤害', icon: 'damage' },
  { id: 'server', label: '服务', icon: 'server' },
  { id: 'perf', label: '性能', icon: 'perf' },
  { id: 'log', label: '日志', icon: 'log' },
  { id: 'settings', label: '设置', icon: 'settings' },
  { id: 'about', label: '关于', icon: 'about' },
];

function loadConfig() {
  const base = { ...DEFAULTS, show: { ...DEFAULTS.show }, damageWindow: { ...DEFAULTS.damageWindow, windows: { ...DEFAULTS.damageWindow.windows } }, folded: {} };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    const savedDamage = parsed.damageWindow && typeof parsed.damageWindow === 'object' ? parsed.damageWindow : {};
    const windows = Object.fromEntries(Object.entries(base.damageWindow.windows).map(([id, defaults]) => [id, { ...defaults, ...(savedDamage.windows?.[id] || {}) }]));
    if (!savedDamage.windows) {
      windows.operators = { ...windows.operators,
        x: savedDamage.x ?? windows.operators.x,
        y: savedDamage.y ?? windows.operators.y,
        width: savedDamage.width ?? windows.operators.width,
        height: savedDamage.height ?? windows.operators.height,
        collapsed: savedDamage.collapsed ?? windows.operators.collapsed,
        columnWidths: savedDamage.columnWidths ?? windows.operators.columnWidths,
      };
    }
    // v1.5.x → v1.6.0: 设置 / 关于 used to be bottom sections that were off by default; as pages
    // they would start unreachable, so a pre-1.6 config gets them once (it has no `page` key).
    const show = { ...base.show, ...(parsed.show || {}) };
    if (parsed.page === undefined) { show.settings = true; show.about = true; }
    return {
      ...base,
      ...parsed,
      show,
      damageWindow: {
        ...base.damageWindow,
        ...savedDamage,
        // v1.7.0: the three tables start docked in the 伤害 page (an old `visible: true` config is
        // deliberately not carried over); `popped` and `tab` are sanitized.
        popped: Object.fromEntries(Object.keys(base.damageWindow.popped).map((k) => [k, savedDamage.popped?.[k] === true])),
        tab: ['operators', 'players', 'enemies'].includes(savedDamage.tab) ? savedDamage.tab : base.damageWindow.tab,
        windows,
      },
      folded: {},
      page: typeof parsed.page === 'string' && (parsed.page === 'home' || show[parsed.page] === true) ? parsed.page : 'home',
      logExpanded: Array.isArray(parsed.logExpanded) ? parsed.logExpanded.slice(-40) : [],
    };
  } catch {
    return base;
  }
}

function saveConfig() {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state.cfg)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const now = () => Date.now();

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    // booleans are never content: a stray `true` argument (buildSection's extraHeadKids — bit
    // twice: the v1.3.1 log head, the v1.4.0 settings head) renders as visible text
    if (kid == null || typeof kid === 'boolean') continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** A 24×24 inline SVG path (the footer's link icons). `h()` builds HTML elements only, so the
 *  SVG namespace is explicit here. */
function svgIcon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'rh-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

// GitHub mark (github.com/logos) · Material "public" globe (Apache-2.0)
const ICON_GITHUB = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const ICON_BLOG = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z';

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}天 ${hh}时`;
  if (hh > 0) return `${hh}时 ${mm}分`;
  if (mm > 0) return `${mm}分 ${ss}秒`;
  return `${ss}秒`;
}

function clockText(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 0 = good, 1 = meh, 2 = bad. Tuned for a domestic connection, worst case a CDN-fronted server. */
function pingGrade(ms) {
  if (!Number.isFinite(ms)) return 2;
  if (ms < 80) return 0;
  if (ms < 180) return 1;
  return 2;
}

const GRADE_CLASS = ['is-ok', 'is-warn', 'is-bad'];

// ---------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------

const state = {
  cfg: loadConfig(),

  // connection
  status: 'idle',
  attempts: 0,
  lastError: null,
  playerId: null,

  // latency
  ping: null,
  /** @type {number[]} */ pingHistory: [],
  jitter: null,
  lossPct: 0,
  clockOffset: 0,

  // server (from /healthz)
  server: null,
  serverError: null,
  serverAge: null,      // ms since the last successful poll
  healthzMs: null,      // how long /healthz itself took

  // match
  room: null,
  match: null,
  route: 'title',

  // invite (v1.3.0)
  players: null,          // last /api/players roster [{ id, name, inRoom, inMatch }]
  playersError: null,     // why the last roster fetch failed
  playersSupported: true, // false once /api/players answers 404 (a server without the overlay routes)
  invites: [],            // incoming room.invited, newest last: [{ from, name, code, at }]

  // performance
  fps: null,
  frameMs: null,
  frames: 0,

  // log
  logs: [],

  // damage / effects window (fed from optional battle frames; it degrades when a server does not
  // expose source ids or client combat events)
  damage: {
    round: null,
    battleId: null,
    units: new Map(),
    unitIndex: new Map(), // (context, runtime id) -> record: battle events resolve inside their own field/battle
    players: new Map(),
    enemies: new Map(),
    teamEffects: new Map(),
    unattributed: { current: 0, total: 0, currentTypes: {}, totalTypes: {} },
    attackSources: new Map(), // target id -> [{ source id, at }] (legacy frames without source ids)
    seenFrames: new Map(), // frame identity -> timestamp; drops duplicate net/runner delivery
    collecting: false,
    paused: false,
    finished: false,
    serverDmg: false, // m.public players[].hudDmg seen → the server runs the Reality HUD damage patch
    phase: null,
    lastFrameAt: 0,
  },

  // lifecycle
  mounted: false,
  _netAttached: false,
  _storeAttached: false,
  _netRetry: null,
  _runnerAttached: false,
  _runnerRetry: null,
  _dataAttached: false,
  _dataRetry: null,
  _wasInMatch: false,
  _frames: 0,
  _acc: 0,
};

const PING_HISTORY = 60;
const JITTER_WINDOW = 30;
const LOG_LIMIT = 400;
const LOG_DOM_LIMIT = 160;
const HEALTHZ_INTERVAL = 5000;
const PLAYERS_INTERVAL = 10000;   // /api/players — only while the invite section is on screen
const INVITE_TTL_MS = 60000;      // an incoming invite banner stands for a minute
const SPARK_W = 92;
const SPARK_H = 30;

/** Frames worth a log line on their own. Everything else is filtered per branch below. */
const STANDALONE = new Set(['welcome', 'room.closed', 'm.result']);

let logSeq = 0;
let warnCount = 0;

/**
 * Record a log entry.
 *
 * `detail` is the developer-facing reason and is the whole point of this overlay when something
 * goes wrong: the server's `error` frames carry a generic `msg` ("操作过于频繁") plus a specific
 * `detail` ("version mismatch: server 2", "bad field difficulty"). Showing only `msg` hides the
 * actual cause, so detail is always kept and rendered on its own line.
 *
 * @param {'info'|'state'|'warn'|'error'} level
 * @param {string} text one-line summary
 * @param {string} [detail] multi-line body, shown expanded on demand
 * @param {string[]} [lines] extra labelled lines (code / rid / origin …)
 */
function pushLog(level, text, detail = '', lines = []) {
  if (level === 'warn' || level === 'error') warnCount++;
  state.logs.push({ id: ++logSeq, level, text, detail, lines, at: now() });
  if (state.logs.length > LOG_LIMIT) {
    state.logs.splice(0, state.logs.length - LOG_LIMIT);
    // expanded ids must not leak as the log window slides
    const live = new Set(state.logs.map((l) => l.id));
    state.cfg.logExpanded = state.cfg.logExpanded.filter((id) => live.has(id));
  }
  scheduleRender('log');
}

/** Errors, warnings and anything carrying a detail get their body expanded by default. */
function isOpenByDefault(entry) {
  return (entry.level === 'error' || entry.level === 'warn' || !!entry.detail) && !!entry.detail;
}

// ---------------------------------------------------------------------------------------------
// damage / effects aggregation
//
// The game has shipped both server-run frames (b.ev) and client-combat frames (b.start/b.result).
// Their detail level differs by version, so this layer deliberately accepts the tuple and object
// forms used by both. It never assumes a source id is present: old b.ev damage tuples only carry
// the target, in which case the preceding atk tuple is the best attribution available.

const DAMAGE_TYPE_TEXT = Object.freeze({
  phys: '物理', physical: '物理',
  arts: '法术', magic: '法术',
  true: '真实', direct: '真实',
  elemental: '元素', element: '元素',
  burn: '灼燃', neural: '神经', necrosis: '侵蚀', apoptosis: '凋亡',
  unknown: '未分类',
});

const NEGATIVE_EFFECT_WORDS = /stun|freeze|cold|sleep|bind|silence|fear|root|slow|fragile|vuln|debuff|减益|眩晕|冻结|寒冷|睡眠|束缚|沉默|恐惧|禁锢|减速|脆弱/i;
const POSITIVE_EFFECT_WORDS = /skill|shield|stealth|camou|haste|atk|def|aspd|heal|buff|增益|护盾|隐匿|迷彩|加速|攻击|防御|技力/i;

// Combat frames often carry an internal effect key (for example `sluggish` or
// `allybuff_select_2`) instead of the localized data record. Resolve the data
// table first, then use this small fallback dictionary for generic status keys.
const DAMAGE_EFFECT_NAMES = Object.freeze({
  skill: '技能', shield: '护盾', sluggish: '迟缓', stun: '眩晕', freeze: '冻结', cold: '寒冷',
  sleep: '睡眠', silence: '沉默', fear: '恐惧', root: '束缚', bind: '束缚', slow: '减速',
  fragile: '脆弱', artsfragile: '法术脆弱', vuln: '易伤', stealth: '隐匿', camouflage: '迷彩', camou: '迷彩',
  reveal: '显形', haste: '加速', atk: '攻击力提升', atkup: '攻击力提升', def: '防御力提升', defup: '防御力提升',
  aspd: '攻击速度提升', attackspeed: '攻击速度提升', heal: '治疗', buff: '增益', debuff: '减益',
  burngauge: '灼燃损伤', burn: '灼燃损伤', necrosis: '凋亡损伤', neural: '神经损伤', erosion: '侵蚀损伤',
  noheal: '禁疗', healfree: '禁疗', isolated: '孤立', unblockable: '无法阻挡', untargetable: '无法选中',
  invuln: '无敌', invulnerable: '无敌', blocked: '阻挡', marked: '标记', selfbound: '自缚',
});

function finiteNumber(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeDamageType(type) {
  if (type == null || type === '') return 'unknown';
  const key = String(type).toLowerCase();
  return DAMAGE_TYPE_TEXT[key] ? key : key.replace(/[^a-z0-9_\u4e00-\u9fff-]/g, '') || 'unknown';
}

// ---------------------------------------------------------------------------------------------
// unit identity
//
// A unit is addressed by two different ids: its board `uid` (stable for a whole match, unique
// across players) and the battle's runtime id (UnitInfo `id` / sim events — small integers that
// restart every battle and whose values can equal another unit's uid, e.g. during 联防 when the
// helpers' units deploy with fresh ids). Records are keyed by uid when the unit has one, so the
// board view and every battle of the same operator merge into one row; a per-context runtime
// index maps (field/battle context, runtime id) to that record, so a battle event resolves to the
// unit its sim actually used — never to the record that happens to share the number (v1.7.2,
// from Kriss-wq's PR #4 attribution fix, reworked to keep the uid merge).
// ---------------------------------------------------------------------------------------------

const RUNTIME_SCOPE_SEP = '\u0000';

function runtimeScopedKey(context, id) {
  return `${context ?? ''}${RUNTIME_SCOPE_SEP}${String(id)}`;
}

/** A frame's battle context: its field when known (`field:n:p_1`, `field:u`), else its battle. */
function damageFrameContext(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const field = frame.fieldId ?? (frame.field && typeof frame.field === 'object' ? frame.field.fieldId : null);
  if (field != null && String(field) !== '') return `field:${String(field)}`;
  if (frame.battleId != null && String(frame.battleId) !== '') return `battle:${String(frame.battleId)}`;
  return null;
}

function frameDamageContext(frame) {
  if (frame && typeof frame === 'object' && 'damageContext' in frame) return frame.damageContext;
  return damageFrameContext(frame);
}

function damageUnitKey(raw, ownerId = null, context = null) {
  if (raw == null) return '';
  if (typeof raw !== 'object') return String(raw);
  const uid = raw.uid ?? raw.unitUid;
  if (uid != null && String(uid) !== '') return `uid:${String(uid)}`;
  const runtimeId = raw.unitId ?? raw.id;
  if (typeof runtimeId === 'number' && Number.isFinite(runtimeId)) {
    return `id:${runtimeId}@${context ?? ''}`;
  }
  const defId = raw.defId ?? (typeof runtimeId === 'string' && runtimeId !== '' ? runtimeId : null);
  if (defId != null && String(defId) !== '') return `def:${ownerId ?? ''}#${String(defId)}`;
  if (raw.name != null && String(raw.name) !== '') return `def:${ownerId ?? ''}#${String(raw.name)}`;
  return '';
}

function isOperatorRecord(rec) {
  if (!rec) return false;
  if (rec.side === 'enemy') return false;
  if (rec.kind === 'player' || rec.kind === 'session') return false;
  return rec.side === 'ally' || rec.kind === 'op' || rec.kind === 'token' || rec.kind === 'chess' || rec.kind === 'operator';
}

function emptyDamageTypes() { return Object.create(null); }

function ensureDamageUnit(raw, defaults = {}, context = null) {
  const ownerIdOf = (source) => {
    if (!source || typeof source !== 'object') return null;
    const owner = source.ownerId ?? source.ownerPlayerId ?? source.playerId
      ?? (source.owner && typeof source.owner === 'object' ? source.owner.playerId : null);
    return owner != null ? String(owner) : null;
  };
  const ownerId = ownerIdOf(raw) ?? ownerIdOf(defaults);
  const key = damageUnitKey(raw, ownerId, context) || damageUnitKey(defaults, ownerId, context) || 'unknown';
  let rec = state.damage.units.get(key);
  if (!rec) {
    rec = {
      key,
      id: null,
      uid: null,
      defId: null,
      name: null,
      kind: null,
      side: null,
      current: 0,
      total: 0,
      currentTypes: emptyDamageTypes(),
      totalTypes: emptyDamageTypes(),
      effects: new Map(),
      reported: Object.create(null),
    };
    state.damage.units.set(key, rec);
  }
  const src = (raw && typeof raw === 'object') ? raw : defaults;
  const merged = { ...defaults, ...(src && typeof src === 'object' ? src : {}) };
  if (merged.id != null) rec.id = String(merged.id);
  if (merged.uid != null) rec.uid = String(merged.uid);
  if (merged.defId != null) rec.defId = String(merged.defId);
  if (merged.name != null && String(merged.name).trim()) rec.name = String(merged.name);
  if (merged.skillIndex != null && Number.isFinite(Number(merged.skillIndex))) rec.skillIndex = Number(merged.skillIndex);
  if (merged.kind != null) rec.kind = String(merged.kind);
  if (merged.side != null) rec.side = String(merged.side);
  if (ownerId != null) rec.ownerId = ownerId;
  if (rec.ownerId) ensureDamagePlayer({ playerId: rec.ownerId, name: merged.ownerName });
  // Index the runtime id inside its battle context. Spawn/field frames overwrite earlier entries
  // for the same (context, id), so the newest battle of a field wins and a uid value can never
  // masquerade as a runtime id.
  const runtimeId = merged.unitId ?? merged.id;
  const indexable = (typeof runtimeId === 'number' && Number.isFinite(runtimeId) && runtimeId > 0)
    || (typeof runtimeId === 'string' && runtimeId !== '');
  if (indexable) state.damage.unitIndex.set(runtimeScopedKey(context, runtimeId), rec);
  const resolvedName = damageDataName(rec);
  if (resolvedName) rec.name = resolvedName;
  if (rec.name == null) rec.name = rec.id || rec.defId || key;
  return rec;
}

function damageDataName(rec) {
  const data = globalThis.__SP__?.data;
  if (!data || typeof data.lookup !== 'function' || !rec) return null;
  const ids = [rec.defId, rec.id, rec.name, rec.key].filter((id, i, all) => id && all.indexOf(id) === i);
  const variants = [];
  for (const id of ids) {
    variants.push(String(id));
    if (/_b$/.test(String(id))) variants.push(String(id).replace(/_b$/, '_a'));
  }
  for (const id of variants) {
    const def = data.lookup('chess', id);
    const name = def?.name ?? def?.charName ?? def?.chessName;
    if (typeof name === 'string' && name.trim() && !/^chess_/.test(name)) return name.trim();
  }
  return null;
}

function damageSkillName(rec, raw = {}) {
  const data = globalThis.__SP__?.data;
  if (!data || typeof data.lookup !== 'function' || !rec) return null;
  const ids = [rec.defId, rec.id, rec.name, rec.key].filter((id, i, all) => id && all.indexOf(id) === i);
  const index = finiteNumber(raw.skillIndex, rec.skillIndex);
  for (const id of ids) {
    const def = data.lookup('chess', String(id));
    const skills = Array.isArray(def?.skills) ? def.skills : [];
    const skill = skills.find((item) => index != null && Number(item?.index) === index) || def?.skill;
    const name = skill?.name ?? skill?.skillName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

function enemyDataName(rec) {
  const data = globalThis.__SP__?.data;
  if (!data || typeof data.lookup !== 'function' || !rec) return null;
  const ids = [rec.defId, rec.name, rec.id, rec.key].filter((id, i, all) => id && all.indexOf(id) === i);
  for (const id of ids) {
    const def = data.lookup('enemies', String(id));
    const name = def?.name ?? def?.enemyName ?? def?.displayName;
    if (typeof name === 'string' && name.trim() && !/^enemy_/.test(name)) return name.trim();
  }
  return null;
}

function refreshDamageNames() {
  let changed = false;
  for (const rec of state.damage.units.values()) {
    const name = damageDataName(rec);
    if (name && rec.name !== name) { rec.name = name; changed = true; }
    for (const effect of rec.effects.values()) {
      const label = effect.key === 'skill' ? (damageSkillName(rec, effect) || damageEffectName(effect.key, effect)) : damageEffectName(effect.key, effect);
      if (label && effect.label !== label) { effect.label = label; changed = true; }
    }
  }
  for (const rec of state.damage.enemies.values()) {
    const name = enemyDataName(rec);
    if (name && rec.name !== name) { rec.name = name; changed = true; }
  }
  for (const effect of state.damage.teamEffects.values()) {
    const label = damageEffectName(effect.key, effect);
    if (label && effect.label !== label) { effect.label = label; changed = true; }
  }
  if (changed) scheduleRender('damage');
}

function damageEffectName(key, raw = {}) {
  const explicit = String(raw.name ?? raw.label ?? raw.title ?? '').trim();
  // Keep actual localized text, but do not expose technical variable names.
  if (explicit && !/^[a-z][a-z0-9_.:-]*$/i.test(explicit)) return explicit;
  const token = String(key ?? '').trim();
  const data = globalThis.__SP__?.data;
  const record = data?.lookup?.('effects', token);
  if (record?.name && String(record.name).trim()) return String(record.name).trim();
  const lower = token.toLowerCase();
  if (DAMAGE_EFFECT_NAMES[lower]) return DAMAGE_EFFECT_NAMES[lower];
  const short = lower.replace(/^(?:status|effect|buff|debuff|enemybuff|enemydebuff|allybuff|allydebuff)[_:.-]*/, '');
  if (DAMAGE_EFFECT_NAMES[short]) return DAMAGE_EFFECT_NAMES[short];
  const suffix = short.split(/[:_.-]/).reverse().find((part) => DAMAGE_EFFECT_NAMES[part]);
  return (suffix && DAMAGE_EFFECT_NAMES[suffix]) || token || '状态';
}

function damageEffectType(key, raw = {}) {
  const kind = String(raw.kind ?? raw.type ?? raw.effectType ?? '').toLowerCase();
  if (raw.positive === true || kind === 'buff' || kind === 'positive') return '增益';
  if (raw.positive === false || kind === 'debuff' || kind === 'negative') return '减益';
  if (NEGATIVE_EFFECT_WORDS.test(String(key))) return '减益';
  if (POSITIVE_EFFECT_WORDS.test(String(key))) return '增益';
  return '状态';
}

function effectDurationMs(raw, nowMs = now()) {
  const duration = finiteNumber(raw?.durationMs, raw?.duration_ms);
  if (duration != null) return duration >= 1000 ? duration : duration * 1000;
  const seconds = finiteNumber(raw?.seconds, raw?.duration, raw?.durationSec, raw?.durationSeconds);
  if (seconds != null) return Math.max(0, seconds * 1000);
  const until = finiteNumber(raw?.untilMs, raw?.expiresAt, raw?.expireAt);
  if (until != null && until > nowMs - 86400000) return Math.max(0, until - nowMs);
  return null;
}

function effectText(effect) {
  if (!effect) return '—';
  if (state.damage.paused) return `${effect.label} ${effect.type} 0秒`;
  const age = Math.max(0, now() - effect.startedAt);
  let duration;
  if (effect.active && Number.isFinite(effect.expiresAt)) {
    duration = `${Math.max(0, Math.ceil((effect.expiresAt - now()) / 1000))}秒`;
  } else if (effect.active) {
    duration = `已${Math.floor(age / 1000)}秒`;
  } else {
    duration = `${Math.max(0, Math.round((effect.endedAt - effect.startedAt) / 1000))}秒`;
  }
  return `${effect.label} ${effect.type} ${duration}`;
}

function ensureDamageEffect(rec, rawKey, raw = {}, active = true) {
  const key = String(rawKey ?? raw.key ?? raw.id ?? raw.name ?? 'status');
  const at = now();
  let effect = rec.effects.get(key);
  if (!effect) {
    effect = { key, label: damageEffectName(key, raw), type: damageEffectType(key, raw), startedAt: at, endedAt: at, expiresAt: null, active: false };
    rec.effects.set(key, effect);
  }
  effect.label = damageEffectName(key, raw);
  effect.type = damageEffectType(key, raw);
  if (active) {
    if (!effect.active) effect.startedAt = at;
    effect.active = true;
    const duration = effectDurationMs(raw, at);
    if (duration != null) effect.expiresAt = at + duration;
    effect.endedAt = at;
  } else {
    effect.active = false;
    effect.endedAt = at;
    if (Number.isFinite(effect.expiresAt) && effect.expiresAt > at) effect.expiresAt = at;
  }
  while (rec.effects.size > 24) rec.effects.delete(rec.effects.keys().next().value);
  return effect;
}

function resetDamageRound(round) {
  const n = finiteNumber(round);
  if (n == null) return;
  if (state.damage.round == null) state.damage.round = n;
  if (state.damage.round === n) return;
  state.damage.round = n;
  for (const rec of state.damage.units.values()) {
    rec.current = 0;
    rec.currentTypes = emptyDamageTypes();
    rec.reported = Object.create(null);
    rec.effects.clear();
  }
  state.damage.unattributed.current = 0;
  state.damage.unattributed.currentTypes = emptyDamageTypes();
  state.damage.teamEffects.clear();
  for (const enemy of state.damage.enemies.values()) {
    enemy.current = 0;
    enemy.currentTypes = emptyDamageTypes();
    for (const target of enemy.targets.values()) {
      target.current = 0;
      target.currentTypes = emptyDamageTypes();
    }
  }
  for (const player of state.damage.players.values()) {
    player.current = 0;
    player.currentTypes = emptyDamageTypes();
    player.reported = Object.create(null);
  }
}

function resetDamageSession() {
  state.damage.round = null;
  state.damage.battleId = null;
  state.damage.units.clear();
  state.damage.unitIndex.clear();
  state.damage.enemies.clear();
  state.damage.players.clear();
  state.damage.teamEffects.clear();
  state.damage.attackSources.clear();
  state.damage.seenFrames.clear();
  state.damage.collecting = false;
  state.damage.paused = false;
  state.damage.finished = false;
  state.damage.serverDmg = false;
  state.damage.phase = null;
  state.damage.unattributed = { current: 0, total: 0, currentTypes: emptyDamageTypes(), totalTypes: emptyDamageTypes() };
  scheduleRender('damage');
}

const DAMAGE_BATTLE_PHASES = new Set(['COMBAT', 'UNITE', 'FINAL_ASSAULT', 'HIDDEN_CORE']);

function setDamageLifecycle({ active = false, paused = false, phase = null } = {}) {
  const running = !!active;
  const wasRunning = state.damage.collecting;
  state.damage.collecting = running && !paused;
  state.damage.paused = running && !!paused;
  state.damage.finished = !running && !paused;
  if (phase != null) state.damage.phase = phase;
  if (!running && !paused && wasRunning) {
    for (const rec of state.damage.units.values()) rec.effects.clear();
    state.damage.teamEffects.clear();
    state.damage.attackSources.clear();
  }
  scheduleRender('damage');
}

function startDamageBattle(battleId = null) {
  if (battleId != null) state.damage.battleId = String(battleId);
  state.damage.collecting = true;
  state.damage.paused = false;
  state.damage.finished = false;
  scheduleRender('damage');
}

function ensureDamagePlayer(raw, defaults = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = String(source.playerId ?? source.id ?? defaults.playerId ?? defaults.id ?? '');
  if (!id) return null;
  let player = state.damage.players.get(id);
  if (!player) {
    player = { id, name: id, current: 0, total: 0, currentTypes: emptyDamageTypes(), totalTypes: emptyDamageTypes(), reported: Object.create(null) };
    state.damage.players.set(id, player);
  }
  const name = source.name ?? defaults.name;
  if (name != null && String(name).trim()) player.name = String(name);
  return player;
}

/**
 * Scale a damage-type breakdown to a corrected headline number: the composition (percentages) survives
 * the correction, the absolute amounts follow it. Used by the `settled` snap, where the headline is
 * replaced with the server's number and the local type split would otherwise sum to a value the row
 * no longer shows.
 */
function rescaleDamageTypes(types, before, after) {
  if (!types) return;
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a) || !(b > 0) || a < 0 || b === a) return;
  const ratio = a / b;
  for (const key of Object.keys(types)) {
    const v = Number(types[key]);
    types[key] = Number.isFinite(v) ? Math.max(0, v * ratio) : 0;
  }
}

/**
 * Bring one player's record up to a reported snapshot:
 *  - `round` — the damage this round has produced so far. A plain value is a floor (a live boss-round
 *    share): the display tops up to it, adding only what the live events had not counted yet. A value
 *    flagged `settled` (the round's **complete** credited damage — a patched server's settlement / a
 *    finished boss battle) REPLACES the local estimate in either direction: live counting sums raw hit
 *    events, so overkill on killing blows, element gauge ticks and per-hit rounding read differently
 *    from the credited `dealt` — without the snap, your own screen kept its own number for 本回合 while
 *    every teammate saw the server's (the 1.7.1 fix);
 *  - `total` — the match's own cumulative damage (m.private stats.dmgDealt, m.result, a patched
 *    server's hudDmg.total): a floor on 全局累计, never a delta. Running a cumulative value through
 *    the per-round delta path double counted every settled round (fixed in 1.7.0). A `settled` snapshot
 *    carries the complete cumulative and is taken exactly — it may correct a drifted number down.
 * Returns the player record (or null when the row has no usable id).
 */
function mergeReportedPlayerDamage(raw, reported = {}, snapshotKey = null, opts = {}) {
  const player = ensureDamagePlayer(raw);
  if (!player) return null;
  if ((!state.damage.collecting && !opts.allowStopped) || state.damage.paused) return player;
  const settled = reported.settled === true;
  const roundValue = finiteNumber(reported.round);
  if (roundValue != null && roundValue >= 0) {
    const key = `player:${snapshotKey ?? state.damage.battleId ?? 'round'}:${state.damage.round ?? 'match'}`;
    if (settled) {
      const before = player.current;
      player.current = roundValue;
      rescaleDamageTypes(player.currentTypes, before, roundValue);
      player.reported[key] = Math.max(player.reported[key] ?? 0, roundValue);
    } else {
      const prev = player.reported[key] ?? 0;
      if (roundValue >= prev) {
        const before = player.current;
        if (player.current < roundValue) {
          player.current = roundValue;
          player.total += Math.max(0, roundValue - before);
        }
        player.reported[key] = roundValue;
      }
    }
  }
  const totalValue = finiteNumber(reported.total);
  if (totalValue != null) {
    if (settled) {
      rescaleDamageTypes(player.totalTypes, player.total, totalValue);
      player.total = totalValue;
    } else if (totalValue > player.total) {
      player.total = totalValue;
    }
  }
  return player;
}

/**
 * m.public players[].hudDmg — the per-player damage a server with the Reality HUD damage patch
 * broadcasts (`server-patch/reality-hud-damage.patch`): { round, dmg, total, settled }. `dmg` is stamped
 * with its round, so a frame still in flight when the round advances never lands in the next round's
 * 本回合; `total` is the match's cumulative. A frame flagged `settled` carries the round's complete
 * credited value and snaps the row to it (1.7.1); without the flag the value is a live floor. A vanilla
 * server sends no hudDmg and teammates simply stay unknown until m.result.
 */
function mergePublicPlayerDamage(msg) {
  if (!Array.isArray(msg?.players)) return;
  let seen = false;
  for (const row of msg.players) {
    if (!row || typeof row !== 'object') continue;
    ensureDamagePlayer(row);
    const hud = row.hudDmg && typeof row.hudDmg === 'object' ? row.hudDmg : null;
    if (!hud) continue;
    seen = true;
    mergeReportedPlayerDamage(row, {
      round: hud.round === state.damage.round ? hud.dmg : null,
      total: hud.total,
      settled: hud.settled === true,
    }, 'public', { allowStopped: true });
  }
  if (seen) state.damage.serverDmg = true;
}

function recordPlayerDamage(ownerId, amount, type) {
  const player = ensureDamagePlayer({ playerId: ownerId });
  if (!player) return;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = normalizeDamageType(type);
  player.current += n;
  player.total += n;
  player.currentTypes[key] = (player.currentTypes[key] || 0) + n;
  player.totalTypes[key] = (player.totalTypes[key] || 0) + n;
}

function addDamageToBucket(bucket, amount, type) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return false;
  const key = normalizeDamageType(type);
  bucket.current += n;
  bucket.total += n;
  bucket.currentTypes[key] = (bucket.currentTypes[key] || 0) + n;
  bucket.totalTypes[key] = (bucket.totalTypes[key] || 0) + n;
  return true;
}

function ensureDamageEnemy(source) {
  const key = String(source?.defId ?? source?.name ?? source?.id ?? 'unknown-enemy');
  let enemy = state.damage.enemies.get(key);
  if (!enemy) {
    enemy = {
      key,
      id: source?.id != null ? String(source.id) : null,
      defId: source?.defId != null ? String(source.defId) : key,
      name: source?.name || key,
      current: 0,
      total: 0,
      currentTypes: emptyDamageTypes(),
      totalTypes: emptyDamageTypes(),
      targets: new Map(),
    };
    state.damage.enemies.set(key, enemy);
  }
  if (source?.name && !/^enemy_/.test(String(source.name))) enemy.name = String(source.name);
  const resolvedName = enemyDataName(enemy);
  if (resolvedName) enemy.name = resolvedName;
  return enemy;
}

function recordEnemyDamage(source, target, amount, type) {
  const enemy = ensureDamageEnemy(source);
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = normalizeDamageType(type);
  enemy.current += n;
  enemy.total += n;
  enemy.currentTypes[key] = (enemy.currentTypes[key] || 0) + n;
  enemy.totalTypes[key] = (enemy.totalTypes[key] || 0) + n;
  if (target) {
    const targetKey = target.key || target.uid || target.id || 'unknown-target';
    let detail = enemy.targets.get(String(targetKey));
    if (!detail) {
      detail = { key: String(targetKey), name: target.name || target.id || String(targetKey), current: 0, total: 0, currentTypes: emptyDamageTypes(), totalTypes: emptyDamageTypes() };
      enemy.targets.set(String(targetKey), detail);
    }
    detail.current += n;
    detail.total += n;
    detail.currentTypes[key] = (detail.currentTypes[key] || 0) + n;
    detail.totalTypes[key] = (detail.totalTypes[key] || 0) + n;
  }
}

function recordDamage(source, amount, type, targetId = null, context = null) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  const target = unitFromId(targetId, context);
  if (source && source.side === 'enemy') {
    if (target && target.side === 'ally') {
      recordEnemyDamage(source, target, n, type);
      scheduleRender('damage');
    }
    return;
  }
  // The operator window only accepts damage dealt to an enemy. This prevents
  // enemy hits and friendly-fire/reflect damage from leaking into its
  // unattributed row while still preserving unknown ally hits on enemies.
  if (source && source.side === 'ally' && target && target.side !== 'enemy') return;
  if (!source && target && target.side !== 'enemy') return;
  const rec = source && isOperatorRecord(source) ? source : null;
  if (rec) {
    const key = normalizeDamageType(type);
    rec.current += n;
    rec.total += n;
    rec.currentTypes[key] = (rec.currentTypes[key] || 0) + n;
    rec.totalTypes[key] = (rec.totalTypes[key] || 0) + n;
    recordPlayerDamage(rec.ownerId, n, key);
  } else addDamageToBucket(state.damage.unattributed, n, type);
  scheduleRender('damage');
}

function mergeReportedDamage(raw, rec, sourceKey = 'stats', snapshotKey = null, allowStopped = false) {
  if (!rec || !raw || typeof raw !== 'object') return;
  if ((!state.damage.collecting && !allowStopped) || state.damage.paused) return;
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : raw;
  const reported = finiteNumber(stats.damage, stats.dmg, stats.damageDealt, stats.dealt);
  if (reported != null && reported >= 0) {
    const battleKey = snapshotKey ?? state.damage.battleId ?? 'round';
    const key = `${sourceKey}:${battleKey}:${state.damage.round ?? 'match'}`;
    const prev = rec.reported[key] ?? 0;
    if (reported >= prev) {
      // Reported values are snapshots, while b.ev values are increments. Bring the displayed
      // counter up to the snapshot without double-counting event increments already seen.
      const delta = reported - prev;
      const before = rec.current;
      if (delta > 0 && rec.current < reported) {
        rec.current = reported;
        rec.total += Math.max(0, reported - before);
      }
      rec.reported[key] = reported;
    }
  }
  const byType = stats.damageByType || stats.dmgByType || stats.types;
  if (byType && typeof byType === 'object' && !Array.isArray(byType)) {
    for (const [type, value] of Object.entries(byType)) {
      const n = Number(value);
      if (!(n >= 0)) continue;
      const key = normalizeDamageType(type);
      rec.currentTypes[key] = Math.max(rec.currentTypes[key] || 0, n);
      rec.totalTypes[key] = Math.max(rec.totalTypes[key] || 0, n);
    }
  }
}

function updateDamageUnits(rawUnits, sourceKey = 'frame', owner = {}, snapshotKey = null, allowStopped = false, context = null) {
  if (!Array.isArray(rawUnits)) return;
  for (const raw of rawUnits) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = ensureDamageUnit(raw, {
      ...(sourceKey.startsWith('result') || sourceKey === 'unitStats' ? { kind: 'op', side: 'ally' } : {}),
      ...(owner.playerId ? { ownerId: owner.playerId } : {}),
    }, context);
    mergeReportedDamage(raw, rec, sourceKey, snapshotKey, allowStopped);
  }
  scheduleRender('damage');
}

function unitFromId(id, context = null) {
  if (id == null) return null;
  const key = String(id);
  const index = state.damage.unitIndex;
  if (context != null) {
    // A frame with a known field/battle resolves only inside its own context: ids restart every
    // battle, so another field's unit with the same number must never be reached.
    return index.get(runtimeScopedKey(context, key)) || null;
  }
  // A frame without an identity (old servers, synthetic frames): accept a runtime id only when
  // exactly one indexed unit carries it — never the uid-keyed record sharing the number.
  const matches = [];
  for (const [scoped, rec] of index) {
    if (scoped.endsWith(`${RUNTIME_SCOPE_SEP}${key}`) && !matches.includes(rec)) matches.push(rec);
  }
  return matches.length === 1 ? matches[0] : null;
}

function registerAttack(sourceId, targetId, context = null) {
  if (sourceId == null || targetId == null) return;
  // A target may have several projectiles in flight at once. Keep a short FIFO
  // instead of replacing the previous attacker; the old single entry caused a
  // later hit to be credited to whichever operator attacked last.
  const source = unitFromId(sourceId, context);
  const target = unitFromId(targetId, context);
  const operatorAttack = isOperatorRecord(source) && (!target || target.side === 'enemy');
  const enemyAttack = source?.side === 'enemy' && (!target || target.side === 'ally');
  if (!operatorAttack && !enemyAttack) return;
  const key = runtimeScopedKey(context, targetId);
  const pending = state.damage.attackSources.get(key) || [];
  pending.push({ source: String(sourceId), at: now() });
  while (pending.length > 16) pending.shift();
  state.damage.attackSources.set(key, pending);
}

function consumePendingAttack(targetId, sourceId, context = null) {
  if (targetId == null || sourceId == null) return;
  const key = runtimeScopedKey(context, targetId);
  const pending = state.damage.attackSources.get(key);
  if (!pending) return;
  const source = String(sourceId);
  const index = pending.findIndex((entry) => entry && entry.source === source);
  if (index >= 0) pending.splice(index, 1);
  if (pending.length) state.damage.attackSources.set(key, pending);
  else state.damage.attackSources.delete(key);
}

function sourceForDamage(sourceId, targetId, context = null) {
  if (sourceId != null) {
    // A modern damage tuple follows an older `atk` tuple in the same frame.
    // Consume that matching fallback entry so a later legacy hit cannot reuse it.
    consumePendingAttack(targetId, sourceId, context);
    const known = unitFromId(sourceId, context);
    if (!known) {
      // Without a field record we cannot prove that this source is one of our operators. Keep it
      // unattributed instead of manufacturing an ally record that could turn enemy damage into a
      // fake operator row.
      return null;
    }
    // Preserve explicit enemy sources as well. `recordDamage` routes these to the
    // enemy aggregation window; dropping them here incorrectly turns the hit into
    // unattributed damage when the target is an allied operator or summon.
    if (known.side === 'enemy') return known;
    return isOperatorRecord(known) ? known : null;
  }
  const key = targetId == null ? null : runtimeScopedKey(context, targetId);
  const pending = key == null ? null : state.damage.attackSources.get(key);
  if (!pending) return null;
  const at = now();
  while (pending.length && at - pending[0].at > 8000) pending.shift();
  if (!pending.length) { state.damage.attackSources.delete(key); return null; }
  // Vanilla frames carry no source id: stand in with the queue only while it names exactly one
  // attacker. Several different attackers in flight (a melee hit landing between a ranged shot
  // and its projectile) or an unknown source stay unattributed instead of guessing.
  const sources = [];
  for (const entry of pending) if (entry && !sources.includes(entry.source)) sources.push(entry.source);
  if (sources.length !== 1) { state.damage.attackSources.delete(key); return null; }
  const next = pending.shift();
  if (pending.length) state.damage.attackSources.set(key, pending);
  else state.damage.attackSources.delete(key);
  const rec = unitFromId(next.source, context);
  if (rec?.side === 'enemy') return rec;
  return isOperatorRecord(rec) ? rec : null;
}

function handleStatusEvent(unitId, key, active, raw = {}, context = null) {
  // Status events can belong to enemies too. Only attach them after field metadata has identified
  // the unit; manufacturing an ally record here would later credit enemy damage to a fake operator.
  const rec = unitFromId(unitId, context);
  if (!rec) return;
  const payload = String(key) === 'skill' ? { ...raw, name: damageSkillName(rec, raw) || raw.name || raw.label || '技能' } : raw;
  ensureDamageEffect(rec, key, payload, active !== false);
  scheduleRender('damage');
}

function parseDamageEvent(event, frame = {}) {
  const context = frameDamageContext(frame);
  if (Array.isArray(event)) {
    const kind = String(event[0] ?? '').toLowerCase();
    if (kind === 'spawn') {
      // Enemy instances created after the initial m.field snapshot announce
      // their complete UnitInfo in b.ev. Register it before later damage
      // tuples in the same frame are resolved by source id.
      const unit = event[1];
      if (unit && typeof unit === 'object') ensureDamageUnit(unit, {}, context);
      return;
    }
    if (kind === 'atk' || kind === 'attack') {
      if (event.length >= 3) registerAttack(event[1], event[2], context);
      return;
    }
    if (kind === 'dmg' || kind === 'damage' || kind === 'hit') {
      // Canonical sim tuples are [dmg, target, amount, type, mark]. A patched sim appends the
      // credited attacker's unit id at index 5 (mark slot null at 4 when the hit is not red): the
      // hit is pinned to its own operator — and, together with the unit's ownerId, to its own
      // player — so attack-order guessing (the attackSources queue, which a melee hit landing
      // between a ranged shot and its projectile swaps between the two) only stands in for
      // vanilla frames. A TAGGED hit with a null id is genuinely sourceless: it must not consume
      // a queued attack of a later vanilla frame either.
      const legacySourceFirst = event.length === 5 && Number.isFinite(Number(event[3])) && event[4] !== 'r';
      const tagged = event.length >= 6;
      const sourceId = tagged ? event[5] : (legacySourceFirst ? event[1] : null);
      const targetId = legacySourceFirst ? event[2] : event[1];
      const amount = legacySourceFirst ? event[3] : event[2];
      const type = legacySourceFirst ? event[4] : event[3];
      const source = tagged
        ? (sourceId == null ? null : sourceForDamage(sourceId, targetId, context))
        : sourceForDamage(null, targetId, context);
      recordDamage(source, amount, type, targetId, context);
      return;
    }
    if (kind === 'status' || kind === 'buff' || kind === 'debuff' || kind === 'effect') {
      handleStatusEvent(event[1], event[2], event[3] !== 0 && event[3] !== false, { duration: event[4], type: kind }, context);
      return;
    }
    if (kind === 'skill') {
      handleStatusEvent(event[1], 'skill', event[2] !== 0 && event[2] !== false, { positive: true, name: '技能' }, context);
    }
    return;
  }
  if (!event || typeof event !== 'object') return;
  const kind = String(event.t ?? event.type ?? event.kind ?? '').toLowerCase();
  if (kind === 'spawn') {
    const unit = event.unit ?? event.data ?? event.payload;
    if (unit && typeof unit === 'object') ensureDamageUnit(unit, {}, context);
    return;
  }
  if (kind === 'atk' || kind === 'attack') { registerAttack(event.sourceId ?? event.source ?? event.src ?? event.attacker, event.targetId ?? event.target ?? event.tgt, context); return; }
  if (kind === 'dmg' || kind === 'damage' || kind === 'hit') {
    const targetId = event.targetId ?? event.target ?? event.tgt ?? event.to;
    const sourceId = event.sourceId ?? event.source ?? event.src ?? event.attacker ?? event.from;
    recordDamage(sourceForDamage(sourceId, targetId, context), event.amount ?? event.damage ?? event.value ?? event.n, event.damageType ?? event.typeName ?? event.element ?? event.type, targetId, context);
    return;
  }
  if (kind === 'status' || kind === 'buff' || kind === 'debuff' || kind === 'effect') {
    handleStatusEvent(event.unitId ?? event.targetId ?? event.target ?? event.id, event.key ?? event.status ?? event.effectId ?? event.name, event.active ?? event.on ?? event.enabled, event, context);
  }
}

function parseBattleEvents(msg) {
  const events = msg?.ev || msg?.events || msg?.event || msg?.data?.ev;
  if (Array.isArray(events)) {
    if (!rememberDamageFrame(msg, events)) return;
    for (const event of events) parseDamageEvent(event, msg);
  } else if (events && typeof events === 'object') {
    if (!rememberDamageFrame(msg, events)) return;
    parseDamageEvent(events, msg);
  }
  if (msg?.gt != null) state.damage.lastFrameAt = Number(msg.gt) || state.damage.lastFrameAt;
  scheduleRender('damage');
}

function rememberDamageFrame(msg, events) {
  const battle = msg?.battleId ?? msg?.fieldId;
  const gameTime = msg?.gt;
  // Frames without an identity must remain processable; only deduplicate
  // identifiable frames that can arrive through both net and runner paths.
  if (battle == null || !Number.isFinite(Number(gameTime))) return true;
  let payload;
  try { payload = JSON.stringify(events); } catch { return true; }
  const key = `${battle}:${gameTime}:${payload}`;
  if (state.damage.seenFrames.has(key)) return false;
  state.damage.seenFrames.set(key, now());
  while (state.damage.seenFrames.size > 512) state.damage.seenFrames.delete(state.damage.seenFrames.keys().next().value);
  return true;
}

function parseTeamEffects(rawEffects) {
  if (!Array.isArray(rawEffects)) return;
  if (!state.damage.collecting || state.damage.paused) return;
  for (const raw of rawEffects) {
    if (!raw || typeof raw !== 'object') continue;
    const key = String(raw.id ?? raw.key ?? raw.name ?? 'effect');
    let effect = state.damage.teamEffects.get(key);
    if (!effect) effect = { key, label: damageEffectName(key, raw), type: damageEffectType(key, raw), startedAt: now(), endedAt: now(), expiresAt: null, active: true };
    effect.label = damageEffectName(key, raw);
    effect.type = damageEffectType(key, raw);
    effect.active = raw.active !== false;
    const duration = effectDurationMs(raw, now());
    if (duration != null) effect.expiresAt = effect.startedAt + duration;
    state.damage.teamEffects.set(key, effect);
  }
  while (state.damage.teamEffects.size > 24) state.damage.teamEffects.delete(state.damage.teamEffects.keys().next().value);
  scheduleRender('damage');
}

function parseDamageFrame(msg) {
  if (!msg || typeof msg !== 'object') return;
  const context = damageFrameContext(msg);
  if (msg.t === 'm.field' || msg.t === 'b.start') startDamageBattle(msg.battleId);
  if (msg.phase) setDamageLifecycle({ active: DAMAGE_BATTLE_PHASES.has(msg.phase), paused: !!msg.paused, phase: msg.phase });
  if (msg.round != null) resetDamageRound(msg.round);
  if (msg.battleId != null) state.damage.battleId = String(msg.battleId);
  if (Array.isArray(msg.units)) updateDamageUnits(msg.units, msg.t || 'frame', {}, msg.battleId, false, context);
  if (!state.damage.collecting || state.damage.paused) return;
  if (Array.isArray(msg.effects)) parseTeamEffects(msg.effects);
  if (msg.spec) {
    const players = Array.isArray(msg.spec.players) ? msg.spec.players : [];
    for (const player of players) {
      ensureDamagePlayer(player);
      updateDamageUnits(player?.units || player?.board || [], 'battle-spec', player, null, false, context);
    }
  }
  parseBattleEvents(msg);
}

function parseResultDamage(msg, allowFinal = false) {
  if (state.damage.paused || (!state.damage.collecting && !allowFinal)) return;
  const context = damageFrameContext(msg);
  const result = msg?.result && typeof msg.result === 'object' ? msg.result : msg;
  for (const player of Array.isArray(result?.players) ? result.players : []) {
    // stats.dmgDealt is the match's cumulative damage — a 全局累计 floor, never a per-round delta
    const rec = mergeReportedPlayerDamage(player, { total: player?.stats?.dmgDealt }, 'result', { allowStopped: allowFinal });
    if (rec && allowFinal && finiteNumber(player?.stats?.dmgDealt) != null) rec.settled = true;
    updateDamageUnits(player?.unitStats || [], 'result', player, msg?.battleId, allowFinal, context);
    const units = player?.units || player?.lineup || [];
    updateDamageUnits(units, 'result-units', player, msg?.battleId, allowFinal, context);
    if (player?.stats?.dmgDealt != null) {
      // Keep team-level result visible as unattributed when no per-operator stats exist.
      if (!Array.isArray(player.unitStats) || !player.unitStats.length) {
        const n = Number(player.stats.dmgDealt);
        if (Number.isFinite(n)) state.damage.unattributed.total = Math.max(state.damage.unattributed.total, n);
      }
    }
  }
  updateDamageUnits(result?.unitStats || [], 'result', {}, msg?.battleId, allowFinal, context);
  scheduleRender('damage');
}

// ---------------------------------------------------------------------------------------------
// render scheduling
//
// Every update goes through one rAF-coalesced slot, so a burst of events (a welcome plus a
// room.state plus a phase change in the same tick) costs exactly one repaint.
// ---------------------------------------------------------------------------------------------

const dirty = new Set();
let rafQueued = false;

function scheduleRender(what) {
  dirty.add(what);
  if (rafQueued || state.cfg.paused) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (!state.mounted) { dirty.clear(); return; }
    const jobs = [...dirty];
    dirty.clear();
    for (const job of jobs) {
      if (job === 'status') renderStatus();
      else if (job === 'spark') renderSparkline();
      else if (job === 'server') { renderServer(); renderStats(); renderHome(); }
      else if (job === 'match') { renderMatch(); renderHome(); }
      else if (job === 'invite') { renderInvite(); renderHome(); }
      else if (job === 'perf') { renderPerf(); renderHome(); }
      else if (job === 'log') { renderLog(); renderHome(); }
      else if (job === 'home') renderHome();
      else if (job === 'damage') renderDamage();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// markup
// ---------------------------------------------------------------------------------------------

let root = null;
let els = {};

function iconBtn(id, glyph, title, onClick) {
  return h('button', { class: 'rh-ibtn', id, title, 'aria-label': title, onclick: onClick }, glyph);
}

/** One row of the header menu: label + on/off state. */
function menuRow(id, label, on, onClick) {
  return h('button', { class: `rh-menu-row ${on ? 'is-on' : ''}`, id, onclick: onClick },
    h('span', { class: 'rh-menu-label', text: label }),
    h('span', { class: 'rh-menu-state', text: on ? '开' : '关' }),
  );
}

function closeMenu() {
  const menu = $('#rh-menu', root);
  const btn = $('#rh-menu-btn', root);
  if (menu) menu.classList.remove('is-open');
  if (btn) btn.classList.remove('is-on');
}

/** Reflect pin/mini/pause state into the menu rows (called after any toggle). */
function syncMenu() {
  const rows = {
    'rh-menu-pin': state.cfg.pinned,
    'rh-menu-mini': state.cfg.mini,
    'rh-menu-pause': state.cfg.paused,
    'rh-menu-damage': state.cfg.page === 'damage',
  };
  for (const [id, on] of Object.entries(rows)) {
    const row = $('#' + id, root);
    if (!row) continue;
    row.classList.toggle('is-on', on);
    const stateEl = $('.rh-menu-state', row);
    if (stateEl) stateEl.textContent = on ? '开' : '关';
  }
}

function damageTypeText(type) { return DAMAGE_TYPE_TEXT[normalizeDamageType(type)] || String(type || '未分类'); }

function formatDamageNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n * 10) / 10);
}

function damageTypesText(types) {
  const entries = Object.entries(types || {}).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.slice(0, 4).map(([key, n]) => `${damageTypeText(key)} ${formatDamageNumber(n)}`).join(' · ') : '—';
}

function damageTypesForDisplay(record) {
  if (!record) return '—';
  const current = damageTypesText(record.currentTypes);
  return current !== '—' ? current : damageTypesText(record.totalTypes);
}

function activeEffectsText(rec) {
  const effects = [...(rec?.effects?.values?.() || [])]
    .filter((e) => e.active || now() - e.endedAt < 8000)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt)
    .slice(0, 4);
  return effects.length ? effects.map(effectText).join('；') : '—';
}

// ---------------------------------------------------------------------------------------------
// damage views — one table each (干员 / 玩家 / 敌人), docked in the 伤害 page or in their own window
// ---------------------------------------------------------------------------------------------

/**
 * The three damage tables (v1.7.0). Each has exactly ONE content element, moved between its dock
 * on the 伤害 page and its own floating window when popped — so both places share one render path,
 * one scroll position and one set of column widths, and no table is ever built twice. The old
 * `#rh-damage-window` / `#rh-players-damage-window` / `#rh-enemies-damage-window` ids still name
 * the floating windows.
 */
const DAMAGE_MODULES = [
  { kind: 'operators', title: '干员伤害', tab: '干员', aria: '战斗伤害统计', defW: 620, minW: 360, defH: 300, minH: 240, offX: 0, offY: 0, foot: '本回合 / 全局 · 伤害类型 · 增益/减益持续时间' },
  { kind: 'players', title: '玩家伤害', tab: '玩家', aria: '玩家伤害统计', defW: 420, minW: 320, defH: 260, minH: 220, offX: 260, offY: 0, foot: '本回合 / 全局累计' },
  { kind: 'enemies', title: '敌人伤害', tab: '敌人', aria: '敌方伤害统计', defW: 420, minW: 320, defH: 260, minH: 220, offX: 0, offY: 300, foot: '本回合 / 全局 · 伤害类型 · 受伤干员' },
];
const DAMAGE_KINDS = DAMAGE_MODULES.map((m) => m.kind);
const damageModule = (kind) => DAMAGE_MODULES.find((m) => m.kind === kind) || DAMAGE_MODULES[0];

/** kind → { content, els, window, dock }: the shared view, its window (built on the first pop) and its dock. */
const damageView = {};
let damagePageEl = null;
let damagePopBtn = null;
const damageTabChips = {};

/** Column drag limits per kind; the widths live on the shared content element (both hosts read them). */
const DAMAGE_COLUMNS = {
  operators: { prefix: '--rh-damage-col-', limits: { name: [100, 360], current: [52, 180], total: [52, 180], types: [96, 360], effects: [140, 520] } },
  players: { prefix: '--rh-player-col-', limits: { name: [90, 360], current: [52, 180], total: [52, 180], types: [96, 360] } },
  enemies: { prefix: '--rh-damage-col-', limits: { name: [100, 360], current: [52, 180], total: [52, 180], types: [96, 360], targets: [140, 520] } },
};

const damageCfg = (kind) => state.cfg.damageWindow.windows[kind];
const damageIsPopped = (kind) => state.cfg.damageWindow.popped[kind] === true;
const damageTab = () => (DAMAGE_KINDS.includes(state.cfg.damageWindow.tab) ? state.cfg.damageWindow.tab : 'operators');

/** Every element carrying the damage font scale: the 伤害 page (docked tables) and the open windows. */
function damageHosts() {
  const hosts = [damagePageEl];
  for (const kind of DAMAGE_KINDS) if (damageView[kind]?.window) hosts.push(damageView[kind].window);
  return hosts.filter(Boolean);
}

/** The content of one damage table: round + summary strip, the rows, a foot line. Built once. */
function buildDamageView(kind) {
  const mod = damageModule(kind);
  const id = (suffix) => (kind === 'operators' ? `rh-damage-${suffix}` : `rh-${kind}-damage-${suffix}`);
  const round = h('span', { class: 'rh-damage-round', id: id('round'), text: '等待战斗' });
  const summary = h('span', { class: 'rh-damage-summary', id: id('summary'), text: '等待战斗数据…' });
  const strip = h('div', { class: 'rh-damage-strip' }, round, summary);
  const body = h('div', { class: 'rh-damage-scroll', id: id('body') });
  const foot = h('div', { class: 'rh-damage-foot', id: id('foot'), text: mod.foot });
  const content = h('div', { class: 'rh-damage-view', id: `rh-damage-view-${kind}` }, strip, body, foot);
  const els = { round, summary, body, foot, strip };
  if (kind === 'operators') {
    els.table = h('div', { class: 'rh-damage-table', id: 'rh-damage-table' });
    els.effects = h('div', { class: 'rh-damage-team-effects', id: 'rh-damage-team-effects' });
    body.append(els.table, els.effects);
  }
  return { mod, content, els };
}

/** Build the shared view on first use, restore its saved column widths and bind the header dividers. */
function ensureDamageView(kind) {
  if (damageView[kind]) return damageView[kind];
  const built = buildDamageView(kind);
  damageView[kind] = { ...built, window: null, dock: null };
  applyDamageColumns(kind);
  enableDamageColumnResize(kind);
  return damageView[kind];
}

function applyDamageColumns(kind) {
  const view = damageView[kind];
  const spec = DAMAGE_COLUMNS[kind];
  if (!view || !spec) return;
  for (const [col, width] of Object.entries(damageCfg(kind).columnWidths || {})) {
    if (spec.limits[col] && Number.isFinite(Number(width))) {
      view.content.style.setProperty(`${spec.prefix}${col}`, `${clamp(Number(width), spec.limits[col][0], spec.limits[col][1])}px`);
    }
  }
}

/** The floating window of one table (the old windows' title bar and ids), built on the first pop. */
function buildDamageWindow(kind) {
  const mod = damageModule(kind);
  const cfg = damageCfg(kind);
  const panel = h('div', {
    class: 'rh-damage-window rh-damage-host',
    id: kind === 'operators' ? 'rh-damage-window' : `rh-${kind}-damage-window`,
    role: 'dialog', 'aria-label': mod.aria,
  });
  panel.style.setProperty('--rh-damage-w', `${clamp(Number(cfg.width) || mod.defW, mod.minW, 860)}px`);
  panel.style.setProperty('--rh-damage-scale', String(clamp(Number(state.cfg.damageWindow.fontScale) || 1, 0.8, 1.5)));
  if (Number.isFinite(Number(cfg.height))) {
    panel.style.height = `${clamp(Number(cfg.height), mod.minH, Math.max(mod.minH, (globalThis.innerHeight || 768) - 16))}px`;
  }
  const fold = h('button', { class: 'rh-ibtn', id: kind === 'operators' ? 'rh-damage-fold' : null, title: '折叠 / 展开', onclick: () => {
    cfg.collapsed = !cfg.collapsed;
    panel.classList.toggle('is-collapsed', cfg.collapsed);
    fold.textContent = cfg.collapsed ? '+' : '—';
    saveConfig();
  } }, cfg.collapsed ? '+' : '—');
  const close = h('button', { class: 'rh-ibtn rh-ibtn--x', id: kind === 'operators' ? 'rh-damage-close' : null, title: `收回「${mod.title}」（放回伤害页）`, onclick: () => setDamagePopped(kind, false) }, '×');
  const head = h('div', { class: 'rh-damage-head' },
    h('span', { class: 'rh-dot is-ok' }),
    h('span', { class: 'rh-damage-title', text: mod.title }),
    h('div', { class: 'rh-head-actions' }, fold, close),
  );
  const body = h('div', { class: 'rh-damage-body' });
  const grip = h('div', { class: 'rh-damage-grip', title: '拖动调整窗口大小', 'aria-label': '拖动调整窗口大小' });
  panel.append(head, body, grip);
  if (cfg.collapsed) panel.classList.add('is-collapsed');
  enableDamageWindowDrag(kind, panel);
  return panel;
}

/** Where a view lives right now: its floating window (popped) or its dock on the 伤害 page. */
function mountDamageView(kind) {
  const view = ensureDamageView(kind);
  if (damageIsPopped(kind)) {
    if (!view.window) view.window = buildDamageWindow(kind);
    const body = view.window.querySelector('.rh-damage-body');
    if (body && view.content.parentElement !== body) body.append(view.content);
    if (!view.window.isConnected) document.body.append(view.window);
    placeDamageWindow(kind);
  } else {
    view.window?.remove();
    if (view.dock && view.content.parentElement !== view.dock) view.dock.append(view.content);
  }
  syncDamageDock(kind);
  syncDamagePopButton();
}

/** While a table floats, its dock keeps a small "it is in its own window" placeholder with a 收回 button. */
function syncDamageDock(kind) {
  const view = damageView[kind];
  if (!view?.dock) return;
  if (!damageIsPopped(kind)) {
    if (view.content.parentElement !== view.dock) view.dock.replaceChildren(view.content);
    return;
  }
  const mod = damageModule(kind);
  view.dock.replaceChildren(h('div', { class: 'rh-damage-detached' },
    h('span', { text: `${mod.title}已在独立窗口中显示。` }),
    h('button', { class: 'rh-mini', type: 'button', title: `把「${mod.title}」放回面板`, onclick: () => setDamagePopped(kind, false) }, '收回'),
  ));
}

function setDamagePopped(kind, popped) {
  if (!DAMAGE_KINDS.includes(kind)) return;
  state.cfg.damageWindow.popped[kind] = !!popped;
  mountDamageView(kind);
  syncDamageTabs();
  saveConfig();
  scheduleRender('damage');
}

function syncDamagePopButton() {
  if (!damagePopBtn) return;
  const kind = damageTab();
  const popped = damageIsPopped(kind);
  const mod = damageModule(kind);
  damagePopBtn.textContent = popped ? '收回窗口' : '独立窗口';
  damagePopBtn.title = popped ? `把「${mod.title}」放回伤害页` : `把「${mod.title}」弹成独立窗口（可拖动 / 缩放）`;
  damagePopBtn.classList.toggle('is-on', popped);
}

function syncDamageTabs() {
  const active = damageTab();
  state.cfg.damageWindow.tab = active;
  for (const kind of DAMAGE_KINDS) {
    const dock = damageView[kind]?.dock;
    if (dock) dock.hidden = kind !== active;
    const chip = damageTabChips[kind];
    if (chip) chip.classList.toggle('is-on', kind === active);
  }
  syncDamagePopButton();
}

function setDamageTab(kind) {
  if (!DAMAGE_KINDS.includes(kind)) kind = 'operators';
  state.cfg.damageWindow.tab = kind;
  syncDamageTabs();
  saveConfig();
}

/** The 伤害 page: a tab strip for the three tables and a 「独立窗口」 toggle for the active one. */
function buildDamagePage() {
  const tabs = h('div', { class: 'rh-damage-tabs', id: 'rh-damage-tabs' },
    ...DAMAGE_MODULES.map((m) => {
      const chip = h('button', {
        class: 'rh-chip', type: 'button', id: `rh-damage-tab-${m.kind}`, 'data-kind': m.kind,
        title: `查看${m.title}`,
        onclick: () => setDamageTab(m.kind),
      }, m.tab);
      damageTabChips[m.kind] = chip;
      return chip;
    }));
  const docks = h('div', { class: 'rh-damage-docks', id: 'rh-damage-docks' },
    ...DAMAGE_MODULES.map((m) => h('div', { class: 'rh-damage-dock', id: `rh-damage-dock-${m.kind}`, 'data-kind': m.kind })));
  damagePopBtn = h('button', { class: 'rh-mini', id: 'rh-damage-pop', type: 'button', title: '弹成独立窗口', onclick: () => {
    const kind = damageTab();
    setDamagePopped(kind, !damageIsPopped(kind));
  } }, '独立窗口');
  const page = buildPage('damage', '伤害', [tabs, docks], damagePopBtn);
  page.classList.add('rh-damage-host');
  damagePageEl = page;
  for (const m of DAMAGE_MODULES) ensureDamageView(m.kind).dock = page.querySelector(`#rh-damage-dock-${m.kind}`);
  return page;
}

function placeDamageWindow(kind) {
  const view = damageView[kind];
  const panel = view?.window;
  if (!panel) return;
  const mod = damageModule(kind);
  const cfg = damageCfg(kind);
  const vw = globalThis.innerWidth || 1024;
  const vh = globalThis.innerHeight || 768;
  const w = panel.offsetWidth || cfg.width || mod.defW;
  const hgt = panel.offsetHeight || mod.defH;
  const x = cfg.x == null ? Math.max(8, vw - w - 16 - mod.offX) : cfg.x;
  const y = cfg.y == null ? Math.max(8, vh - hgt - 20 - mod.offY) : cfg.y;
  panel.style.left = `${clamp(x, 8, Math.max(8, vw - w - 8))}px`;
  panel.style.top = `${clamp(y, 8, Math.max(8, vh - hgt - 8))}px`;
}

function enableDamageWindowDrag(kind, panel) {
  const mod = damageModule(kind);
  const cfg = damageCfg(kind);
  const head = panel.querySelector('.rh-damage-head');
  if (head) {
    let active = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      active = true; sx = ev.clientX; sy = ev.clientY; ox = panel.offsetLeft; oy = panel.offsetTop;
      panel.classList.add('is-dragging'); head.setPointerCapture?.(ev.pointerId); ev.preventDefault();
    });
    head.addEventListener('pointermove', (ev) => {
      if (!active) return;
      const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
      panel.style.left = `${clamp(ox + ev.clientX - sx, 8, Math.max(8, vw - panel.offsetWidth - 8))}px`;
      panel.style.top = `${clamp(oy + ev.clientY - sy, 8, Math.max(8, vh - panel.offsetHeight - 8))}px`;
    });
    const end = (ev) => {
      if (!active) return;
      active = false; panel.classList.remove('is-dragging'); head.releasePointerCapture?.(ev.pointerId);
      cfg.x = panel.offsetLeft; cfg.y = panel.offsetTop; saveConfig();
    };
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
  }
  const grip = panel.querySelector('.rh-damage-grip');
  if (!grip) return;
  let resizing = false, rw = 0, rh = 0, rsx = 0, rsy = 0;
  grip.addEventListener('pointerdown', (ev) => {
    resizing = true;
    rw = panel.offsetWidth; rh = panel.offsetHeight;
    rsx = ev.clientX; rsy = ev.clientY;
    panel.classList.add('is-resizing');
    grip.setPointerCapture?.(ev.pointerId);
    ev.preventDefault(); ev.stopPropagation();
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!resizing) return;
    const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
    const width = clamp(rw + ev.clientX - rsx, mod.minW, Math.min(860, vw - 16));
    const height = clamp(rh + ev.clientY - rsy, mod.minH, Math.min(900, vh - 16));
    panel.style.setProperty('--rh-damage-w', `${width}px`);
    panel.style.height = `${height}px`;
  });
  const endResize = (ev) => {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('is-resizing');
    grip.releasePointerCapture?.(ev.pointerId);
    cfg.width = panel.offsetWidth;
    cfg.height = panel.offsetHeight;
    saveConfig();
  };
  grip.addEventListener('pointerup', endResize); grip.addEventListener('pointercancel', endResize);
}

function enableDamageColumnResize(kind) {
  const view = ensureDamageView(kind);
  const spec = DAMAGE_COLUMNS[kind];
  if (!spec || view.content.dataset.resizeBound) return;
  view.content.dataset.resizeBound = '1';
  view.content.addEventListener('pointerdown', (ev) => {
    const cell = ev.target.closest('[data-damage-col]');
    if (!cell || !view.content.contains(cell)) return;
    const col = cell.dataset.damageCol;
    if (!spec.limits[col]) return;
    // Resize from the divider on the cell's right edge — starting in the text area used to make the
    // whole header a handle and made the movement feel reversed.
    const rect = cell.getBoundingClientRect();
    if (ev.clientX < rect.right - 12) return;
    const startX = ev.clientX;
    const startWidth = Math.max(spec.limits[col][0], rect.width);
    const move = (e) => {
      const width = clamp(startWidth + (e.clientX - startX), spec.limits[col][0], spec.limits[col][1]);
      view.content.style.setProperty(`${spec.prefix}${col}`, `${width}px`);
    };
    const end = (e) => {
      cell.releasePointerCapture?.(e.pointerId);
      cell.removeEventListener('pointermove', move);
      cell.removeEventListener('pointerup', end);
      cell.removeEventListener('pointercancel', end);
      const width = clamp(Math.round(cell.getBoundingClientRect().width), spec.limits[col][0], spec.limits[col][1]);
      damageCfg(kind).columnWidths = { ...(damageCfg(kind).columnWidths || {}), [col]: width };
      saveConfig();
    };
    cell.setPointerCapture?.(ev.pointerId);
    cell.addEventListener('pointermove', move);
    cell.addEventListener('pointerup', end);
    cell.addEventListener('pointercancel', end);
    ev.preventDefault();
    ev.stopPropagation();
  });
}

/** Re-show the windows the config says float (called when the overlay appears again). */
function restoreDamageWindows() {
  for (const kind of DAMAGE_KINDS) if (damageIsPopped(kind)) mountDamageView(kind);
}

/** Detach the floating windows with the overlay; the 收回 state itself stays in the config. */
function hideDamageWindows() {
  for (const kind of DAMAGE_KINDS) damageView[kind]?.window?.remove();
}

/** 恢复默认: all three tables back into the 伤害 page with the default position, size and columns. */
function resetDamageLayout() {
  for (const kind of DAMAGE_KINDS) {
    const view = damageView[kind];
    if (!view) continue;
    view.window?.remove();
    view.window = null;
    const spec = DAMAGE_COLUMNS[kind];
    if (spec) for (const col of Object.keys(spec.limits)) view.content.style.removeProperty(`${spec.prefix}${col}`);
  }
  for (const kind of DAMAGE_KINDS) mountDamageView(kind);
  syncDamageTabs();
}

function operatorDamageRows() {
  return [...state.damage.units.values()]
    .filter(isOperatorRecord)
    .sort((a, b) => b.current - a.current || b.total - a.total || String(a.name).localeCompare(String(b.name), 'zh'));
}

function playerDamageRows() {
  return [...state.damage.players.values()]
    .sort((a, b) => b.current - a.current || b.total - a.total || a.name.localeCompare(b.name, 'zh'));
}

function enemyDamageRows() {
  return [...state.damage.enemies.values()]
    .sort((a, b) => b.current - a.current || b.total - a.total || String(a.name).localeCompare(String(b.name), 'zh'));
}

function renderPlayerDamagePanel(players) {
  const panel = damageView.players?.els;
  if (!panel?.body) return;
  panel.round.textContent = state.damage.round == null ? '等待战斗' : `第 ${state.damage.round} 回合`;
  panel.summary.textContent = players.length
    ? `本回合 ${formatDamageNumber(players.reduce((n, p) => n + p.current, 0))} · 全局累计 ${formatDamageNumber(players.reduce((n, p) => n + p.total, 0))}`
    : '等待玩家伤害数据…';
  panel.foot.textContent = state.damage.serverDmg
    ? '队友伤害由服务器每回合结算后同步（Boss 轮实时）'
    : '本服务器未启用队友伤害补丁：队友数据仅在本局结算时可见';
  if (!players.length) { panel.body.replaceChildren(h('div', { class: 'rh-damage-empty', text: '尚未收到玩家伤害事件' })); return; }
  const head = h('div', { class: 'rh-damage-player-row rh-damage-player-head' },
    ...[['name', '玩家'], ['current', '本回合'], ['total', '全局累计'], ['types', '类型']]
      .map(([col, text]) => h('span', { class: 'rh-damage-col-head', 'data-damage-col': col, text, title: '拖动调整列宽' })));
  panel.body.replaceChildren(head, ...players.map((player) => {
    const me = player.id === state.playerId;
    const unknown = !me && player.current <= 0 && player.total <= 0;
    return h('div', {
      class: `rh-damage-player-row ${player.current > 0 ? 'is-active' : ''}${me ? ' is-me' : ''}`,
      title: me ? '你：本地实时统计' : player.settled ? '本局结算数据' : '服务器按回合结算同步',
    },
      h('span', { class: 'rh-damage-player-name', text: me ? `${player.name}（你）` : player.name }),
      h('span', { class: 'rh-damage-num', text: unknown ? '—' : formatDamageNumber(player.current) }),
      h('span', { class: 'rh-damage-num', text: unknown ? '—' : formatDamageNumber(player.total) }),
      h('span', { class: 'rh-damage-types', text: damageTypesForDisplay(player) }),
    );
  }));
}

function renderEnemyDamagePanel(enemies) {
  const panel = damageView.enemies?.els;
  if (!panel?.body) return;
  panel.round.textContent = state.damage.round == null ? '等待战斗' : `第 ${state.damage.round} 回合`;
  panel.summary.textContent = enemies.length
    ? `本回合 ${formatDamageNumber(enemies.reduce((n, e) => n + e.current, 0))} · 全局 ${formatDamageNumber(enemies.reduce((n, e) => n + e.total, 0))}`
    : '等待敌方伤害数据…';
  if (!enemies.length) { panel.body.replaceChildren(h('div', { class: 'rh-damage-empty', text: '尚未收到敌方伤害事件' })); return; }
  const head = h('div', { class: 'rh-damage-row rh-damage-head-row' },
    ...[['name', '敌人'], ['current', '本回合'], ['total', '全局'], ['types', '伤害类型'], ['targets', '受伤干员']]
      .map(([col, text]) => h('span', { class: 'rh-damage-col-head', 'data-damage-col': col, text, title: '拖动调整列宽' })));
  panel.body.replaceChildren(head, ...enemies.map((enemy) => {
    const details = [...enemy.targets.values()].sort((a, b) => b.current - a.current).slice(0, 8)
      .map((target) => `${target.name} ${formatDamageNumber(target.current)}`).join('；') || '—';
    return h('div', { class: `rh-damage-row ${enemy.current > 0 ? 'is-active' : ''}` },
      h('span', { class: 'rh-damage-name', text: enemy.name }),
      h('span', { class: 'rh-damage-num', text: formatDamageNumber(enemy.current) }),
      h('span', { class: 'rh-damage-num', text: formatDamageNumber(enemy.total) }),
      h('span', { class: 'rh-damage-types', text: damageTypesForDisplay(enemy) }),
      h('span', { class: 'rh-damage-effects', text: details }),
    );
  }));
}

function renderDamage() {
  const op = damageView.operators?.els;
  if (!root || !op?.table) return;
  const d = state.damage;
  const rows = operatorDamageRows();
  const allCurrent = rows.reduce((sum, rec) => sum + rec.current, 0) + d.unattributed.current;
  const allTotal = rows.reduce((sum, rec) => sum + rec.total, 0) + d.unattributed.total;
  op.round.textContent = d.round == null ? '等待战斗' : `第 ${d.round} 回合`;
  op.summary.textContent = d.round == null
    ? '等待战斗事件；进入战斗后这里会实时更新。'
    : `本回合 ${formatDamageNumber(allCurrent)} · 全局 ${formatDamageNumber(allTotal)} · ${rows.length} 名干员`;
  renderPlayerDamagePanel(playerDamageRows());
  renderEnemyDamagePanel(enemyDamageRows());
  if (!rows.length && !d.unattributed.current && !d.unattributed.total) {
    op.table.replaceChildren(h('div', { class: 'rh-damage-empty', text: '尚未收到干员伤害事件' }));
  } else {
    const head = h('div', { class: 'rh-damage-row rh-damage-head-row' },
      ...[['name', '干员'], ['current', '本回合'], ['total', '全局'], ['types', '伤害类型'], ['effects', '增益 / 减益']]
        .map(([col, text]) => h('span', { class: 'rh-damage-col-head', 'data-damage-col': col, text, title: '拖动调整列宽' })));
    const body = rows.map((rec) => h('div', { class: `rh-damage-row ${rec.current > 0 ? 'is-active' : ''}` },
      h('span', { class: 'rh-damage-name', title: rec.uid ? `${rec.name} · ${rec.uid}` : rec.name, text: rec.name }),
      h('span', { class: 'rh-damage-num', text: formatDamageNumber(rec.current) }),
      h('span', { class: 'rh-damage-num', text: formatDamageNumber(rec.total) }),
      h('span', { class: 'rh-damage-types', text: damageTypesForDisplay(rec) }),
      h('span', { class: 'rh-damage-effects', text: activeEffectsText(rec) }),
    ));
    if (d.unattributed.current || d.unattributed.total) body.push(h('div', { class: 'rh-damage-row is-unattributed' },
      h('span', { class: 'rh-damage-name', text: '未归属伤害' }),
      h('span', { class: 'rh-damage-num', text: formatDamageNumber(d.unattributed.current) }),
      h('span', { class: 'rh-damage-num', text: formatDamageNumber(d.unattributed.total) }),
      h('span', { class: 'rh-damage-types', text: damageTypesForDisplay(d.unattributed) }),
      h('span', { class: 'rh-damage-effects', text: '协议未提供来源' }),
    ));
    op.table.replaceChildren(head, ...body);
  }
  const team = [...d.teamEffects.values()].filter((e) => e.active || now() - e.endedAt < 8000).slice(0, 8);
  op.effects.replaceChildren(...(team.length ? [
    h('div', { class: 'rh-damage-team-title', text: '全队效果' }),
    h('div', { class: 'rh-damage-team-list', text: team.map(effectText).join('；') }),
  ] : []));
  cardSub('damage', d.round == null
    ? (state.cfg.paused ? '已暂停' : '等待战斗')
    : `本回合 ${formatDamageNumber(allCurrent)} · ${rows.length} 名干员`);
}

function buildUi() {
  root = h('div', { class: 'rh-root', id: 'reality-hud', role: 'complementary', 'aria-label': 'Reality HUD' });

  // ---- header ---------------------------------------------------------------------------------
  // Keep the header minimal: collapse, a menu, and close. Everything rarer (pin / mini / pause /
  // settings) lives in the menu so the strip stays two buttons wide.
  const menuItems = h('div', { class: 'rh-menu', id: 'rh-menu' },
    menuRow('rh-menu-pin', '常驻显示', state.cfg.pinned, () => {
      state.cfg.pinned = !state.cfg.pinned;
      root.classList.toggle('rh-unpinned', !state.cfg.pinned);
      saveConfig();
      syncMenu();
    }),
    menuRow('rh-menu-mini', '迷你模式', state.cfg.mini, () => {
      toggleMini();
      syncMenu();
    }),
    menuRow('rh-menu-pause', '暂停采样', state.cfg.paused, () => {
      state.cfg.paused = !state.cfg.paused;
      applyTimers();
      saveConfig();
      scheduleRender('all');
      syncMenu();
    }),
    menuRow('rh-menu-damage', '伤害统计', state.cfg.page === 'damage', () => {
      closeMenu();
      setPage('damage');
      syncMenu();
    }),
    menuRow('rh-menu-settings', '打开设置', false, () => {
      closeMenu();
      openSettingsPage();
    }),
  );

  const menuBtn = h('button', {
    class: 'rh-ibtn', id: 'rh-menu-btn', title: '菜单',
    onclick: (ev) => {
      ev.stopPropagation();
      const open = menuItems.classList.toggle('is-open');
      menuBtn.classList.toggle('is-on', open);
    },
  }, '…');

  const header = h('div', { class: 'rh-head' },
    h('span', { class: 'rh-dot', id: 'rh-dot' }),
    h('span', { class: 'rh-title', text: 'R HUD' }),
    h('span', { class: 'rh-ver', id: 'rh-ver', text: '—' }),
    h('div', { class: 'rh-head-actions' },
      iconBtn('rh-fold', '—', '折叠 / 展开', () => {
        state.cfg.collapsed = !state.cfg.collapsed;
        root.classList.toggle('is-collapsed', state.cfg.collapsed);
        saveConfig();
      }),
      menuBtn,
      iconBtn('rh-close', '×', '隐藏（右下角浮标 / Shift+H 唤回）', () => hideOverlay()),
    ),
    menuItems,
  );

  // clicking anywhere outside the menu closes it
  document.addEventListener('pointerdown', (ev) => {
    if (!root.contains(ev.target)) return;
    if (!menuItems.contains(ev.target) && ev.target !== menuBtn) closeMenu();
  }, true);

  // ---- hero: latency --------------------------------------------------------------------------
  const pingNum = h('span', { class: 'rh-metric-num', id: 'rh-ping', text: '—' });
  const spark = buildSparkline();

  const hero = h('div', { class: 'rh-hero', id: 'rh-hero' },
    h('div', { class: 'rh-hero-main' },
      h('div', { class: 'rh-hero-label', text: '延迟 RTT' }),
      h('div', { class: 'rh-hero-num' }, pingNum, h('span', { class: 'rh-hero-unit', text: 'ms' })),
    ),
    spark,
  );

  const sub = h('div', { class: 'rh-sub', id: 'rh-sub', text: '等待连接…' });

  const stats = h('div', { class: 'rh-stats', id: 'rh-stats' });

  // ---- home page: overview + the page grid ----------------------------------------------------
  const cards = {};
  const cardsGrid = h('div', { class: 'rh-cards', id: 'rh-cards' },
    ...PAGES.map((p) => {
      const card = h('button', {
        class: 'rh-card', id: `rh-card-${p.id}`, type: 'button', 'data-page': p.id,
        title: `打开「${p.label}」`,
        onclick: () => setPage(p.id),
      },
        h('span', { class: 'rh-card-icon' }, cardIcon(p.icon)),
        h('span', { class: 'rh-card-main' },
          h('span', { class: 'rh-card-title', text: p.label }),
          h('span', { class: 'rh-card-sub', id: `rh-card-sub-${p.id}`, text: '—' }),
        ),
        h('span', { class: 'rh-card-arrow', text: '›' }),
      );
      cards[p.id] = card;
      return card;
    }),
  );

  const pageHome = h('section', { class: 'rh-page', id: 'rh-page-home' },
    h('div', { class: 'rh-overview' }, hero, sub, stats),
    h('div', { class: 'rh-cards-wrap' },
      h('div', { class: 'rh-cards-label', text: '页面' }),
      cardsGrid,
    ),
  );

  // 邀请 (v1.3.0): the免密钥 path (?room=CODE deep link), the online roster with one-tap
  // room.invite pushes, and the banner for an incoming room.invited.
  const pageInvite = buildPage('invite', '邀请', [
    h('div', { class: 'rh-invite', id: 'rh-invite' },
      h('div', { class: 'rh-invite-head', id: 'rh-invite-head' }),
      h('div', { class: 'rh-invite-list', id: 'rh-invite-list' }),
    ),
  ]);

  const pageMatch = buildPage('match', '本局', [
    grid('rh-match-grid'),
  ]);

  const pageServer = buildPage('server', '服务', [
    grid('rh-server-grid'),
  ]);

  const pagePerf = buildPage('perf', '性能', [
    grid('rh-perf-grid'),
  ]);

  const secSettings = buildPage('settings', '设置', [
    h('div', { class: 'rh-set' },
      sliderRow('rh-width-slider', '面板宽度', WIDTH_MIN, WIDTH_MAX, 10, state.cfg.width, (v) => {
        applyWidth(v);
        saveConfig();
      }),
      sliderRow('rh-opacity-slider', '不透明度', 0.35, 1, 0.01, state.cfg.opacity, (v) => {
        state.cfg.opacity = v;
        root.style.setProperty('--rh-opacity', String(v));
        saveConfig();
      }),
      sliderRow('rh-idle-slider', '淡出时', 0.1, 0.8, 0.01, state.cfg.idleOpacity, (v) => {
        state.cfg.idleOpacity = v;
        root.style.setProperty('--rh-idle-opacity', String(v));
        saveConfig();
      }),
      sliderRow('rh-damage-font-slider', '伤害文字', 0.8, 1.5, 0.05, state.cfg.damageWindow.fontScale, (v) => {
        state.cfg.damageWindow.fontScale = v;
        for (const host of damageHosts()) host.style.setProperty('--rh-damage-scale', String(v));
        saveConfig();
      }),
      h('div', { class: 'rh-set-caption', text: '首页显示这些页面' }),
      h('div', { class: 'rh-set-toggles', id: 'rh-set-toggles' }),
      h('button', {
        class: 'rh-reset', text: '恢复默认位置与外观',
        onclick: () => {
          localStorage.removeItem(STORAGE_KEY);
          Object.assign(state.cfg, {
            ...DEFAULTS,
            show: { ...DEFAULTS.show },
            damageWindow: {
              ...DEFAULTS.damageWindow,
              popped: { ...DEFAULTS.damageWindow.popped },
              windows: { ...DEFAULTS.damageWindow.windows },
            },
            folded: {},
            logExpanded: [],
          });
          resetDamageLayout();
          applyConfigToDom();
          setPage('home');
          for (const host of damageHosts()) host.style.setProperty('--rh-damage-scale', String(DEFAULTS.damageWindow.fontScale));
          placeInitial();
          scheduleRender('all');
        },
      }),
    ),
  ]);

  const secAbout = buildPage('about', '关于', [
    h('div', { class: 'rh-about' },
      h('div', { class: 'rh-about-head' },
        h('div', { class: 'rh-about-avatar', text: AUTHOR.name.slice(0, 1).toUpperCase() }),
        h('div', {},
          h('div', { class: 'rh-about-name', text: AUTHOR.name }),
          h('div', { class: 'rh-about-role', text: `R HUD v${MOD_VERSION} · 作者 / Author` }),
        ),
      ),
      h('dl', { class: 'rh-about-meta' },
        h('dt', { text: '网名' }), h('dd', { text: AUTHOR.name }),
        h('dt', { text: 'GitHub' }), h('dd', {}, h('a', { class: 'rh-link', href: AUTHOR.repo, target: '_blank', rel: 'noopener noreferrer', title: AUTHOR.repo, text: AUTHOR.repoLabel })),
        h('dt', { text: '博客' }), h('dd', {}, h('a', { class: 'rh-link', href: AUTHOR.blog, target: '_blank', rel: 'noopener noreferrer', text: AUTHOR.blogLabel })),
        h('dt', { text: '许可' }), h('dd', { text: 'GPL-3.0-or-later（运行时加载，不含游戏代码与素材）' }),
        h('dt', { text: '版本' }), h('dd', { text: MOD_VERSION }),
      ),
      h('p', { class: 'rh-about-note', text: '非官方玩家自制工具，与 Hypergryph / Yostar 及本项目作者无关联。《明日方舟》相关素材版权归原权利人所有。' }),
    ),
  ]);

  const secLog = buildPage('log', '日志', [
    h('div', { class: 'rh-filters' },
      ...['all', 'warn', 'state'].map((f) => h('button', {
        class: 'rh-chip', 'data-filter': f,
        text: { all: '全部', warn: '异常', state: '状态' }[f],
        onclick: () => {
          state.cfg.logFilter = f;
          saveConfig();
          syncChips();
          scheduleRender('log');
        },
      })),
      h('button', {
        class: 'rh-mini rh-warn-badge', id: 'rh-warn-badge', title: '只看异常',
        onclick: () => {
          state.cfg.logFilter = 'warn';
          saveConfig();
          syncChips();
          scheduleRender('log');
        },
      }, '0'),
      h('button', {
        class: 'rh-mini', id: 'rh-log-expand', title: '展开 / 收起全部详情',
        onclick: () => {
          const anyClosed = state.logs.some((l) => l.detail && !state.cfg.logExpanded.includes(l.id));
          state.cfg.logExpanded = anyClosed ? state.logs.filter((l) => l.detail).map((l) => l.id) : [];
          saveConfig();
          scheduleRender('log');
        },
      }, '展开'),
      h('button', {
        class: 'rh-mini', id: 'rh-log-copy', title: '复制全部日志', text: '复制',
        onclick: (ev) => {
          copyLog().then((ok) => {
            ev.currentTarget.textContent = ok ? '已复制' : '失败';
            setTimeout(() => { ev.currentTarget.textContent = '复制'; }, 1400);
          });
        },
      }),
      h('button', {
        class: 'rh-mini', title: '清空日志', text: '清空',
        onclick: () => {
          state.logs.length = 0; warnCount = 0; state.cfg.logExpanded = [];
          syncWarnBadge(); saveConfig(); scheduleRender('log');
        },
      }),
    ),
    h('div', { class: 'rh-log', id: 'rh-log' }),
  ]);

  // ---- footer ---------------------------------------------------------------------------------
  const footer = h('div', { class: 'rh-foot' },
    h('div', { class: 'rh-foot-row' },
      h('span', { class: 'rh-foot-label', text: 'mod by' }),
      h('span', { class: 'rh-author-name', text: AUTHOR.name }),
      h('span', { class: 'rh-foot-sep', text: '·' }),
      h('a', { class: 'rh-link rh-icon-link', href: AUTHOR.repo, target: '_blank', rel: 'noopener noreferrer', title: 'GitHub 仓库', 'aria-label': 'GitHub 仓库' }, svgIcon(ICON_GITHUB)),
      h('a', { class: 'rh-link rh-icon-link', href: AUTHOR.blog, target: '_blank', rel: 'noopener noreferrer', title: `博客 ${AUTHOR.blogLabel}`, 'aria-label': `博客 ${AUTHOR.blogLabel}` }, svgIcon(ICON_BLOG)),
    ),
    h('div', { class: 'rh-foot-note', text: `R HUD v${MOD_VERSION} · GPL-3.0-or-later · 非官方玩家自制工具` }),
  );

  const grip = h('div', { class: 'rh-grip', id: 'rh-grip', title: '拖动调整宽度' });

  // sits above the pages so an incoming invitation is seen no matter which page is open
  const inviteToast = h('div', { class: 'rh-invite-toast', id: 'rh-invite-toast', hidden: true });

  const pageDamage = buildDamagePage();

  const body = h('div', { class: 'rh-body' },
    inviteToast,
    pageHome, pageInvite, pageMatch, pageDamage, pageServer, pagePerf, secLog, secSettings, secAbout,
  );

  root.append(header, body, footer, grip);

  els = {
    dot: $('#rh-dot', root), ver: $('#rh-ver', root), ping: pingNum, spark, sub, stats, grip, body,
    serverGrid: $('#rh-server-grid', root), matchGrid: $('#rh-match-grid', root),
    inviteHead: $('#rh-invite-head', root), inviteList: $('#rh-invite-list', root),
    inviteToast: $('#rh-invite-toast', root),
    perfGrid: $('#rh-perf-grid', root), logBody: $('#rh-log', root),
    warnBadge: $('#rh-warn-badge', root),
    damagePop: $('#rh-damage-pop', root),
    cards,
    pages: {
      home: pageHome, invite: pageInvite, match: pageMatch, damage: pageDamage, server: pageServer,
      perf: pagePerf, log: secLog, settings: secSettings, about: secAbout,
    },
  };

  // the three damage tables: dock them (their windows come back for whatever the config popped)
  for (const kind of DAMAGE_KINDS) mountDamageView(kind);
  syncDamageTabs();
  syncMenu();
  applyConfigToDom();
  return root;
}

function grid(id) { return h('div', { class: 'rh-grid', id }); }

/**
 * One sub-page: a header bar (back to the home grid + title, plus any page-specific controls)
 * over its own content. Exactly one page is visible at a time — the home page is the overview
 * and the grid of cards that opens them.
 */
function buildPage(id, label, bodyKids, extraHeadKids) {
  const head = h('div', { class: 'rh-page-head' },
    h('button', {
      class: 'rh-back', title: '返回首页', 'aria-label': '返回首页',
      onclick: () => setPage('home'),
    }, '‹ 首页'),
    h('span', { class: 'rh-page-title', text: label }),
    extraHeadKids,
  );
  return h('section', { class: 'rh-page', id: `rh-page-${id}` }, head, ...bodyKids);
}

/**
 * The little line icons on the home cards. Stroked, 16×16, currentColor — the shape spec is a
 * [tag, attrs] list so everything stays plain DOM (no innerHTML).
 */
const CARD_ICONS = {
  invite: [['circle', { cx: '6', cy: '5.4', r: '2.5' }], ['path', { d: 'M1.6 13.6c.5-2.6 2.3-4 4.4-4s3.9 1.4 4.4 4' }], ['path', { d: 'M12.3 5.1v4.2M10.2 7.2h4.2' }]],
  match: [['circle', { cx: '8', cy: '8', r: '5.4' }], ['circle', { cx: '8', cy: '8', r: '1.3' }], ['path', { d: 'M8 .8v2.1M8 13.1v2.1M.8 8h2.1M13.1 8h2.1' }]],
  damage: [['path', { d: 'M8 1.7 9.4 6.6 14.3 8 9.4 9.4 8 14.3 6.6 9.4 1.7 8 6.6 6.6Z' }]],
  server: [['rect', { x: '1.8', y: '2.4', width: '12.4', height: '4.6', rx: '1.3' }], ['rect', { x: '1.8', y: '9', width: '12.4', height: '4.6', rx: '1.3' }], ['path', { d: 'M4.2 4.7h.01M4.2 11.3h.01' }]],
  perf: [['path', { d: 'M2.6 13.4V9.6M6.3 13.4V6.4M10 13.4V8.2M13.7 13.4V3' }]],
  log: [['path', { d: 'M2.8 3.6h10.4M2.8 8h10.4M2.8 12.4h6.6' }]],
  settings: [['path', { d: 'M2.4 4.6h11.2M2.4 11.4h11.2' }], ['circle', { cx: '5.8', cy: '4.6', r: '1.7' }], ['circle', { cx: '10.2', cy: '11.4', r: '1.7' }]],
  about: [['circle', { cx: '8', cy: '8', r: '6.2' }], ['path', { d: 'M8 7.3V11.2' }], ['path', { d: 'M8 4.9h.01' }]],
};

function cardIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of CARD_ICONS[name] || []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

function sliderRow(id, label, min, max, step, value, onInput) {
  const out = h('span', { class: 'rh-set-val', text: String(value) });
  const input = h('input', {
    class: 'rh-range', id, type: 'range', min, max, step, value,
    oninput: (ev) => {
      const v = Number(ev.target.value);
      out.textContent = step < 1 ? v.toFixed(2) : String(v);
      onInput(v);
    },
  });
  return h('label', { class: 'rh-set-row' }, h('span', { class: 'rh-set-label', text: label }), input, out);
}

// ---------------------------------------------------------------------------------------------
// config → DOM
// ---------------------------------------------------------------------------------------------

function applyConfigToDom() {
  root.style.setProperty('--rh-w', `${state.cfg.width}px`);
  // Both opacity knobs live in CSS custom properties on the root, so the specificity of
  // .rh-unpinned never fights the slider: it picks a different variable instead.
  root.style.setProperty('--rh-opacity', String(state.cfg.opacity));
  root.style.setProperty('--rh-idle-opacity', String(state.cfg.idleOpacity));
  root.classList.toggle('is-collapsed', state.cfg.collapsed);
  root.classList.toggle('rh-unpinned', !state.cfg.pinned);
  root.classList.toggle('rh-mini', state.cfg.mini);
  syncMenu();
  applyPages();
  setPage(state.cfg.page, { save: false });
  const w = $('#rh-width-slider', root); if (w) w.value = state.cfg.width;
  const wv = w?.parentElement?.querySelector('.rh-set-val'); if (wv) wv.textContent = String(state.cfg.width);
  const o = $('#rh-opacity-slider', root); if (o) o.value = state.cfg.opacity;
  const ov = o?.parentElement?.querySelector('.rh-set-val'); if (ov) ov.textContent = state.cfg.opacity.toFixed(2);
  const i = $('#rh-idle-slider', root); if (i) i.value = state.cfg.idleOpacity;
  const iv = i?.parentElement?.querySelector('.rh-set-val'); if (iv) iv.textContent = state.cfg.idleOpacity.toFixed(2);
  const df = $('#rh-damage-font-slider', root); if (df) df.value = state.cfg.damageWindow.fontScale;
  const dfv = df?.parentElement?.querySelector('.rh-set-val'); if (dfv) dfv.textContent = `${Number(state.cfg.damageWindow.fontScale).toFixed(2)}x`;
  for (const host of damageHosts()) host.style.setProperty('--rh-damage-scale', String(state.cfg.damageWindow.fontScale));
  syncToggles();
  syncChips();
  syncWarnBadge();
  renderHome();
}

/**
 * Hide the cards and pages switched off in the settings, and leave a page that just got hidden.
 */
function applyPages() {
  for (const p of PAGES) {
    const card = els.cards[p.id];
    if (card) card.hidden = !state.cfg.show[p.id];
  }
  if (state.cfg.page !== 'home' && !state.cfg.show[state.cfg.page]) setPage('home');
  else renderHome();
}

/**
 * Switch pages. The content of the target page is rendered on demand — a log or roster that
 * changed while hidden must not be stale the moment it appears.
 */
function setPage(id, { save = true } = {}) {
  if (!els.pages?.[id] || (id !== 'home' && !state.cfg.show[id])) id = 'home';
  state.cfg.page = id;
  for (const [k, page] of Object.entries(els.pages)) page.classList.toggle('is-active', k === id);
  if (id === 'invite') { renderInvite(); pollPlayers(); }
  else if (id === 'log') scheduleRender('log');
  else if (id === 'server') scheduleRender('server');
  else if (id === 'match') scheduleRender('match');
  else if (id === 'damage') { scheduleRender('damage'); syncDamageTabs(); }
  else if (id === 'perf') scheduleRender('perf');
  if (id === 'home') renderHome();
  if (els.body) els.body.scrollTop = 0;
  if (save) saveConfig();
}

/** The menu's 打开设置: make sure the page exists and open it. */
function openSettingsPage() {
  let changed = false;
  if (!state.cfg.show.settings) { state.cfg.show.settings = true; changed = true; }
  if (changed) { applyPages(); syncToggles(); saveConfig(); }
  setPage('settings');
}

function syncToggles() {
  const box = $('#rh-set-toggles', root);
  if (!box) return;
  box.replaceChildren(...PAGES.map(({ id, label }) => h('button', {
    class: `rh-toggle ${state.cfg.show[id] ? 'is-on' : ''}`,
    text: label,
    title: state.cfg.show[id] ? '点击从首页隐藏' : '点击在首页显示',
    onclick: () => {
      state.cfg.show[id] = !state.cfg.show[id];
      // the settings page cannot hide itself — this panel is the way back in
      if (id === 'settings' && !state.cfg.show.settings) state.cfg.show.settings = true;
      applyPages();
      syncToggles();
      saveConfig();
    },
  })));
}

function syncChips() {
  for (const chip of root.querySelectorAll('.rh-chip[data-filter]')) {
    chip.classList.toggle('is-on', chip.dataset.filter === state.cfg.logFilter);
  }
}

function syncWarnBadge() {
  if (!els.warnBadge) return;
  els.warnBadge.textContent = String(warnCount);
  els.warnBadge.classList.toggle('is-hot', warnCount > 0);
}

function toggleMini() {
  state.cfg.mini = !state.cfg.mini;
  root.classList.toggle('rh-mini', state.cfg.mini);
  saveConfig();
}

// ---------------------------------------------------------------------------------------------
// sparkline
// ---------------------------------------------------------------------------------------------

function buildSparkline() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('class', 'rh-spark');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'rh-spark-area');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('class', 'rh-spark-line');
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('class', 'rh-spark-dot');
  dot.setAttribute('r', '2');
  svg.append(area, line, dot);
  return svg;
}

let lastSparkGrade = -1;
function renderSparkline() {
  const svg = els.spark;
  if (!svg) return;
  const hist = state.pingHistory;
  const line = svg.querySelector('.rh-spark-line');
  const area = svg.querySelector('.rh-spark-area');
  const dot = svg.querySelector('.rh-spark-dot');

  if (hist.length < 2) {
    if (line.getAttribute('points')) {
      line.setAttribute('points', '');
      area.setAttribute('d', '');
      dot.setAttribute('r', '0');
    }
    return;
  }

  // scale to the window's own range so a flat line still reads as a line, not a dot on the floor
  const max = Math.max(...hist, 40);
  const min = Math.min(...hist, 0);
  const span = Math.max(max - min, 20);
  const pad = 2;
  const x = (i) => pad + (i * (SPARK_W - pad * 2)) / (PING_HISTORY - 1);
  const y = (v) => SPARK_H - pad - ((v - min) / span) * (SPARK_H - pad * 2);

  const pts = new Array(hist.length);
  for (let i = 0; i < hist.length; i++) pts[i] = `${x(i).toFixed(1)},${y(hist[i]).toFixed(1)}`;
  line.setAttribute('points', pts.join(' '));
  area.setAttribute('d', `M ${x(0).toFixed(1)},${SPARK_H} L ${pts.join(' L ')} L ${x(hist.length - 1).toFixed(1)},${SPARK_H} Z`);

  const lastX = x(hist.length - 1);
  const lastY = y(hist[hist.length - 1]);
  dot.setAttribute('cx', lastX.toFixed(1));
  dot.setAttribute('cy', lastY.toFixed(1));
  dot.setAttribute('r', '2');

  const grade = pingGrade(state.ping);
  if (grade !== lastSparkGrade) {
    lastSparkGrade = grade;
    const color = ['var(--rh-ok)', 'var(--rh-warn)', 'var(--rh-bad)'][grade];
    line.setAttribute('stroke', color);
    area.setAttribute('fill', color);
    dot.setAttribute('fill', color);
  }
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

const STATUS_TEXT = {
  idle: '未连接', connecting: '连接中', connected: '已连接', handshaking: '握手中',
  online: '在线', reconnecting: '重连中', closed: '已断开',
};

function readNet() {
  const net = globalThis.__SP__?.net;
  if (!net) return;
  state.status = net.status;
  state.attempts = net.attempt ?? 0;
  state.ping = Number.isFinite(net.ping) ? net.ping : null;
  state.clockOffset = net.clockOffset ?? 0;
  state.playerId = net.playerId ?? null;
  const err = net.lastError;
  state.lastError = err ? { code: err.code, text: err.message } : null;
}

function renderStatus() {
  readNet();

  const online = state.status === 'online';
  const connecting = state.status === 'connecting' || state.status === 'handshaking' || state.status === 'reconnecting';
  // 'connected' (socket open, heartbeat alive, no session — the steady state on the title screen)
  // is healthy: the game itself counts it as live (title.js, net.js probes). Grade it down only
  // when a lastError rides along (e.g. a rejected hello — its detail is in the sub line anyway).
  const live = online || (state.status === 'connected' && !state.lastError);
  const grade = live ? 0 : connecting ? 1 : 2;

  els.dot.className = `rh-dot ${GRADE_CLASS[grade]}`;
  els.dot.title = STATUS_TEXT[state.status] || state.status;

  els.ping.textContent = state.ping == null ? '—' : state.ping;
  els.ping.className = `rh-metric-num ${GRADE_CLASS[pingGrade(state.ping)]}`;

  const bits = [STATUS_TEXT[state.status] || state.status];
  if (state.jitter != null) bits.push(`抖动 ${state.jitter}ms`);
  if (state.lossPct > 0) bits.push(`丢包 ${state.lossPct.toFixed(0)}%`);
  if (state.attempts > 0) bits.push(`第 ${state.attempts} 次重连`);
  if (state.clockOffset) bits.push(`时钟偏移 ${state.clockOffset > 0 ? '+' : ''}${state.clockOffset}ms`);
  if (state.lastError) bits.push(`${state.lastError.code}: ${state.lastError.text}`);
  els.sub.textContent = bits.join(' · ');
  els.sub.className = `rh-sub ${live ? 'is-ok' : connecting ? 'is-warn' : 'is-bad'}`;

  renderSparkline();
}

function metric(label, value, cls = '') {
  return h('div', { class: 'rh-metric' },
    h('span', { class: 'rh-metric-label', text: label }),
    h('span', { class: `rh-metric-val ${cls}`.trim(), text: value }),
  );
}

function renderServer() {
  const grid = els.serverGrid;
  const s = state.server;
  if (!s) {
    grid.replaceChildren(metric('服务状态', state.serverError ? '离线' : '连接中…', state.serverError ? 'is-bad' : 'is-warn'));
    els.ver.textContent = '—';
    els.ver.title = '';
    return;
  }
  els.ver.textContent = s.app || '—';
  els.ver.title = s.build ? `build ${s.build}` : '';

  const rows = [
    metric('版本', String(s.app || '?')),
    metric('运行时长', fmtDuration((s.uptimeSec || 0) * 1000)),
    metric('在线玩家', String(s.humans ?? '—'), (s.humans || 0) > 0 ? 'is-ok' : ''),
    metric('AI 队友', String(s.bots ?? '—')),
    metric('房间', String(s.rooms ?? '—')),
    metric('进行中对局', String(s.matches ?? '—')),
    metric('观战', String(s.spectators ?? '—')),
    metric('连接数', String(s.sockets ?? '—')),
  ];
  if (state.healthzMs != null) rows.push(metric('状态延迟', `${state.healthzMs}ms`));
  if (state.serverAge != null) rows.push(metric('上次刷新', `${Math.round(state.serverAge / 1000)}秒前`, state.serverAge > 20000 ? 'is-warn' : ''));
  grid.replaceChildren(...rows);
}

function renderStats() {
  const s = state.server;
  els.stats.replaceChildren(
    metric('在线', String(s?.humans ?? '—'), 'is-ok'),
    metric('房间', String(s?.rooms ?? '—')),
    metric('对局', String(s?.matches ?? '—')),
  );
}

/** Last text written per home card — a tick that changed nothing must not touch the DOM. */
const cardSubCache = {};

function cardSub(id, text) {
  const el = $(`#rh-card-sub-${id}`, root);
  if (el && cardSubCache[id] !== text) {
    cardSubCache[id] = text;
    el.textContent = text;
  }
  const card = els.cards?.[id];
  if (!card) return;
  if (id === 'log') card.classList.toggle('is-warn', warnCount > 0);
  if (id === 'invite') card.classList.toggle('is-glow', state.invites.length > 0);
}

/** The live one-liners on the home cards. */
function renderHome() {
  if (!root || !els.cards) return;
  const s = state.server;
  const room = currentRoom();
  const pub = state.match;

  cardSub('match', room?.code
    ? `${room.code} · ${pub?.phase ? phaseName(pub.phase) : room.mode === 'solo' ? '独立' : '同盟'}`
    : pub?.phase ? phaseName(pub.phase) : '未在房间');

  cardSub('damage', state.damage.round == null
    ? (state.cfg.paused ? '已暂停' : '等待战斗')
    : `本回合 ${formatDamageNumber(operatorDamageRows().reduce((n, rec) => n + rec.current, 0) + state.damage.unattributed.current)}`);

  cardSub('invite', state.invites.length
    ? `${state.invites.length} 条新邀请`
    : room?.code ? `同盟 ${room.code}` : '未在同盟');

  cardSub('server', state.serverError ? '离线' : s ? `v${s.app || '?'} · 在线 ${s.humans ?? '—'}` : '连接中…');

  cardSub('perf', state.fps == null
    ? (state.cfg.paused ? '已暂停' : '采样中…')
    : `${state.fps} FPS${state.cfg.paused ? ' · 已暂停' : ''}`);

  cardSub('log', warnCount ? `${warnCount} 条异常 / 警告` : '无异常');
  cardSub('settings', '宽度 · 透明度 · 页面');
  cardSub('about', `v${MOD_VERSION}`);
}

function phaseName(phase) {
  if (!phase) return '—';
  return PHASE_NAMES[phase] || phase;
}

function renderMatch() {
  const grid = els.matchGrid;
  const room = currentRoom();
  const pub = state.match;
  const st = globalThis.__SP__?.store?.get?.();
  const me = st?.me;

  if (!room && !pub) {
    grid.replaceChildren(metric('状态', '未在房间中'), metric('界面', routeName(state.route)));
    return;
  }

  const rows = [];
  if (room?.code) {
    rows.push(metric('房间码', room.code, 'is-ok'));
    rows.push(metric('模式', room.mode === 'solo' ? '独立' : '同盟'));
  }
  if (room?.difficulty) rows.push(metric('难度', String(room.difficulty)));
  if (room?.seats) {
    const filled = room.seats.filter(Boolean).length;
    const humans = room.seats.filter((x) => x && !x.isBot).length;
    rows.push(metric('席位', `${humans} 人 + ${filled - humans} AI`));
  }
  if (room?.spectators?.length) rows.push(metric('观战人数', String(room.spectators.length)));
  if (me?.playerId && room?.seats) {
    const idx = room.seats.findIndex((x) => x && x.playerId === me.playerId);
    if (idx >= 0) rows.push(metric('你的座位', `${idx + 1} 号`, 'is-ok'));
    else if (room.spectators?.some((x) => x && x.playerId === me.playerId)) rows.push(metric('你的身份', '观战', 'is-warn'));
  }
  if (pub?.phase) rows.push(metric('阶段', phaseName(pub.phase)));
  if (pub?.round != null) rows.push(metric('回合', `${pub.round}${pub.lastRound ? ` / ${pub.lastRound}` : ''}`));
  if (pub?.deadline) {
    const left = pub.deadline - now();
    rows.push(metric('剩余时间', left > 0 ? fmtDuration(left) : '已超时', left > 0 && left < 10000 ? 'is-warn' : ''));
  }
  rows.push(metric('界面', routeName(state.route)));
  grid.replaceChildren(...rows);
}

function routeName(route) {
  return { title: '标题', lobby: '大厅', room: '房间', game: '对局' }[route] || route || '—';
}

// ---------------------------------------------------------------------------------------------
// invite (v1.3.1): 免密钥 link · the online roster · incoming room.invited banners
// ---------------------------------------------------------------------------------------------

/** Rejections that never produce an error frame — every server error is already in the log
 *  through the '*' listener, so the catch handlers below log only these. */
const LOCAL_ONLY_CODES = new Set(['OFFLINE', 'CLOSED', 'TIMEOUT']);

/** The same deep link the room screen copies (js/screens/room.js inviteLink): ?room=CODE. */
function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy to the clipboard. The game is served over plain HTTP, where navigator.clipboard only
 * exists on a secure context — an execCommand textarea covers the rest, like the game's own
 * ui/clipboard.js (this mod may not import game modules).
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  if (globalThis.isSecureContext && globalThis.navigator?.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = h('textarea', { style: 'position:fixed;top:-999px;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** One copy button: write the text, say so on the button and in the log (the text itself on failure). */
function copyInvite(btn, label, text) {
  copyText(text).then((ok) => {
    pushLog(ok ? 'state' : 'warn', ok ? `已复制${label}` : `${label}复制失败，手动复制`, text);
    btn.textContent = ok ? '已复制' : '失败';
    setTimeout(() => { btn.textContent = `复制${label}`; }, 1400);
  });
}

/**
 * The room the client is really in — the game's own store first: store.js keeps `room` (the last
 * `room.state` payload, null outside one) and screens/room.js clears it the moment the player
 * leaves, while the server never tells the leaver anything (room.leave answers a bare `ok`) — the
 * overlay's own mirror alone kept showing a room already left (bug report 2026-10-15).
 * Falls back to the mirror on game builds without a store.
 * @returns {any|null}
 */
function currentRoom() {
  const st = globalThis.__SP__?.store?.get?.();
  const room = st ? st.room : undefined;
  return room === undefined ? state.room : room || null;
}

function renderInvite() {
  renderInviteHead();
  renderInviteList();
  renderInviteToast();
}

/** The免密钥 path: room code + a copyable ?room=CODE link (the game joins it natively). */
function renderInviteHead() {
  const head = els.inviteHead;
  if (!head) return;
  const code = currentRoom()?.code;
  if (!code) {
    head.replaceChildren(h('div', { class: 'rh-invite-hint', text: '未在同盟中 — 创建或加入后，这里给出免密钥邀请链接' }));
    return;
  }
  const link = inviteLink(code);
  head.replaceChildren(
    h('div', { class: 'rh-invite-link' },
      h('span', { class: 'rh-invite-code', id: 'rh-invite-code', text: code }),
      h('span', { class: 'rh-invite-url', text: link }),
    ),
    h('div', { class: 'rh-invite-actions' },
      h('button', {
        class: 'rh-btn', id: 'rh-invite-copy-link', text: '复制邀请链接',
        onclick: (ev) => copyInvite(ev.currentTarget, '邀请链接', link),
      }),
      h('button', {
        class: 'rh-btn rh-btn-ghost', id: 'rh-invite-copy-code', text: '复制密钥',
        onclick: (ev) => copyInvite(ev.currentTarget, '密钥', code),
      }),
    ),
    h('div', { class: 'rh-invite-hint', text: '好友打开链接即自动加入同盟，无需输入密钥' }),
  );
}

/** Who is online right now (GET /api/players), each with a one-tap room.invite. */
function renderInviteList() {
  const list = els.inviteList;
  if (!list) return;
  const hint = (text) => h('div', { class: 'rh-invite-hint', text });
  if (!state.playersSupported) {
    list.replaceChildren(hint('此服务器不支持在线名单（服务端未部署 /api/players）— 仍可复制邀请链接'));
    return;
  }
  if (state.playersError) {
    list.replaceChildren(hint(`在线名单获取失败：${state.playersError}`));
    return;
  }
  if (!state.players) { list.replaceChildren(hint('在线名单加载中…')); return; }
  const others = state.players.filter((p) => p && p.id !== state.playerId);
  if (!others.length) { list.replaceChildren(hint('暂时没有其他玩家在线')); return; }

  // inviting needs a room of one's own, and no match may be running in it (room.join would
  // answer ROOM_STARTED); a target deep in its own match is out of reach the same way
  const mine = currentRoom();
  const myRoom = mine?.code || null;
  const myMatch = !!mine?.inMatch;
  list.replaceChildren(...others.map((p) => {
    const where = p.inMatch ? '对局中' : p.inRoom ? '同盟中' : '大厅';
    const cls = p.inMatch ? 'is-warn' : p.inRoom ? '' : 'is-ok';
    const blocked = !myRoom || myMatch || !!p.inMatch;
    const title = !myRoom ? '先创建或加入同盟'
      : myMatch ? '对局进行中，结束后才能邀请'
        : p.inMatch ? '对方对局进行中' : `邀请 ${p.name}`;
    return h('div', { class: 'rh-player-row' },
      h('span', { class: 'rh-player-name', text: p.name, title: p.name }),
      h('span', { class: `rh-player-state ${cls}`.trim(), text: where }),
      h('button', {
        class: 'rh-btn rh-player-invite', 'data-player': p.id, text: '邀请', title,
        disabled: blocked,
        onclick: (ev) => sendInvite(p, ev.currentTarget),
      }),
    );
  }));
}

/** room.invite { playerId } — the server forwards the room code as S2C room.invited. */
async function sendInvite(p, btn) {
  const net = globalThis.__SP__?.net;
  if (!net || !btn) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await net.request('room.invite', { playerId: p.id });
    btn.textContent = '已邀请';
    const code = currentRoom()?.code;
    pushLog('state', `已向 ${p.name} 发出邀请`, code ? `同盟 ${code}` : '');
  } catch (err) {
    btn.textContent = '失败';
    // a server error frame is already in the log via the '*' listener; only local
    // rejections (offline / timeout) never produced one
    if (LOCAL_ONLY_CODES.has(err?.code)) pushLog('warn', `邀请 ${p.name} 失败`, `${err.code}：${err.message}`);
  }
  setTimeout(() => scheduleRender('invite'), 1600);
}

/** The incoming-invite banner: the newest room.invited, plus a queue count. */
function renderInviteToast() {
  const toast = els.inviteToast;
  if (!toast) return;
  const inv = state.invites[0];
  if (!inv) { toast.hidden = true; toast.replaceChildren(); return; }
  toast.hidden = false;
  toast.replaceChildren(
    h('div', { class: 'rh-invite-toast-row' },
      h('span', { class: 'rh-invite-toast-title', text: '收到同盟邀请' }),
      h('span', { class: 'rh-invite-toast-from', text: inv.name }),
      h('span', { class: 'rh-invite-toast-code', text: inv.code }),
      state.invites.length > 1 ? h('span', { class: 'rh-invite-toast-more', text: `+${state.invites.length - 1}` }) : null,
    ),
    h('div', { class: 'rh-invite-toast-actions' },
      h('button', { class: 'rh-btn rh-btn-primary', id: 'rh-invite-join', text: '立即加入', onclick: () => joinInvite(inv) }),
      h('button', { class: 'rh-btn rh-btn-ghost', id: 'rh-invite-dismiss', text: '忽略', onclick: () => dismissInvite(inv) }),
    ),
  );
}

/**
 * 立即加入: the game's own room.join, exactly as the ?room= deep link does. In another room it
 * switches rooms — the server drops the old seat first (room.join does it) — so only a running
 * match refuses here, with the reason in the log. v1.4.3: the old local refusal for 「在同盟中」
 * blocked the one flow the banner exists for.
 */
function joinInvite(inv) {
  const sp = globalThis.__SP__;
  const net = sp?.net;
  const st = sp?.store?.get?.();
  if (!net) return;
  if (!st?.session?.entered) { pushLog('warn', '请先在游戏里点击「开始」', '进入游戏后才能接受邀请'); return; }
  const mine = currentRoom();
  if (mine && mine.code === inv.code) { pushLog('state', `你已在同盟 ${inv.code} 中`); dismissInvite(inv); return; }
  if (mine?.inMatch) { pushLog('warn', '你对局进行中', `对局结束后才能加入 ${inv.name} 的同盟 ${inv.code}`); return; }
  net.request('room.join', { code: inv.code })
    .then(() => {
      dismissInvite(inv);
      pushLog('state', `已加入同盟 ${inv.code}`, mine ? `已离开原同盟 ${mine.code} · 来自 ${inv.name} 的邀请` : `来自 ${inv.name} 的邀请`);
    })
    .catch((err) => {
      if (LOCAL_ONLY_CODES.has(err?.code)) pushLog('warn', `加入同盟 ${inv.code} 失败`, `${err.code}：${err.message}`);
    })
    .finally(() => scheduleRender('invite'));
}

function dismissInvite(inv) {
  const at = state.invites.indexOf(inv);
  if (at >= 0) state.invites.splice(at, 1);
  scheduleRender('invite');
}

/** An incoming invitation should be reachable: show the invite page (never the panel). */
function revealInviteSection() {
  const cfg = state.cfg;
  let changed = false;
  if (!cfg.show.invite) { cfg.show.invite = true; changed = true; }
  if (cfg.mini) { cfg.mini = false; root.classList.remove('rh-mini'); changed = true; }
  if (changed) { applyPages(); syncToggles(); saveConfig(); }
  setPage('invite');
}

/**
 * GET /api/players — the roster behind the invite list. Polls only while the panel is up and the
 * invite section is on screen; a 404 (a server without the overlay routes) says so once and stops
 * asking, so an un-updated server costs nothing.
 */
async function pollPlayers() {
  if (!state.mounted || state.cfg.paused || document.hidden || !state.cfg.show.invite) return;
  if (!state.playersSupported) return;
  try {
    const res = await fetch('/api/players', { cache: 'no-store' });
    if (res.status === 404) {
      state.playersSupported = false;
      state.players = null;
      pushLog('state', '此服务器不支持在线名单', '服务端未部署 /api/players — 复制邀请链接仍然可用');
      scheduleRender('invite');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.players = Array.isArray(data.players) ? data.players : [];
    state.playersError = null;
  } catch (err) {
    state.playersError = err?.message || String(err);
  }
  scheduleRender('invite');
}

function renderPerf() {
  const grid = els.perfGrid;
  const paused = state.cfg.paused;
  if (state.fps == null) {
    grid.replaceChildren(metric('FPS', paused ? '已暂停' : '采样中…', paused ? 'is-warn' : ''));
    return;
  }
  const grade = state.fps >= 50 ? 'is-ok' : state.fps >= 28 ? 'is-warn' : 'is-bad';
  grid.replaceChildren(
    metric('FPS', String(state.fps), paused ? 'is-warn' : grade),
    metric('帧时间', `${state.frameMs.toFixed(1)}ms`),
    metric('统计帧', String(state.frames)),
  );
}

function renderLog() {
  const box = els.logBody;
  const filter = state.cfg.logFilter;
  const items = state.logs.filter((l) => {
    if (filter === 'warn') return l.level === 'warn' || l.level === 'error';
    if (filter === 'state') return l.level !== 'info';
    return true;
  });
  const tail = items.slice(-LOG_DOM_LIMIT);

  // cheap diff: only rebuild when the visible set actually changed
  if (box.childElementCount !== tail.length
    || !tail.every((l, i) => box.children[i]?.dataset.id === String(l.id))) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.replaceChildren(...tail.map(logRow));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  syncWarnBadge();
}

/**
 * One log row: time · level · summary, with the detail body collapsed into a click-to-open row.
 * Errors and warnings arrive already open, because that is exactly when you open this panel.
 */
function logRow(entry) {
  const expanded = state.cfg.logExpanded.includes(entry.id) || isOpenByDefault(entry);
  const hasBody = !!entry.detail || (entry.lines && entry.lines.length);
  const row = h('div', {
    class: `rh-line is-${entry.level} ${expanded ? 'is-open' : ''} ${hasBody ? 'has-body' : ''}`,
    'data-id': String(entry.id),
  });

  const summary = h('div', {
    class: 'rh-line-head',
    onclick: hasBody ? () => toggleLogEntry(entry.id) : null,
    title: hasBody ? (expanded ? '点击收起详情' : '点击展开详情') : (entry.detail || entry.text),
  },
    h('span', { class: 'rh-line-t', text: clockText(entry.at) }),
    h('span', { class: 'rh-line-tag', text: LOG_TAG[entry.level] || entry.level }),
    h('span', { class: 'rh-line-msg', text: entry.text }),
    hasBody ? h('span', { class: 'rh-caret', text: expanded ? '▾' : '▸' }) : null,
  );
  row.append(summary);

  if (hasBody && expanded) {
    const body = h('div', { class: 'rh-line-body' });
    for (const line of entry.lines || []) {
      body.append(h('div', { class: 'rh-line-kv' },
        h('span', { class: 'rh-line-k', text: line[0] }),
        h('span', { class: 'rh-line-v', text: line[1] }),
      ));
    }
    if (entry.detail) body.append(h('div', { class: 'rh-line-detail', text: entry.detail }));
    row.append(body);
  }
  return row;
}

const LOG_TAG = { info: '信息', state: '状态', warn: '警告', error: '错误' };

function toggleLogEntry(id) {
  const list = state.cfg.logExpanded;
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1); else list.push(id);
  saveConfig();
  scheduleRender('log');
}

async function copyLog() {
  const text = state.logs
    .slice(-LOG_LIMIT)
    .map((l) => {
      const head = `${clockText(l.at)} [${LOG_TAG[l.level] || l.level}] ${l.text}`;
      const kv = (l.lines || []).map(([k, v]) => `    ${k}: ${v}`).join('\n');
      return kv || l.detail ? `${head}\n${kv}${kv && l.detail ? '\n' : ''}${l.detail ? `    ${l.detail}` : ''}` : head;
    })
    .join('\n');
  const banner = `— Reality HUD v${MOD_VERSION} 日志导出 · ${new Date().toLocaleString('zh-CN')} · ${state.logs.length} 条 —`;
  try {
    await navigator.clipboard.writeText(`${banner}\n${text}`);
    return true;
  } catch {
    // clipboard API needs a secure context / permission; fall back to a download
    try {
      const url = URL.createObjectURL(new Blob([`${banner}\n${text}`], { type: 'text/plain' }));
      const a = h('a', { href: url, download: `reality-hud-${Date.now()}.txt` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch { return false; }
  }
}

// ---------------------------------------------------------------------------------------------
// data collection
// ---------------------------------------------------------------------------------------------

async function pollHealthz() {
  const t0 = now();
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.server = await res.json();
    state.serverError = null;
    state.healthzMs = now() - t0;
    state.serverAge = 0;
  } catch (err) {
    state.server = null;
    state.serverError = err.message;
  }
  scheduleRender('server');
}

/** One frame of FPS measurement: a counter, never a layout read. */
function sampleFps(dt) {
  state.frames++;
  state._frames++;
  state._acc += dt;
  // report as soon as we have two frames, then settle into whole seconds
  if (state._acc >= 1000 || (state.fps == null && state._acc >= 250)) {
    state.fps = Math.round((state._frames * 1000) / state._acc);
    state.frameMs = state._acc / state._frames;
    state._frames = 0;
    state._acc = 0;
    scheduleRender('perf');
  }
}

/** Standard deviation of the last N samples — the number that actually predicts stutter. */
function updateJitter() {
  const hist = state.pingHistory.slice(-JITTER_WINDOW);
  if (hist.length < 3) { state.jitter = null; return; }
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
  state.jitter = Math.round(Math.sqrt(variance));
}

function onPing(ms) {
  if (!Number.isFinite(ms)) return;
  state.ping = ms;
  state.pingHistory.push(ms);
  if (state.pingHistory.length > PING_HISTORY) {
    state.pingHistory.splice(0, state.pingHistory.length - PING_HISTORY);
  }
  updateJitter();
  scheduleRender('status');
}

/**
 * Attach to the game's Net instance. Every subscription is passive — the overlay only listens,
 * so it cannot interfere with the game.
 */
function attachNet() {
  const net = globalThis.__SP__?.net;
  if (!net || state._netAttached) return false;
  state._netAttached = true;

  net.on('status', (snap) => {
    const prev = state.status;
    state.status = snap.status;
    state.attempts = snap.attempt || 0;
    if (snap.lastError) state.lastError = { code: snap.lastError.code, text: snap.lastError.text };
    if (prev !== snap.status) {
      const level = snap.status === 'online' ? 'state'
        : snap.status === 'reconnecting' ? 'warn'
          : 'state';
      pushLog(level, `连接状态 → ${STATUS_TEXT[snap.status] || snap.status}`,
        snap.lastError ? `${snap.lastError.code}: ${snap.lastError.text}` : '',
        snap.attempt ? [['重连次数', String(snap.attempt)], ['下次重试', snap.retryAt ? new Date(snap.retryAt).toLocaleTimeString('zh-CN') : '—']] : []);
    }
    scheduleRender('status');
  });

  net.on('ping', onPing);
  net.on('clock', (c) => { state.clockOffset = c.offset || 0; scheduleRender('status'); });
  net.on('helloError', (e) => pushLog('error', '握手被服务器拒绝', e?.message || String(e),
    [['错误码', e?.code || '—']]));

  net.on('*', (msg) => {
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'welcome':
        state.playerId = msg.playerId;
        pushLog('state', '已连接服务器', `playerId ${msg.playerId}${msg.resumed ? '（恢复会话）' : ''}`);
        scheduleRender('invite');
        break;
      case 'room.state': {
        const prev = state.room;
        state.room = msg;
        if (msg.code && msg.code !== prev?.code) resetDamageSession();
        for (const seat of Array.isArray(msg.seats) ? msg.seats : []) if (seat?.playerId) ensureDamagePlayer(seat);
        if (msg.code && msg.code !== prev?.code) {
          pushLog('state', `房间 ${msg.code}`, `${msg.mode === 'solo' ? '独立' : '同盟'} · ${msg.difficulty}`);
        }
        if (msg.inMatch && !state._wasInMatch) pushLog('state', '对局开始');
        if (!msg.inMatch && state._wasInMatch) pushLog('state', '回到房间 / 大厅');
        state._wasInMatch = !!msg.inMatch;
        scheduleRender('match');
        scheduleRender('invite');
        break;
      }
      case 'm.public': {
        const prevPhase = state.match?.phase;
        state.match = msg;
        parseDamageFrame(msg);
        mergePublicPlayerDamage(msg);
        if (msg.phase && msg.phase !== prevPhase) {
          const round = msg.lastRound ? ` · 第 ${msg.round}/${msg.lastRound} 回合` : '';
          pushLog('state', `阶段 → ${phaseName(msg.phase)}`, `${msg.modeId || ''}${round}`);
        }
        scheduleRender('match');
        break;
      }
      case 'm.result':
        parseResultDamage(msg, true);
        state.match = null;
        pushLog('state', '本局结算', summariseResult(msg));
        scheduleRender('match');
        break;
      case 'room.closed':
        state.room = null;
        resetDamageSession();
        pushLog('warn', '房间已关闭', ROOM_CLOSED[msg.reason] || msg.reason || '原因未说明',
          [['reason', msg.reason || '—']]);
        scheduleRender('match');
        scheduleRender('invite');
        break;
      case 'room.invited': {
        // S2C room.invited { from, name, code } — server/lobby.js invite. Vanilla clients have no
        // listener for it; here it becomes a banner with a one-tap join.
        const entry = { from: String(msg.from || ''), name: String(msg.name || '未知玩家'), code: String(msg.code || ''), at: now() };
        const dup = state.invites.some((i) => i.from === entry.from && i.code === entry.code);
        if (dup) state.invites = state.invites.map((i) => (i.from === entry.from && i.code === entry.code ? { ...i, at: entry.at } : i));
        else {
          state.invites.push(entry);
          while (state.invites.length > 5) state.invites.shift();
          pushLog('state', `${entry.name} 邀请你加入同盟 ${entry.code}`, '用横幅上的「立即加入」直接进房');
        }
        revealInviteSection();
        scheduleRender('invite');
        break;
      }
      case 'error': {
        // `detail` is the developer-facing reason; `msg` is only the generic label. Keep both.
        const kv = [];
        if (msg.code) kv.push(['错误码', msg.code]);
        if (msg.rid != null) kv.push(['请求 id', String(msg.rid)]);
        pushLog('error', msg.code ? `${msg.code}：${msg.msg || ''}` : (msg.msg || '服务端错误'),
          msg.detail || (msg.msg && msg.code ? msg.msg : ''), kv);
        break;
      }
      case 'm.private':
        ensureDamagePlayer({ playerId: msg.playerId, name: msg.name });
        // stats.dmgDealt is the match's cumulative damage — a 全局累计 floor (1.7.0: this used to be
        // merged as a per-round value and inflated both columns every round)
        mergeReportedPlayerDamage({ playerId: msg.playerId, name: msg.name }, { total: msg.stats?.dmgDealt }, null, { allowStopped: true });
        updateDamageUnits(msg.board || msg.units || [], 'private', { playerId: msg.playerId });
        parseTeamEffects(msg.effects);
        break;
      case 'm.field':
        parseDamageFrame(msg);
        break;
      case 'b.start':
        parseDamageFrame(msg);
        break;
      case 'b.ev':
        parseDamageFrame(msg);
        break;
      case 'b.result':
        parseResultDamage(msg, true);
        break;
      case 'm.unitStats':
        if (msg.round != null) resetDamageRound(msg.round);
        updateDamageUnits(msg.units || [], 'unitStats', { playerId: state.playerId });
        break;
      default:
        if (STANDALONE.has(msg.t)) pushLog('state', `收到 ${msg.t}`);
    }
  });

  return true;
}

/**
 * Watch the game's own store: when its `room` changes — leaving a room clears it in place and the
 * server never tells the leaver, so no push arrives — repaint 邀请 and 本局 at once instead of
 * waiting for the next roster poll. v1.4.3
 */
function attachStore() {
  const st = globalThis.__SP__?.store;
  if (!st || typeof st.subscribe !== 'function' || state._storeAttached) return;
  state._storeAttached = true;
  try {
    st.subscribe((s, prev) => {
      if (s.room !== prev.room) { scheduleRender('invite'); scheduleRender('match'); }
    });
  } catch {
    state._storeAttached = false;
  }
}

function attachNetWhenReady() {
  if (attachNet()) return;
  if (state._netRetry) return;
  state._netRetry = globalThis.setInterval(() => {
    if (attachNet()) {
      globalThis.clearInterval(state._netRetry);
      state._netRetry = null;
    }
  }, 100);
}

function attachRunner() {
  const runner = globalThis.__SP_RUNNER__;
  if (!runner || typeof runner.on !== 'function' || state._runnerAttached) return false;
  state._runnerAttached = true;
  runner.on('field', (msg) => parseDamageFrame(msg));
  runner.on('ev', (msg) => parseDamageFrame(msg));
  runner.on('result', (msg) => parseResultDamage(msg, true));
  runner.on('state', (snap) => {
    if (!snap || snap.done) setDamageLifecycle({ active: false, paused: false, phase: null });
    else setDamageLifecycle({ active: true, paused: !!snap.paused, phase: state.damage.phase || 'RUNNER' });
  });
  return true;
}

function attachRunnerWhenReady() {
  if (attachRunner()) return;
  if (state._runnerRetry) return;
  state._runnerRetry = globalThis.setInterval(() => {
    if (attachRunner()) {
      globalThis.clearInterval(state._runnerRetry);
      state._runnerRetry = null;
    }
  }, 100);
}

function attachDataWhenReady() {
  const data = globalThis.__SP__?.data;
  if (!data || typeof data.lookup !== 'function') {
    if (!state._dataRetry) state._dataRetry = globalThis.setInterval(attachDataWhenReady, 100);
    return;
  }
  if (state._dataRetry) {
    globalThis.clearInterval(state._dataRetry);
    state._dataRetry = null;
  }
  refreshDamageNames();
  // Loading effects is harmless when the game has already cached it, and makes
  // the localized labels available as soon as a battle starts.
  data.load?.('effects')?.catch?.(() => {});
  data.load?.('enemies')?.catch?.(() => {});
  data.load?.('chess')?.catch?.(() => {});
  data.load?.('tokens')?.catch?.(() => {});
  if (state._dataAttached || typeof data.subscribe !== 'function') return;
  state._dataAttached = true;
  data.subscribe((name) => {
    if (name === 'chess' || name === 'tokens' || name === 'effects' || name === 'enemies') refreshDamageNames();
  });
}

function summariseResult(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(msg.result || {})) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') bits.push(`${k}=${v}`);
  }
  return bits.slice(0, 6).join(' ');
}

/** room.closed reasons, so the log says what happened rather than showing a bare slug. */
const ROOM_CLOSED = {
  shutdown: '服务器正在关闭',
  replaced: '同一账号在别处登录，本会话被顶替',
  kicked: '被房主移出房间',
  ended: '对局已结束',
  expired: '对局超时结束',
};

// ---------------------------------------------------------------------------------------------
// timers & the frame loop
// ---------------------------------------------------------------------------------------------

let statusTimer = null;
let healthzTimer = null;
let healthzAgeTimer = null;
let playersTimer = null;
let rafId = null;
/** Must be performance.now(), not Date.now(): the rAF timestamp uses the performance timeline,
 *  so subtracting an epoch millisecond value yields a huge negative dt and FPS never settles. */
let lastFrameAt = 0;

function startLoops() {
  if (rafId == null) {
    lastFrameAt = performance.now();
    const loop = (t) => {
      if (!state.mounted) { rafId = null; return; }
      const dt = t - lastFrameAt;
      lastFrameAt = t;
      // a backgrounded tab resumes with one enormous dt; ignore it rather than report 0 fps
      if (dt >= 0 && dt < 1000) sampleFps(dt);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  if (!statusTimer) {
    statusTimer = setInterval(() => {
      if (document.hidden) return;                 // no work while the tab is in the background
      attachNet();
      attachStore();
      const st = globalThis.__SP__?.store?.get?.();
      if (st) {
        const r = st.session?.entered ? (st.match?.public?.phase && st.match.public.phase !== 'LOBBY' ? 'game' : st.room ? (st.room.inMatch ? 'game' : 'room') : 'lobby') : 'title';
        if (r !== state.route) { state.route = r; scheduleRender('match'); }
      }
      // an invitation stands for a minute; past it the banner goes away (the code stays in the log)
      if (state.invites.length) {
        const alive = state.invites.filter((i) => now() - i.at <= INVITE_TTL_MS);
        if (alive.length !== state.invites.length) { state.invites = alive; scheduleRender('invite'); }
      }
      if (state.serverAge != null) {
        state.serverAge += 1000;
        scheduleRender('server');
      }
      scheduleRender('status');
      scheduleRender('damage');
    }, 1000);
  }
  if (!healthzTimer) healthzTimer = setInterval(() => { if (!document.hidden) pollHealthz(); }, HEALTHZ_INTERVAL);
  if (!healthzAgeTimer) healthzAgeTimer = setInterval(() => {
    if (document.hidden || state.cfg.paused) return;
    if (state.serverAge == null) return;
    state.serverAge += HEALTHZ_INTERVAL;
    scheduleRender('server');
  }, HEALTHZ_INTERVAL);
  // the roster runs at half the healthz cadence and only while the invite section is on screen
  // (pollPlayers itself gates on hidden / paused / show.invite)
  if (!playersTimer) playersTimer = setInterval(() => { pollPlayers(); }, PLAYERS_INTERVAL);
}

function stopTimers() {
  clearInterval(statusTimer); clearInterval(healthzTimer); clearInterval(healthzAgeTimer); clearInterval(playersTimer);
  statusTimer = healthzTimer = healthzAgeTimer = playersTimer = null;
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
}

/** Pausing stops everything; hiding only stops the frame loop but keeps healthz warm. */
function applyTimers() {
  if (state.cfg.paused) {
    stopTimers();
    state.fps = null; state.frameMs = null; state.jitter = null; state.lossPct = 0;
  } else if (state.mounted) {
    startLoops();
  }
}

// ---------------------------------------------------------------------------------------------
// positioning: drag to move, grip to resize
// ---------------------------------------------------------------------------------------------

function placeInitial() {
  const { cfg } = state;
  const rect = root.getBoundingClientRect();
  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;
  const x = cfg.x == null ? Math.max(12, vw - rect.width - 16) : cfg.x;
  const y = cfg.y == null ? 16 : cfg.y;
  root.style.left = `${clamp(x, 8, Math.max(8, vw - rect.width - 8))}px`;
  // clamp against the panel's real height: a short viewport (phone rotated to landscape) must
  // keep the whole panel reachable, not just an assumed 80px stub
  root.style.top = `${clamp(y, 8, Math.max(8, vh - rect.height - 8))}px`;
}

/**
 * Set the panel width and keep it on screen.
 *
 * The panel is normally parked against the right edge, so simply widening it would push the
 * right edge (and the resize grip, and part of the content) past the viewport. Anchor the right
 * edge when we were near it, and clamp either way so the grip is always reachable.
 */
function applyWidth(w, anchorRight = true) {
  const vw = globalThis.innerWidth;
  const current = root.offsetWidth;
  const viewportMax = Math.max(WIDTH_MIN, vw - 16);
  const positionMax = !anchorRight && state.mounted
    ? Math.max(WIDTH_MIN, vw - root.offsetLeft - 8)
    : viewportMax;
  const next = clamp(Math.round(w), WIDTH_MIN, Math.min(WIDTH_MAX, positionMax));
  root.style.setProperty('--rh-w', `${next}px`);
  state.cfg.width = next;

  if (anchorRight && state.mounted) {
    const wasNearRightEdge = root.offsetLeft + current >= vw - 40;
    if (wasNearRightEdge) root.style.left = `${root.offsetLeft - (next - current)}px`;
    const maxLeft = Math.max(8, vw - next - 8);
    root.style.left = `${clamp(root.offsetLeft, 8, maxLeft)}px`;
  }

  const slider = $('#rh-width-slider', root);
  if (slider) slider.value = next;
  const out = slider?.parentElement?.querySelector('.rh-set-val');
  if (out) out.textContent = String(next);
}

function enableDrag() {
  const head = $('.rh-head', root);
  let dragging = false;
  let sx = 0, sy = 0, sl = 0, st = 0;

  head.addEventListener('pointerdown', (ev) => {
    // the menu is inside the header: a press on a menu row (or the menu box) is never a drag —
    // starting one captures the pointer on the header and retargets the click away from the row
    if (ev.target.closest('.rh-ibtn') || ev.target.closest('a') || ev.target.closest('.rh-menu')) return;
    if (ev.button != null && ev.button !== 0) return;
    dragging = true;
    sx = ev.clientX; sy = ev.clientY;
    sl = root.offsetLeft; st = root.offsetTop;
    root.classList.add('is-dragging');
    head.setPointerCapture?.(ev.pointerId);
    // touch: `touch-action: none` already blocks scrolling, and per spec cancelling pointerdown
    // suppresses the compat click of that same tap — nothing here needs it on a touch pointer
    if (ev.pointerType !== 'touch') ev.preventDefault();
  });

  head.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const vw = globalThis.innerWidth, vh = globalThis.innerHeight;
    root.style.left = `${clamp(sl + (ev.clientX - sx), 8, Math.max(8, vw - root.offsetWidth - 8))}px`;
    root.style.top = `${clamp(st + (ev.clientY - sy), 8, Math.max(8, vh - root.offsetHeight - 8))}px`;
  });

  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('is-dragging');
    head.releasePointerCapture?.(ev.pointerId);
    state.cfg.x = root.offsetLeft;
    state.cfg.y = root.offsetTop;
    saveConfig();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);

  // Resize grip (bottom-right corner). Pointer capture on the grip means `pointermove` fires on
  // it even once the cursor leaves the 16px target, so the drag survives leaving the corner.
  let resizing = false;
  let startW = 0, startX = 0;
  els.grip.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    resizing = true;
    startW = root.offsetWidth;
    startX = ev.clientX;
    try { els.grip.setPointerCapture(ev.pointerId); } catch { /* synthetic event */ }
    root.classList.add('is-resizing');
    ev.preventDefault();
    ev.stopPropagation();
  });
  els.grip.addEventListener('pointermove', (ev) => {
    if (!resizing) return;
    // The grip is on the right edge, so keep the left edge fixed while the pointer changes width.
    // Anchoring the right edge here made the panel appear to jump left and right while dragging.
    applyWidth(startW + (ev.clientX - startX), false);
  });
  const endResize = (ev) => {
    if (!resizing) return;
    resizing = false;
    root.classList.remove('is-resizing');
    try { els.grip.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    saveConfig();
  };
  els.grip.addEventListener('pointerup', endResize);
  els.grip.addEventListener('pointercancel', endResize);
  // safety net: a pointerup that lands outside the window would otherwise leave us stuck resizing
  globalThis.addEventListener('pointerup', endResize);

  // keep it on screen when the viewport changes (height-aware: rotating to landscape shrinks
  // the viewport under a panel that may be hundreds of pixels tall)
  globalThis.addEventListener('resize', () => {
    const vw = globalThis.innerWidth, vh = globalThis.innerHeight;
    const maxLeft = Math.max(8, vw - root.offsetWidth - 8);
    root.style.left = `${clamp(root.offsetLeft, 8, maxLeft)}px`;
    root.style.top = `${clamp(root.offsetTop, 8, Math.max(8, vh - root.offsetHeight - 8))}px`;
    for (const kind of DAMAGE_KINDS) if (damageView[kind]?.window?.isConnected) placeDamageWindow(kind);
    placeRecall();
  });
}

// ---------------------------------------------------------------------------------------------
// show / hide
// ---------------------------------------------------------------------------------------------

/**
 * A tiny recall pill, the pointer-first way back.
 *
 * `hideOverlay()` removes the panel from the DOM, and the only other way back (Shift+H) needs a
 * keyboard — on a phone a hidden HUD was unreachable until a page reload. The pill appears where
 * the HUD was last parked, can be dragged out of the way, and restores the panel on tap. It is a
 * sibling of `.rh-root`, so it carries its own positioning and the same design tokens inline.
 */
let recallEl = null;

function buildRecall() {
  return h('button', {
    class: 'rh-recall', id: 'rh-recall', type: 'button',
    title: '唤回 R HUD（Shift+H）', 'aria-label': '唤回 R HUD',
    onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showOverlay(); } },
  }, 'R');
}

function showRecall() {
  if (!recallEl) recallEl = buildRecall();
  if (!recallEl.isConnected) document.body.append(recallEl);
  recallEl.hidden = false;
  placeRecall();
  if (!state._recallDrag) { enableRecallDrag(); state._recallDrag = true; }
}

function hideRecall() {
  if (recallEl) recallEl.hidden = true;
}

function placeRecall() {
  if (!recallEl) return;
  const { cfg } = state;
  const vw = globalThis.innerWidth, vh = globalThis.innerHeight;
  const w = recallEl.offsetWidth || 36, ph = recallEl.offsetHeight || 36;
  const x = cfg.rx == null ? Math.max(12, vw - w - 16) : cfg.rx;
  const y = cfg.ry == null ? Math.max(12, vh - ph - 20) : cfg.ry;
  recallEl.style.left = `${clamp(x, 8, Math.max(8, vw - w - 8))}px`;
  recallEl.style.top = `${clamp(y, 8, Math.max(8, vh - ph - 8))}px`;
}

/** Drag to move; a drag that never left the pill counts as a tap (pointer capture eats clicks). */
function enableRecallDrag() {
  let dragging = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0;

  recallEl.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    dragging = true; moved = false;
    sx = ev.clientX; sy = ev.clientY;
    sl = recallEl.offsetLeft; st = recallEl.offsetTop;
    recallEl.classList.add('is-dragging');
    recallEl.setPointerCapture?.(ev.pointerId);
  });
  recallEl.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    const vw = globalThis.innerWidth, vh = globalThis.innerHeight;
    recallEl.style.left = `${clamp(sl + dx, 0, Math.max(0, vw - 40))}px`;
    recallEl.style.top = `${clamp(st + dy, 0, Math.max(0, vh - 40))}px`;
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    recallEl.classList.remove('is-dragging');
    recallEl.releasePointerCapture?.(ev.pointerId);
    if (moved) {
      state.cfg.rx = recallEl.offsetLeft;
      state.cfg.ry = recallEl.offsetTop;
      saveConfig();
    } else {
      showOverlay();
    }
  };
  recallEl.addEventListener('pointerup', end);
  recallEl.addEventListener('pointercancel', end);
}

function showOverlay() {
  if (state.mounted) return;
  hideRecall();
  document.body.append(root);
  state.mounted = true;
  restoreDamageWindows();
  placeInitial();
  if (!state._dragBound) { enableDrag(); state._dragBound = true; }
  scheduleRender('all');
  // the rAF queue needs one explicit kick: scheduleRender bails while paused
  requestAnimationFrame(() => { for (const k of ['status', 'spark', 'server', 'match', 'invite', 'perf', 'log', 'damage', 'home']) renderOnce(k); });
  attachNetWhenReady();
  attachStore();
  attachRunnerWhenReady();
  attachDataWhenReady();
  pollHealthz();
  pollPlayers();
  applyTimers();
  if (!state._watching) { watchClientErrors(); state._watching = true; }
  pushLog('state', 'HUD 已加载', `v${MOD_VERSION} · Reality`);
}

function renderOnce(what) {
  if (what === 'status') { renderStatus(); renderSparkline(); }
  else if (what === 'server') { renderServer(); renderStats(); renderHome(); }
  else if (what === 'match') { renderMatch(); renderHome(); }
  else if (what === 'invite') { renderInvite(); renderHome(); }
  else if (what === 'perf') { renderPerf(); renderHome(); }
  else if (what === 'log') { renderLog(); renderHome(); }
  else if (what === 'home') renderHome();
  else if (what === 'damage') renderDamage();
}

function hideOverlay() {
  if (!state.mounted) return;
  root.remove();
  hideDamageWindows();
  state.mounted = false;
  if (state._netRetry) {
    globalThis.clearInterval(state._netRetry);
    state._netRetry = null;
  }
  if (state._runnerRetry) {
    globalThis.clearInterval(state._runnerRetry);
    state._runnerRetry = null;
  }
  if (state._dataRetry) {
    globalThis.clearInterval(state._dataRetry);
    state._dataRetry = null;
  }
  stopTimers();
  showRecall();
}

function toggleOverlay() {
  if (state.mounted) hideOverlay(); else showOverlay();
}

// don't poll while the tab is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTimers();
  else if (state.mounted) applyTimers();
});

/**
 * Client-side failures. The game's own error handling is silent, so if the page throws while the
 * overlay is open there is nothing on screen explaining why — which is the moment you most want
 * to know. Captured passively; nothing is swallowed or prevented.
 */
function watchClientErrors() {
  addEventListener('error', (ev) => {
    pushLog('error', '页面脚本异常', ev.message || String(ev.error || ''),
      [
        ['来源', ev.filename ? `${ev.filename.split('/').pop()}:${ev.lineno}:${ev.colno}` : '—'],
        ['类型', ev.error?.name || 'Error'],
      ]);
  });
  addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    pushLog('error', '未处理的 Promise 拒绝',
      r?.message || String(r),
      [['类型', r?.name || (typeof r)]]);
  });
}

// Shift+H anywhere: bring it back after closing (desktop shortcut; on touch there is the recall pill)
document.addEventListener('keydown', (ev) => {
  if (ev.shiftKey && (ev.key === 'H' || ev.key === 'h')) {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    ev.preventDefault();
    toggleOverlay();
  }
}, true);

// ---------------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------------

root = buildUi();
showOverlay();

/** Exposed for other mods / debugging. */
globalThis.__REALITY_HUD__ = {
  state, show: showOverlay, hide: hideOverlay, toggle: toggleOverlay,
  version: MOD_VERSION,
  author: AUTHOR.name,
  authorDetail: AUTHOR,
  links: { github: AUTHOR.github, blog: AUTHOR.blog, repo: AUTHOR.repo },
  config: state.cfg,
  save: saveConfig,
  reset: () => { localStorage.removeItem(STORAGE_KEY); location.reload(); },
};
