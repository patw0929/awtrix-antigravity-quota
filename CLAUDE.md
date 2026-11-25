# awtrix-antigravity-quota

Antigravity 外掛 Quota Monitor：額度池 × 5h／7d、速度與預估用完時間；桌面版有側邊面板，IDE／CLI 有 MCP 工具；選用推送到 AWTRIX 時鐘（52×16 Berry 韌體，如 TC002）。使用說明見 README.md（英文）與 README.zh-TW.md。本機專用資訊（時鐘 IP 等）在 `CLAUDE.local.md`，歷程在 `優化計畫/`，兩者都不上傳。

## 檔案

- `plugin/quota-monitor/`：外掛本體（裝到 `~/.gemini/config/plugins/quota-monitor`）
  - `sidecars/panel/core.mjs`：共用引擎（設定、輪詢、歷史、推送、`runner.json` 單一推送者鎖；找 language server：先用 sidecar 環境變數，再讀 `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/daemon/hub_*.json`）
  - `main.mjs`：桌面版面板 sidecar（只有路由）；`mcp.mjs`：MCP server（stdio，工具 `quota_status`、`awtrix_configure`），由 `mcp_config.json` 註冊
  - `quota.mjs`：讀 language server 與換算（純函式）；`awtrix.mjs`：時鐘 API 與推送節流
  - `index.html`／`panel.js`／`panel.css`：面板（中英文）
  - `clock/antigravity_quota.be`：時鐘 app 2.1.0（只讀 store `q`）
- `docs/`：截圖

## 已知事實（2026-11-25）

- Antigravity 2.34.0 桌面版會啟動外掛的 sidecar 與 MCP；Antigravity IDE 2.8.0（VS Code 分支，跑 `agy --hub`）只啟動 MCP，不啟動 sidecar。額度是帳號共用的
- 外掛格式：`plugin.json` ＋ `sidecars/<名稱>/sidecar.json`（`node main.mjs`、`has_web_ui`、`SIDECAR_UI_ENTRYPOINT_AUX_PANE`；另有 FULL_PANE、SIDEBAR，沒有狀態列）；非 GET 要帶 `x-sidecar-token`
- sidecar 環境變數：`ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_SIDECAR_WEB_PORT`、`ANTIGRAVITY_SIDECAR_UI_TOKEN`；MCP 子行程沒有，改讀 daemon 檔
- `RetrieveUserQuotaSummary`（body `{}`）回兩組：Gemini Models（含 Flash、Orchestrator）、Claude and GPT models；各有 5h／weekly 的 `remainingFraction`＋`resetTime`（為 0 時欄位會缺）
- AWTRIX `/api/v1`：`PUT apps/script/<名稱>` 裝 app（設定保留）、`PATCH apps/<名稱>/data` 寫 store（推送會讓 app 重新載入）、`PUT apps/active` 切換、`GET display/screen` 讀畫素
- 發布：`agy plugin install <資料夾 或 github.com/.../tree/<分支>/<路徑>>`；`agy plugin validate` 檢查格式。內建市集只有 Google 官方與合作夥伴兩個，一般使用者不能加自訂市集
- 面板 CSS 變數一律 `--qm-` 前綴（Antigravity 在 `<html>` 上設 `--muted` 等會蓋掉同名變數）
- 改外掛程式後：`kill` sidecar 會自動重啟；面板 iframe 要關掉重開；MCP 要重開 IDE

## 現況（2026-11-25）

- 外掛 1.1.0：桌面版面板、IDE MCP、接手推送都已實測；時鐘 app 2.1.0 已在實機確認
- 準備公開到 GitHub `patw0929/awtrix-antigravity-quota`（分支 `master`）；README 改成英文為主＋正體中文版

## 待辦

- [ ] 推送到 GitHub 後，用 `agy plugin install <GitHub 網址>` 實測安裝
- [ ] 在 IDE 裡實際問 agent 額度（呼叫 `quota_status`）
- [ ] 實際用掉配額後，確認面板的速度／預估用完與時鐘顏色變化
- [ ] 關掉 Antigravity 超過 15 分鐘，確認時鐘右下角紅點
- [ ] Windows 實測
- [ ] GitHub release（已採 MIT License）
