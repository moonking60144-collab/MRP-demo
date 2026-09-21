# Demo 操作指南

## 準備與啟動

需要 Node.js 24 LTS。一般展示使用合成資料，不需要 PostgreSQL、Docker、`.env`、外部服務或公司帳號。

### Windows

下載 ZIP 或 clone 後雙擊 `Start-Demo.cmd`。腳本會從自身目錄啟動；缺少依賴或 build 時，自動執行 `npm ci` 與 `npm run build`，完成後開啟 <http://127.0.0.1:3000>。

首次安裝需要網路。準備完成後可以離線展示；保持終端機開啟，以 `Ctrl+C` 停止。不能把 macOS 的 `node_modules` 或 `.next` 搬到 Windows。

### macOS／Linux

```bash
npm ci
npm run build
npm start
```

開發模式使用 `npm run dev`。

## 建議展示案例

1. 在儀表板執行 MRP，展示進度、暫停、停止、續算與版本切換。
2. 在成品月推搜尋 `PRODUCT-001`，查看第一製程、首站預設來源、完工 ERP、共享庫存與材料提醒。
3. `DEMO-W-001`：早期缺料，但採購較晚到貨。
4. `DEMO-W-002`：領料來源未知，系統維持資料不足，不顯示假綠燈。
5. `DEMO-B-003`：部分領料與在製保留；`DEMO-D-004`：全數耗用；`DEMO-B-005`：耗用後正式退料 300 pc。
6. 在開單規劃儲存、轉單或產生工令，再執行下一版 MRP，查看工令與 BOM 如何回饋計算。
7. 在歷史資料庫搜尋、跳頁並選取版本，沿用左側報表以唯讀模式檢視。

## 本機狀態與重設

Production build 的合成狀態位於 `.next/standalone/demo-data/state.json`；開發模式位於 `demo-data/state.json`。單一 Demo process 使用原子檔案發布，不支援多 process 或多主機共用。

Demo 最多保留 30 個即時版本；歷史展示固定 64 版。重建 `.next` 前若要保留操作結果，請先備份其中的合成狀態。

重設時先停止 server，再執行：

```bash
npm run demo:reset
```

輸入 `RESET` 後，原狀態會移為可恢復備存，下一次啟動重新產生合成資料。

## 可選 PostgreSQL 模式

一般面試展示不需要資料庫。若要核對真正的 Prisma／PostgreSQL 讀寫、用途限制與測試方式，請看 [技術展示與驗證](technology-evidence.md#可選網站-sql-讀取)。
