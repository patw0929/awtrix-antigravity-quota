// Shared engine for the panel sidecar (Antigravity desktop app) and the MCP
// server (Antigravity IDE, agy CLI): settings, polling, history, AWTRIX push.
// Several copies may run at once; a lock file elects one writer that records
// history and pushes to the clock, the others only read.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact, effective, fromQuotaSummary, fromUserStatus, pace, planName, rpc } from './quota.mjs';
import { Pusher, installApp, probe, validHost } from './awtrix.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLOCK_APP = join(__dirname, '..', '..', 'clock', 'antigravity_quota.be');
export const DATA_DIR = process.env.QUOTA_MONITOR_DATA ||
  join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'quota-monitor');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const LOCK_FILE = join(DATA_DIR, 'runner.json');
const DAEMON_DIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide']
  .map((p) => join(homedir(), '.gemini', p, 'daemon'));

const WINDOW_SEC = { s: 5 * 3600, w: 7 * 86400 };
const HISTORY_KEEP_SEC = 8 * 86400;
export const DEFAULTS = {
  pollSec: 60,
  warn: 50,
  high: 80,
  show: 'left',
  awtrix: { enabled: false, host: '', app: 'Antigravity-Quota' },
};

mkdirSync(DATA_DIR, { recursive: true });

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}
function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function mtime(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

// Language servers to try. Inside a sidecar the host passes its own address and
// token; elsewhere (MCP under the IDE's agy hub) read the hub daemon files,
// newest live process first.
export function discoverServers() {
  const out = [];
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    out.push({ addr: process.env.ANTIGRAVITY_LS_ADDRESS, csrf: process.env.ANTIGRAVITY_CSRF_TOKEN });
  }
  const found = [];
  for (const dir of DAEMON_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/^hub_\d+\.json$/.test(name)) continue;
      const file = join(dir, name);
      const d = readJson(file, null);
      const port = d?.httpPort || d?.httpsPort;
      if (!d?.csrfToken || !port || !pidAlive(d.pid)) continue;
      found.push({ m: mtime(file), addr: `localhost:${port}`, csrf: d.csrfToken });
    }
  }
  found.sort((a, b) => b.m - a.m);
  for (const f of found) if (!out.some((o) => o.addr === f.addr)) out.push({ addr: f.addr, csrf: f.csrf });
  return out;
}

export class Monitor {
  constructor(role) {
    this.role = role; // 'panel' or 'mcp'
    this.state = { ok: false, error: null, at: 0, source: null, plan: null, pools: [] };
    this.pusher = new Pusher();
    this.planAt = 0;
    this.settingsAt = -1;
    this.loadSettings();
    this.history = [];
    this.historyAt = -1;
    this.loadHistory();
  }

  loadSettings() {
    const m = mtime(SETTINGS_FILE);
    if (m === this.settingsAt) return;
    this.settingsAt = m;
    const s = readJson(SETTINGS_FILE, {});
    this.settings = { ...DEFAULTS, ...s, awtrix: { ...DEFAULTS.awtrix, ...(s.awtrix || {}) } };
  }

  loadHistory() {
    const m = mtime(HISTORY_FILE);
    if (m === this.historyAt) return;
    this.historyAt = m;
    const h = readJson(HISTORY_FILE, []);
    this.history = Array.isArray(h) ? h : [];
  }

