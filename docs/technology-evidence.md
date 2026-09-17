# 技術展示與驗證

此專案用合成資料展示既有 MRP 的功能與技術。畫面展示和資料庫驗證是兩個獨立入口；不連公司 API 或資料庫，不需要公司帳號或環境檔。

## 技術與可核對證據

| 技術 | 本專案的實作 | 如何核對 |
| --- | --- | --- |
| Next.js 15、React 19、TypeScript | 原有 App Router 頁面、Route Handlers、報表元件 | `src/app`、`src/components`；production build 與實際啟動後的 HTTP smoke |
| Prisma 6 | 原有模型、Client 型別、查詢、`createMany`、`$transaction` | `prisma/schema.prisma`、原 MRP 引擎、`src/lib/demo-postgres/verify.ts`；真正連 PG 後查回結果 |
| PostgreSQL | `public`／`staging`／`mrp_out` 三個 schema；Decimal、JSONB、唯一約束 | 真實資料庫內的輸入／輸出、原進度更新 SQL、重複鍵與交易回滾測試 |
| MRP 批次計算 | 成品月推、同 ERP 聚合、元件 W/B/D 週推、產銷 | `src/lib/mrp/*-engine.ts`；同一合成輸入的 DB／離線結果對照、獨立數量守恆 |
| 版本化資料 | 以 `mrpRunId` 分隔輸入快照和結果 | 第二個 Run 的計算及重跑，不能修改第一個 Run 的結果；不能增加同版本重複輸出 |
| 表格互動與呈現 | 篩選／排序／欄位分組／框選合計／展開／匯出 | 操作展示頁面與對應元件、純函式測試；HTTP smoke 不代表所有瀏覽器互動已驗證 |
| GitHub Actions | 離線展示品質檢查及獨立 PostgreSQL 整合檢查 | `.github/workflows/demo-verification.yml`；核對執行紀錄的 commit SHA 與 JSON artifact，不只看 badge |

## 離線展示

一般 Windows 展示仍使用合成記憶體資料與本機 JSON 狀態。依 README 準備後雙擊 `Start-Demo.cmd`，不需要 PostgreSQL 或 Docker。
離線計算使用 Prisma 模型資訊及相容的記憶體存取介面；不是實際 SQL 查詢，不能拿離線成功當成資料庫驗證。

## 真正 Prisma／PostgreSQL 驗證

有 PostgreSQL 命令列工具的 macOS／Linux，可執行：

```bash
npm run test:postgres:local
```

此入口建立全新的臨時 PG cluster、動態 loopback port 與 `mrp_demo_prisma_test`，完成後關閉並清除自己建立的暫存資料。不碰系統服務，也不會重設現有資料庫。

也可先自行準備新的空白測試庫，其 owner／連線使用者必須都是 `mrp_demo_test`，再指定專用連線變數：

```powershell
$env:MRP_DEMO_TEST_DATABASE_URL = 'postgresql://mrp_demo_test:你的測試庫密碼@127.0.0.1:5432/mrp_demo_prisma_test'
npm run test:postgres
```

不使用公司 `.env` 或 `DATABASE_URL` 連庫；唯一的 DB 入口是專用 `MRP_DEMO_TEST_DATABASE_URL`。只接受 loopback、指定的 DB／使用者，且不接受額外連線參數。本機 PG 工具不繼承 `PGHOST`／`PGHOSTADDR` 等連線環境變數。既有資料庫沒有正確用途標記就拒絕；不 DROP、TRUNCATE，也不使用 `--accept-data-loss`。
第一次只在空白展示庫，以既有 Prisma 模型生成 DDL，連同用途標記在同一交易建立。這不是公司正式庫的 migration／DDL 部署流程。

驗證真正的查詢及批次寫入，並核對七組輸出：成品摘要／期間／建議、元件摘要／期間、產銷摘要／期間。
資料庫數值與離線參考結果對照時，Decimal／Float 正規化到 12 位有效數字，排除自動產生的 surrogate ID；實際 PG column metadata 標示為 `DATE` 的欄位只比較日期，timestamp 欄位仍比較完整時間；獨立元件用量守恆誤差限為 `1e-8`。
另驗證共享 ERP 庫存不重複加總、正式退料 300pc、JSONB 進度實際更新、第二個 Run 隔離、重跑、唯一約束，以及重複鍵造成的跨表交易回滾。
用途標記的負向測試在交易內故意改成非展示用途，確認初始化使用的同一個標記檢查會拒絕，再回滾保留原標記。

產物在 Git 忽略的 `release/prisma-postgres.json`，包含實際 PG／Prisma／Node 版本、受測 Run、輸出筆數及通過項目。
此驗證入口沒有註冊成 Next.js API，不會讓展示網站取得真實 DB 權限，也不改寫原來的展示狀態。

## CI 與可宣稱範圍

workflow 的離線 job 在 Linux／Windows 安裝、測試、lint、build，透過實際 standalone launcher 執行 HTTP smoke。
資料庫 job 在 Linux 使用一次性的 PostgreSQL 17 service，執行真正 Prisma 整合驗證；測試庫密碼取自該次 CI run 的識別值，不使用公司 Secrets。

只有對應 commit 的遠端 job 實際通過，才能宣稱該環境的 CI 成功。Linux PG 驗證不代表 Windows PostgreSQL 驗證；Windows HTTP smoke 不代表全部瀏覽器視覺／互動驗收。
原始 Ragic API、正式封存／備份／排程／寄信等在 Demo 仍停用；本文件不宣稱它們已完成真實外部整合測試。
