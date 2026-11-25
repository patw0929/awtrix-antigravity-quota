// Pushes quota to an AWTRIX clock running the Berry-app firmware (52x16, /api/v1).
// The clock app (antigravity_quota.be) only reads its own data store, so the
// clock never needs to know this computer's address.

import http from 'node:http';

export const HEARTBEAT_MS = 10 * 60 * 1000; // re-send unchanged data this often
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

export function validHost(h) {
  return typeof h === 'string' && HOST_RE.test(h.trim());
}

function request(host, method, path, body, contentType = 'application/json', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.trim().split(':');
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname, port: port ? Number(port) : 80, method, path, timeout: timeoutMs,
      headers: data ? { 'Content-Type': contentType, 'Content-Length': data.length } : {},
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: out });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

const appPath = (app) => `/api/v1/apps/${encodeURIComponent(app)}`;

// Is the clock reachable, and is our app installed on it?
export async function probe(host, app) {
  const r = await request(host, 'GET', '/api/v1/apps');
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`not an AWTRIX /api/v1 device (HTTP ${r.status})`);
  const entry = r.json.find((a) => a && a.name === app);
  return { installed: !!entry, error: entry?.error || null, version: entry?.meta?.version || null };
}

// Install or update the clock app. Settings already on the clock are kept.
export async function installApp(host, app, source) {
  const r = await request(host, 'PUT', `/api/v1/apps/script/${encodeURIComponent(app)}`, source, 'text/plain', 20000);
  if (r.status !== 200 || r.json?.error) {
    throw new Error(r.json?.error?.message || r.json?.error || `HTTP ${r.status}`);
  }
  return r.json;
}

export async function pushData(host, app, payload) {
  const r = await request(host, 'PATCH', appPath(app) + '/data', payload);
  if (r.status !== 200) throw new Error(r.json?.error?.message || `HTTP ${r.status}`);
  return r.json;
}

// Decides when to push: only when the numbers change, plus a heartbeat so the
// clock can tell fresh data from a closed Antigravity.
export class Pusher {
  constructor() {
    this.lastSig = null;
    this.lastAt = 0;
    this.lastError = null;
    this.lastOkAt = 0;
  }

  due(g, nowMs) {
    const sig = JSON.stringify(g);
    return sig !== this.lastSig || nowMs - this.lastAt >= HEARTBEAT_MS;
  }

  async push(host, app, g, nowMs = Date.now(), force = false) {
    if (!force && !this.due(g, nowMs)) return false;
    try {
      await pushData(host, app, { q: { t: Math.floor(nowMs / 1000), g } });
      this.lastSig = JSON.stringify(g);
      this.lastAt = nowMs;
      this.lastOkAt = nowMs;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastSig = null; // failed writes cost no flash: retry on the next poll
      this.lastError = e.message;
      throw e;
    }
  }
}
