// Reads Antigravity quota from the local language server and turns it into
// a small, display-ready shape. Pure helpers are exported for tests.

import http from 'node:http';
import https from 'node:https';

const SVC = '/exa.language_server_pb.LanguageServerService/';

// POST a Connect-JSON RPC to the language server. `addr` is "host:port".
// The sidecar address is the hub's plain-http port; https is tried as a fallback
// because the hub also serves a self-signed https port.
export function rpc(addr, csrf, method, payload = {}, timeoutMs = 8000) {
  const body = JSON.stringify(payload);
  const attempt = (mod, scheme) => new Promise((resolve, reject) => {
    const [host, port] = addr.replace(/^https?:\/\//, '').split(':');
    const req = mod.request({
      host: host === 'localhost' ? '127.0.0.1' : host, port: Number(port), method: 'POST',
      path: SVC + method,
      headers: {
        'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrf, 'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false, // localhost self-signed certificate
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(new Error('too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${scheme} ${method} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`${method}: bad JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(body);
  });
  return attempt(http, 'http').catch((e) => {
    if (/HTTP 4\d\d/.test(e.message)) throw e; // reached the server: https will not help
    return attempt(https, 'https');
  });
}

export function isoToEpoch(s) {
  if (typeof s !== 'string') return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// Fraction used, 0..1. The server omits remainingFraction when it reaches 0.
export function usedFraction(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 1;
  return 1 - Math.max(0, Math.min(1, remaining));
}

// Whole percent for small screens: any use at all shows as at least 1 %.
export function wholePct(used) {
  const p = used * 100;
  return p <= 0 ? 0 : Math.max(1, Math.min(100, Math.round(p)));
}

function poolKey(bucketIds, name) {
  const ids = bucketIds.join(' ').toLowerCase();
  const n = name.toLowerCase();
  if (ids.includes('gemini') || n.startsWith('gemini')) return 'G';
  if (ids.startsWith('3p') || n.includes('claude')) return 'C';
  return (name[0] || '?').toUpperCase();
}

function windowSlot(b) {
  const w = String(b.window || b.bucketId || '').toLowerCase();
  if (w.includes('5h') || w.includes('hour')) return 's';
  if (w.includes('week')) return 'w';
  return null;
}

// RetrieveUserQuotaSummary → [{ key, name, models[], s:{used,reset}, w:{used,reset} }]
export function fromQuotaSummary(raw) {
  const resp = raw?.response || raw || {};
  const pools = [];
  for (const grp of resp.groups || []) {
    const name = String(grp.displayName || '');
    const buckets = Array.isArray(grp.buckets) ? grp.buckets : [];
    const desc = String(grp.description || '');
    const models = desc.includes(':') ? desc.split(':').slice(1).join(':').split(',').map((s) => s.trim()).filter(Boolean) : [];
    const pool = { key: poolKey(buckets.map((b) => String(b.bucketId || '')), name), name, models };
    for (const b of buckets) {
      const slot = windowSlot(b);
      if (slot) pool[slot] = { used: usedFraction(b.remainingFraction), reset: isoToEpoch(b.resetTime) };
    }
    pools.push(pool);
  }
  if (!pools.length) throw new Error('RetrieveUserQuotaSummary: no groups');
  return pools;
}

// GetUserStatus fallback: one fraction per model, no 5h/weekly split.
// Folded into the same two pools; the value goes into the 5h slot.
export function fromUserStatus(raw) {
  const configs = raw?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const pools = new Map();
  for (const c of configs) {
    const label = String(c?.label || '');
    if (!label) continue;
    const key = /^(Gemini|Orchestrator)/.test(label) ? 'G' : 'C';
    const q = c.quotaInfo && typeof c.quotaInfo === 'object' ? c.quotaInfo : null;
    const cur = { used: q ? usedFraction(q.remainingFraction) : 1, reset: q ? isoToEpoch(q.resetTime) : 0 };
    const p = pools.get(key) || { key, name: key === 'G' ? 'Gemini Models' : 'Claude and GPT models', models: [] };
    p.models.push(label);
    if (!p.s || cur.used > p.s.used) p.s = cur;
    pools.set(key, p);
  }
  return ['G', 'C'].filter((k) => pools.has(k)).map((k) => pools.get(k));
}

export function planName(raw) {
  return raw?.userStatus?.planStatus?.planInfo?.planName || null;
}

// A window whose reset time has passed is full again until the next read.
export function effective(win, nowSec) {
  if (!win) return null;
  if (win.reset && win.reset <= nowSec) return { used: 0, reset: 0 };
  return win;
}

// Compact shape pushed to the clock: [{k, s:[pct, reset], w:[pct, reset]}]
export function compact(pools) {
  return pools.map((p) => {
    const e = { k: p.key };
    for (const slot of ['s', 'w']) if (p[slot]) e[slot] = [wholePct(p[slot].used), p[slot].reset || 0];
    return e;
  });
}

// Usage pace from history samples [{t, v}] (v = used fraction) inside the current window.
// Returns { perHour, emptyAt } or null when there is not enough movement to say anything.
export function pace(samples, win, nowSec, windowSec) {
  if (!win || !win.reset || win.used <= 0 || win.used >= 1) return null;
  const start = win.reset - windowSec;
  const recent = samples.filter((s) => s.t >= Math.max(start, nowSec - 3600));
  if (recent.length < 2) return null;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = (b.t - a.t) / 3600;
  const dv = b.v - a.v;
  if (dt < 1 / 6 || dv <= 0) return null; // need ≥10 minutes of rising usage
  const perHour = dv / dt;
  const emptyAt = Math.round(nowSec + ((1 - win.used) / perHour) * 3600);
  return { perHour, emptyAt: emptyAt < win.reset ? emptyAt : null };
}