  // Validate and store a settings change; every running copy picks it up on its next poll.
  saveSettings(d) {
    this.loadSettings();
    const next = { ...this.settings, awtrix: { ...this.settings.awtrix } };
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : null);
    if (d.warn != null && num(d.warn, 1, 99) != null) next.warn = num(d.warn, 1, 99);
    if (d.high != null && num(d.high, 1, 100) != null) next.high = num(d.high, 1, 100);
    if (d.show === 'used' || d.show === 'left') next.show = d.show;
    if (d.awtrix && typeof d.awtrix === 'object') {
      if (typeof d.awtrix.enabled === 'boolean') next.awtrix.enabled = d.awtrix.enabled;
      if (typeof d.awtrix.host === 'string') {
        const h = d.awtrix.host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (h && !validHost(h)) throw new Error('bad host');
        next.awtrix.host = h;
      }
    }
    writeJson(SETTINGS_FILE, next);
    this.settings = next;
    this.settingsAt = mtime(SETTINGS_FILE);
    this.pusher.lastSig = null; // push right away with the new target
    return next;
  }

  // One writer at a time: the lock holder records history and pushes.
  claimWriter(nowMs) {
    const lock = readJson(LOCK_FILE, null);
    const staleMs = Math.max(30, this.settings.pollSec) * 3000;
    const mine = lock?.pid === process.pid;
    if (!mine && lock && pidAlive(lock.pid) && nowMs - (lock.at || 0) < staleMs) return false;
    writeJson(LOCK_FILE, {
      pid: process.pid, role: this.role, at: nowMs,
      pushOkAt: mine ? lock.pushOkAt || 0 : 0, pushError: mine ? lock.pushError || null : null,
    });
    return true;
  }

  noteLock(fields) {
    const lock = readJson(LOCK_FILE, null);
    if (lock?.pid === process.pid) writeJson(LOCK_FILE, { ...lock, ...fields });
  }

  async read() {
    const servers = discoverServers();
    if (!servers.length) throw new Error('Antigravity not running');
    let lastErr;
    for (const { addr, csrf } of servers) {
      try {
        let pools;
        let source;
        try {
          pools = fromQuotaSummary(await rpc(addr, csrf, 'RetrieveUserQuotaSummary', {}));
          source = 'summary';
        } catch {
          const raw = await rpc(addr, csrf, 'GetUserStatus', { metadata: { ideName: 'antigravity' } });
          pools = fromUserStatus(raw);
          source = 'status';
          this.state.plan = planName(raw) || this.state.plan;
          this.planAt = Date.now();
        }
        if (Date.now() - this.planAt > 30 * 60 * 1000) {
          this.planAt = Date.now();
          try {
            this.state.plan = planName(await rpc(addr, csrf, 'GetUserStatus', { metadata: { ideName: 'antigravity' } })) || this.state.plan;
          } catch { /* plan name is optional */ }
        }
        return { pools, source };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  record(pools, nowSec) {
    const sample = { t: nowSec };
    for (const p of pools) sample[p.key] = { s: p.s?.used ?? null, w: p.w?.used ?? null };
    const last = this.history[this.history.length - 1];
    const changed = !last || pools.some((p) => last[p.key]?.s !== sample[p.key].s || last[p.key]?.w !== sample[p.key].w);
    if (changed || nowSec - last.t >= 1800) {
      this.history.push(sample);
      this.history = this.history.filter((h) => h.t >= nowSec - HISTORY_KEEP_SEC);
      writeJson(HISTORY_FILE, this.history);
      this.historyAt = mtime(HISTORY_FILE);
    }
  }

  async poll() {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    this.loadSettings();
    try {
      const { pools, source } = await this.read();
      Object.assign(this.state, { ok: true, error: null, at: nowSec, source, pools });
    } catch (e) {
      Object.assign(this.state, { ok: false, error: e.message });
    }
    const writer = this.claimWriter(now);
    if (!writer) { this.loadHistory(); return; }
    if (!this.state.ok) return;
    this.record(this.state.pools, nowSec);
    const a = this.settings.awtrix;
    if (a.enabled && validHost(a.host)) {
      try {
        if (await this.pusher.push(a.host, a.app, compact(this.state.pools), now)) this.noteLock({ pushOkAt: now, pushError: null });
      } catch (e) {
        this.noteLock({ pushError: e.message });
      }
    }
  }

  start() {
    const tick = () => this.poll().catch(() => {}).finally(() => {
      setTimeout(tick, Math.max(30, this.settings.pollSec) * 1000);
    });
    tick();
  }

  view() {
    this.loadSettings();
    const nowSec = Math.floor(Date.now() / 1000);
    const pools = this.state.pools.map((p) => {
      const out = { key: p.key, name: p.name, models: p.models };
      for (const slot of ['s', 'w']) {
        const win = effective(p[slot], nowSec);
        if (!win) continue;
        const samples = this.history.filter((h) => h[p.key]?.[slot] != null).map((h) => ({ t: h.t, v: h[p.key][slot] }));
        out[slot] = { ...win, pace: pace(samples, win, nowSec, WINDOW_SEC[slot]) };
      }
      out.history = this.history.filter((h) => h[p.key] && h.t >= nowSec - 86400).map((h) => [h.t, h[p.key].s, h[p.key].w]);
      return out;
    });
    const lock = readJson(LOCK_FILE, {}) || {};
    return {
      ok: this.state.ok, error: this.state.error, at: this.state.at, now: nowSec,
      source: this.state.source, plan: this.state.plan, pools, settings: this.settings,
      awtrix: { lastOkAt: Math.floor((lock.pushOkAt || 0) / 1000), lastError: lock.pushError || null, by: lock.role || null },
    };
  }

  async probeClock() {
    const a = this.settings.awtrix;
    if (!validHost(a.host)) return { ok: false, error: 'no host' };
    try { return { ok: true, ...(await probe(a.host, a.app)) }; } catch (e) { return { ok: false, error: e.message }; }
  }

  async installClock() {
    const a = this.settings.awtrix;
    if (!validHost(a.host)) return { ok: false, error: 'no host' };
    try {
      await installApp(a.host, a.app, readFileSync(CLOCK_APP, 'utf8'));
      if (this.state.ok) {
        await this.pusher.push(a.host, a.app, compact(this.state.pools), Date.now(), true);
        this.noteLock({ pushOkAt: Date.now(), pushError: null });
      }
      return { ok: true, ...(await probe(a.host, a.app)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
