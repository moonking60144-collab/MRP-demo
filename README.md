# MRP Demo

沿用既有 MRP 程式、頁面與進階表格操作的 Demo 展示版；所有 runtime 資料改用合成資料。
此專案不是重新開發的介面，也不是公司資料庫的複本。

## 隔離邊界

- 不帶入 `.env`、真實資料、備份、Git 歷史或公司的部署腳本。
- 所有 `/api/*` 的可執行入口固定轉送本機 `demo-api`；原 handler 保存在 `reference/production-api`，不是可發布路由。
- 真實 Prisma client 與 Archive PostgreSQL reader 禁止使用。
- 不啟動原有 Ragic 探測、備份、保留、轉單及工令背景工作。
- Ragic 原單連結改成本機合成紀錄；不帶公司的金鑰、帳密或 session。
- 原版成品月推、元件週推與產銷計算引擎實際讀取合成輸入、產生記憶體輸出；不以動畫代替計算。
- 儲存建議、轉單、對帳、工令產生與採購前置週數都只修改本機合成狀態。工令/BOM 會納入下一次 MRP。
- 所有歷史資料 GET-only；舊即時版本不可寫入規劃或主檔。MRP 計算中不可更新規劃/主檔。

## Windows 展示

目標為 Windows 10/11 + Node.js 24 LTS；不要求 PostgreSQL、Docker 或公司 API。
從此儲存庫下載 ZIP 或 clone。請在展示前、使用 Windows 電腦且能連網時準備一次：

```powershell
npm ci
npm run build
```

之後雙擊 `Start-Demo.cmd`，或執行 `npm start`，開啟 `http://127.0.0.1:3000`。
保持終端機開著，Ctrl+C 停止。準備完成後，展示不需要網路或公司帳號。
不能把 Mac 的 `node_modules` 或 `.next` 搬到 Windows；必須在目標 Windows 進行初次安裝/建置。
腳本與 Node launcher 使用自身路徑定位，不依賴終端機所在資料夾。
目前驗收環境為 macOS + Node.js 24 + Chromium；沒有把它當作 Windows 真機驗收。

## 建議展示順序

1. 儀表板執行 MRP：原引擎計算、執行紀錄、暫停/停止/續算、版本選取。
2. 成品月推：搜尋 `PRODUCT-001`，共享 ERP 庫存、訂單與預示整合、同 ERP 整合、製程樹與來源明細。
3. 元件週推：`DEMO-W-001` 有早期缺料與較晚到貨；`DEMO-W-002` 有領料來源未知；`DEMO-W-003` 前置期未設定。
4. 產銷會議：點選訂單需求、生產計畫及剩餘庫存，說明「無計畫供需差」與週期含計畫餘額的差異。
5. 開單規劃與相關生產計劃：儲存/轉單/對帳、失敗與待確認範例、產生工令，再算一版查看工令/BOM。
6. 儀表板的歷史資料庫：64 個合成版本，搜尋、跳頁，選取後沿用左側報表，以唯讀模式檢視。
7. 表格操作：欄位與大列顯示、篩選/排序、个人預設、框選合計、Excel/CSV、sticky 與快速切頁。

## 本機狀態與容量

production 啟動的合成状态位於 `.next/standalone/demo-data/state.json`；dev 位於根目錄 `demo-data/state.json`。
單一 demo process 使用原子檔案發布；不支援多 process/多主機共享此檔案。
最多保留 30 個即時版本，歷史展示固定 64 版，個人表格預設使用瀏覽器 localStorage。
先停止 server，執行 `npm run demo:reset` 並輸入 `RESET`，會將合成状态移為可恢復備存，下一次啟動重新產生。
重建 `.next` 前若想保留操作結果，先備存其中的合成狀態。
容量、備份與 retention 面板展示維運概念；不會執行公司資料清理、Windows 排程或寄信。

## 驗證與依賴限制

`npm test` 驗證 demo API/lifecycle 與保留的原版純計算契約；不代表公司 DB/Ragic integration tests 已在 demo 執行。
`npm run lint` 與 `npm run build` 可獨立執行。
2026-09-17 相容範圍依賴修補後，`npm audit` 仍有 10 項（7 high、2 moderate、1 low，沒有 critical）。
保留框架 major version，未使用 `npm audit fix --force`。Prisma config/工具鏈、停用的 SMTP 與 XLSX 等有未清除警告。
本版只供本機 Demo 展示，不應直接公開部署成 production 服務。
XLSX 用於匯出，不提供讀入任意 Excel 檔案的入口；[SheetJS advisory](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) 說明匯出情境不受該 prototype-pollution 讀檔漏洞影響，這不等於整個 dependency 無風險。

## 開發

```powershell
npm ci
npm run build
npm start
```

開發模式為 `npm run dev`。不需要也不應建立 `.env`。
本機 Git 認證與作者可針對此儲存庫單獨設定，不需要切換全域帳號；金鑰與憑證不放進專案。
