// Quota Monitor side panel (Antigravity desktop app sidecar).
// Polling, history and AWTRIX push live in core.mjs, shared with mcp.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { Monitor } from './core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const monitor = new Monitor('panel');
const app = new SidecarApp();

const asset = (file, type) => () => new Response(readFileSync(join(__dirname, file), 'utf8'), { contentType: type });
app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));
app.api('/panel.js', asset('panel.js', 'application/javascript'), 'GET');
app.api('/panel.css', asset('panel.css', 'text/css'), 'GET');

app.api('/api/state', () => monitor.view(), 'GET');

app.api('/api/refresh', async () => {
  await monitor.poll();
  return monitor.view();
});

app.api('/api/settings', async (d) => {
  try {
    monitor.saveSettings(d);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { contentType: 'application/json', status: 400 });
  }
  await monitor.poll();
  return monitor.view();
});

app.api('/api/awtrix/probe', () => monitor.probeClock());
app.api('/api/awtrix/install', () => monitor.installClock());

await app.run();
monitor.start();
