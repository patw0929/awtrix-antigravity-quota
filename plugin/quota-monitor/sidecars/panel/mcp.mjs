// Quota Monitor MCP server. The Antigravity IDE (and the agy CLI) run plugin MCP
// servers but not sidecars, so this process keeps the AWTRIX clock updated there
// and lets the agent answer quota questions. Stdio JSON-RPC, no dependencies.
// stdout carries protocol messages only; diagnostics go to stderr.

import { Monitor } from './core.mjs';

const monitor = new Monitor('mcp');
monitor.start();

const SERVER = { name: 'quota-monitor', version: '1.1.0' };

const TOOLS = [
  {
    name: 'quota_status',
    description: 'Current Antigravity quota: for each model pool (Gemini; Claude and GPT) the percent remaining in the 5-hour and weekly windows, time until reset, recent usage pace, and AWTRIX clock push status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'awtrix_configure',
    description: 'Set up the optional AWTRIX clock display (52x16 Berry firmware, e.g. Ulanzi TC002). Saves the clock address, optionally installs or updates the clock app on it, and turns pushing on or off. Only call this when the user asks to set up or change the clock.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Clock IP address or hostname, e.g. 192.168.1.50' },
        install: { type: 'boolean', description: 'Install or update the clock app (keeps its settings on the clock)' },
        push: { type: 'boolean', description: 'Turn pushing quota to the clock on or off' },
      },
      additionalProperties: false,
    },
  },
];

const pct = (v) => `${Math.round(v * 1000) / 10}%`;
function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function statusText() {
  const v = monitor.view();
  if (!v.pools.length) return v.error ? `Quota unavailable: ${v.error}` : 'Quota not read yet; try again in a few seconds.';
  const lines = [];
  if (v.plan) lines.push(`Plan: ${v.plan}`);
  for (const p of v.pools) {
    lines.push(`${p.name}${p.models.length ? ` (shared by ${p.models.join(', ')})` : ''}`);
    for (const [slot, label] of [['s', '5-hour'], ['w', 'Weekly']]) {
      const w = p[slot];
      if (!w) continue;
      let line = `  ${label}: ${pct(1 - w.used)} remaining`;
      if (w.reset && w.used > 0) line += `, resets in ${dur(w.reset - v.now)}`;
      if (w.pace) {
        line += `, last hour about ${pct(w.pace.perHour)}/h`;
        if (w.pace.emptyAt) line += `, runs out in ${dur(w.pace.emptyAt - v.now)} at this pace`;
      }
      lines.push(line);
    }
  }
  if (v.source === 'status') lines.push('(legacy API: single limit per model only)');
  if (!v.ok) lines.push(`Note: last read failed (${v.error}); numbers above may be stale.`);
  const a = v.settings.awtrix;
  if (a.host) {
    lines.push(`AWTRIX clock ${a.host}: push ${a.enabled ? 'on' : 'off'}` +
      (v.awtrix.lastError ? `, last error: ${v.awtrix.lastError}` : v.awtrix.lastOkAt ? `, last push ${dur(v.now - v.awtrix.lastOkAt)} ago` : ''));
  }
  return lines.join('\n');
}

async function configure(args) {
  const out = [];
  const patch = { awtrix: {} };
  if (typeof args.host === 'string') patch.awtrix.host = args.host;
  if (typeof args.push === 'boolean') patch.awtrix.enabled = args.push;
  monitor.saveSettings(patch);
  const host = monitor.settings.awtrix.host;
  if (!host) return 'No clock address set. Pass host, e.g. 192.168.1.50.';
  if (args.install) {
    const r = await monitor.installClock();
    out.push(r.ok ? `Installed clock app ${r.version || ''} on ${host}.` : `Install failed: ${r.error}`);
  } else {
    const r = await monitor.probeClock();
    out.push(!r.ok ? `Clock ${host} not reachable: ${r.error}` : r.installed ? `Clock ${host} has app ${r.version || ''}${r.error ? ` (error: ${r.error})` : ''}.` : `Clock ${host} is reachable but the app is not installed yet (call again with install: true).`);
  }
  await monitor.poll();
  out.push(`Push is ${monitor.settings.awtrix.enabled ? 'on' : 'off'}.`);
  return out.join(' ');
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        if (name === 'quota_status') {
          if (!monitor.state.at) await monitor.poll();
          return reply({ content: [{ type: 'text', text: statusText() }] });
        }
        if (name === 'awtrix_configure') return reply({ content: [{ type: 'text', text: await configure(args) }] });
        return reply({ content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (method?.startsWith('notifications/')) return undefined;
      return fail(-32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg).catch((e) => process.stderr.write(`[quota-monitor] ${e.stack || e}\n`));
  }
});
// The host closing stdin means the session ended
process.stdin.on('end', () => process.exit(0));
