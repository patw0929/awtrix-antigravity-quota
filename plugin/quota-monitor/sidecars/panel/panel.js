(() => {
  const zh = /^zh/i.test(navigator.language || '');
  const T = zh ? {
    title: 'Antigravity 額度', settings: '設定', show: '顯示', left: '剩餘', used: '已用',
    thresholds: '警告／危險門檻（已用）', host: '時鐘 IP', push: '推送到時鐘', save: '儲存',
    probe: '檢查連線', install: '安裝／更新時鐘 app',
    awtrixHint: '有 AWTRIX（TC002 等 52×16 Berry 韌體）時填入時鐘 IP，按「安裝／更新時鐘 app」後勾選推送。數字有變化才送，另外每 10 分鐘送一次。',
    w5h: '5 小時', w7d: '每週', reset: (d) => `${d}後重置`, full: '尚未使用',
    pace: (r) => `最近一小時約 ${r}%／小時`, empty: (d) => `照這速度 ${d}後用完`,
    updated: (d) => `${d}前更新`, offline: '讀不到 Antigravity', loading: '讀取中…',
    models: '共用：', d: '天', h: '小時', m: '分', s: '秒', last24: '近 24 小時（已用）',
    pushOk: (d) => `最後推送：${d}前`, pushErr: (e) => `推送失敗：${e}`, notInstalled: '時鐘上還沒有這個 app',
    installed: (v) => `時鐘已安裝 app ${v || ''}`, saved: '已儲存', noHost: '請先填時鐘 IP', fallback: '（舊版 API，只有單一額度）',
  } : {
    title: 'Antigravity Quota', settings: 'Settings', show: 'Show', left: 'Remaining', used: 'Used',
    thresholds: 'Warn / high (used)', host: 'Clock IP', push: 'Push to clock', save: 'Save',
    probe: 'Check', install: 'Install / update clock app',
    awtrixHint: 'With an AWTRIX clock (TC002 and other 52×16 Berry firmware), enter its IP, install the clock app, then turn on push. Data is sent when it changes, plus every 10 minutes.',
    w5h: '5-hour', w7d: 'Weekly', reset: (d) => `resets in ${d}`, full: 'not used yet',
    pace: (r) => `last hour ≈ ${r}%/h`, empty: (d) => `runs out in ${d} at this pace`,
    updated: (d) => `updated ${d} ago`, offline: 'Antigravity not reachable', loading: 'Loading…',
    models: 'Shared by: ', d: 'd', h: 'h', m: 'm', s: 's', last24: 'Last 24 h (used)',
    pushOk: (d) => `last push ${d} ago`, pushErr: (e) => `push failed: ${e}`, notInstalled: 'App not on the clock yet',
    installed: (v) => `Clock app ${v || ''} installed`, saved: 'Saved', noHost: 'Enter the clock IP first', fallback: '(legacy API, single limit only)',
  };
  const token = new URLSearchParams(location.search).get('token') || '';
  const $ = (id) => document.getElementById(id);
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = T[el.dataset.t]; });

  let S = null;
  let skew = 0; // server clock minus browser clock, seconds

  const api = async (path, body) => {
    const r = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sidecar-token': token },
      body: JSON.stringify(body),
    });
    return r.json();
  };

  const dur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    const sp = zh ? '' : ' ';
    if (d) return `${d}${T.d}${sp}${h}${T.h}`;
    if (h) return `${h}${T.h}${sp}${m}${T.m}`;
    if (m) return `${m}${T.m}`;
    return `${sec}${T.s}`;
  };
  const now = () => Date.now() / 1000 + skew;
  const color = (used) => used * 100 >= S.settings.high ? 'var(--qm-high)' : used * 100 >= S.settings.warn ? 'var(--qm-warn)' : 'var(--qm-ok)';
  const fmtPct = (used) => {
    const v = (S.settings.show === 'left' ? 1 - used : used) * 100;
    return (v > 0 && v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)) + '%';
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function win(label, w) {
    if (!w) return '';
    const bar = S.settings.show === 'left' ? 1 - w.used : w.used;
    let sub = w.reset && w.used > 0 ? T.reset(dur(w.reset - now())) : T.full;
    let alert = false;
    if (w.pace) {
      sub += ' · ' + T.pace((w.pace.perHour * 100).toFixed(1));
      if (w.pace.emptyAt) { sub += ' · ' + T.empty(dur(w.pace.emptyAt - now())); alert = true; }
    }
    return `<div class="win"><span class="label">${label}</span><span class="pct" style="color:${color(w.used)}">${fmtPct(w.used)}</span>
      <div class="bar"><i style="width:${(bar * 100).toFixed(1)}%;background:${color(w.used)}"></i></div>
      <span class="sub${alert ? ' alert' : ''}">${sub}</span></div>`;
  }

  function spark(hist) {
    if (!hist || hist.length < 2) return '';
    const t1 = now(), t0 = t1 - 86400, W = 300, H = 44;
    const x = (t) => ((t - t0) / 86400 * W).toFixed(1);
    const y = (v) => (H - 2 - v * (H - 4)).toFixed(1);
    const line = (i) => {
      const pts = hist.filter((h) => h[i] != null);
      if (pts.length < 2) return '';
      // step line: usage holds until the next sample
      let d = `M${x(pts[0][0])},${y(pts[0][i])}`;
      for (let k = 1; k < pts.length; k++) d += `H${x(pts[k][0])}V${y(pts[k][i])}`;
      return d + `H${W}`;
    };
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line class="grid" x1="0" x2="${W}" y1="${y(0.5)}" y2="${y(0.5)}"/>
      <path class="w" d="${line(2)}"/><path class="s" d="${line(1)}"/></svg>
      <div class="legend"><span>${T.last24}</span><span><i style="background:var(--qm-ok)"></i>${T.w5h}</span><span><i style="background:var(--qm-muted)"></i>${T.w7d}</span></div>`;
  }

  function render() {
    if (!S) return;
    $('plan').textContent = S.plan || '';
    const st = $('status');
    if (!S.at) { st.textContent = S.ok ? T.loading : T.offline; st.className = S.ok ? '' : 'bad'; }
    else { st.textContent = S.ok ? T.updated(dur(now() - S.at)) : T.offline; st.className = S.ok ? '' : 'bad'; }
    $('pools').innerHTML = S.pools.length ? S.pools.map((p) => `<section class="pool">
        <h2>${esc(p.name)}</h2>
        ${p.models.length ? `<div class="models">${T.models}${esc(p.models.join(', '))}</div>` : ''}
        ${win(T.w5h, p.s)}${win(T.w7d, p.w)}
        ${S.source === 'status' ? `<div class="hint">${T.fallback}</div>` : ''}
        ${spark(p.history)}
      </section>`).join('') : `<div class="empty">${S.ok ? T.loading : T.offline}</div>`;
    const a = S.awtrix;
    if (S.settings.awtrix.enabled) {
      $('awtrixStatus').textContent = a.lastError ? T.pushErr(a.lastError) : a.lastOkAt ? T.pushOk(dur(now() - a.lastOkAt)) : '';
    }
  }

  function fillSettings() {
    const s = S.settings;
    document.querySelectorAll('#show button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.show));
    $('warn').value = s.warn; $('high').value = s.high;
    $('host').value = s.awtrix.host; $('push').checked = s.awtrix.enabled;
  }

  async function load(path, body) {
    S = await api(path, body);
    skew = S.now - Date.now() / 1000;
    render();
    return S;
  }

  document.querySelectorAll('#show button').forEach((b) => b.addEventListener('click', async () => {
    await load('/api/settings', { show: b.dataset.v }); fillSettings();
  }));
  $('save').addEventListener('click', async () => {
    const r = await load('/api/settings', {
      warn: $('warn').value, high: $('high').value,
      awtrix: { host: $('host').value, enabled: $('push').checked },
    });
    fillSettings();
    $('awtrixStatus').textContent = r.error ? r.error : T.saved;
  });
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  $('probe').addEventListener('click', () => busy($('probe'), async () => {
    if (!S.settings.awtrix.host) { $('awtrixStatus').textContent = T.noHost; return; }
    const r = await api('/api/awtrix/probe', {});
    $('awtrixStatus').textContent = !r.ok ? r.error : r.installed ? T.installed(r.version) + (r.error ? ' · ' + r.error : '') : T.notInstalled;
  }));
  $('install').addEventListener('click', () => busy($('install'), async () => {
    if (!S.settings.awtrix.host) { $('awtrixStatus').textContent = T.noHost; return; }
    const r = await api('/api/awtrix/install', {});
    $('awtrixStatus').textContent = r.ok ? T.installed(r.version) : r.error;
  }));

  load('/api/state').then(fillSettings).catch(() => { $('status').textContent = T.offline; });
  setInterval(() => load('/api/state').catch(() => {}), 15000);
  setInterval(render, 1000);
})();
