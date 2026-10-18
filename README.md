# AI 導入專案管理：部署到 Cloudflare

這個資料夾會在 Cloudflare 上架一個只有你（和你授權的同事）能登入的網頁。資料存在 Cloudflare D1 資料庫，換電腦、換瀏覽器都看得到同一份。

整體架構只有三件事：

| 元件 | 作用 |
| --- | --- |
| Cloudflare Worker | 提供網頁（`public/index.html`）與讀寫資料的 `/api` |
| Cloudflare D1 | 存放專案、工作項目、衝刺與設定 |
| Cloudflare Access | 登入關卡：只有名單內的 email 能打開網頁 |

## 開始前

1. **先問 IT 或資安。** 專案內容可能包含公司內部流程與數字，放到外部雲端前請確認公司規定允許。若公司已有 Cloudflare 帳號，請 IT 協助或提供權限，不要自己用個人帳號存公司資料。
2. 準備一個 Cloudflare 帳號（免費方案即可）。
3. 安裝 [Node.js](https://nodejs.org/) 的 LTS 版本。安裝完成後，在終端機輸入 `node -v`，有出現版本號就代表成功。

## 部署步驟

以下指令都在這個資料夾裡執行（Windows 用「命令提示字元」或 PowerShell，Mac 用「終端機」）。

**步驟 1：安裝工具**

```bash
npm install
```

**步驟 2：登入 Cloudflare**

```bash
npx wrangler login
```

瀏覽器會跳出授權頁面，按允許即可。

**步驟 3：建立資料庫**

```bash
npx wrangler d1 create ai-pm
```

畫面會輸出一段設定，其中有一行 `database_id`。

**步驟 4：填入資料庫 ID**

打開 `wrangler.jsonc`，把 `"請貼上-database_id"` 換成上一步拿到的 `database_id`，存檔。

**步驟 5：建立資料表**

```bash
npx wrangler d1 execute ai-pm --remote --file=schema.sql
```

**步驟 6：第一次上架**

```bash
npx wrangler deploy
```

完成後會顯示網址，格式像 `https://ai-pm.你的子網域.workers.dev`。這時打開網頁會看到「伺服器拒絕讀取資料」，這是正常的：登入關卡還沒設定，所以伺服器先擋下所有讀寫。

**步驟 7：開啟登入保護（Cloudflare Access）**

1. 到 [Cloudflare 主控台](https://dash.cloudflare.com/)，進入 **Workers & Pages**，點選 `ai-pm`。
2. 進入 **Settings → Domains & Routes**。
3. 在 `workers.dev` 那一列按 **Enable Cloudflare Access**。第一次使用時，可能會要求你先建立 Zero Trust 組織（取一個團隊名稱、選 Free 方案）。
4. 跳出的視窗會顯示兩個值：**團隊網域**（類似 `https://你的團隊.cloudflareaccess.com`）與 **AUD**（一長串英數字）。先複製起來。
5. 按 **Manage Cloudflare Access** 調整允許名單：可以只放你自己的 email，或放進種子成員、主管的 email，也可以設定「email 結尾是 @你們公司.com」。

主控台的按鈕名稱和位置可能隨 Cloudflare 改版而變動，若找不到，請參考官方說明：[Workers 的 Access 設定](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev)。

**步驟 8：把登入設定填回去，再上架一次**

打開 `wrangler.jsonc`，填入：

```jsonc
"vars": {
  "TEAM_DOMAIN": "https://你的團隊.cloudflareaccess.com",
  "POLICY_AUD": "貼上 AUD"
}
```

存檔後執行：

```bash
npx wrangler deploy
```

**步驟 9：登入使用**

打開網址，輸入允許名單中的 email，收信取得驗證碼後就能進入。頁面上方顯示「資料已儲存」代表一切正常。

**步驟 10：搬移舊資料**

在原本的版本（claude.ai 連結或下載的 html）按「匯出備份」，得到一個 `.json` 檔；再到新網址按「匯入備份」選擇該檔即可。

## 日常維護

**更新網頁**：把新的 html 檔改名為 `index.html`，覆蓋 `public/index.html`，再執行 `npx wrangler deploy`。資料庫內容不受影響。

**備份**：網頁上的「匯出備份」仍然可用，建議每月存一份。也可以用指令備份整個資料庫：

```bash
npx wrangler d1 export ai-pm --remote --output=backup.sql
```

**多人同時使用**：網頁每 30 秒會自動讀取最新資料。若兩個人同時編輯同一個專案，以最後儲存的為準，所以同一個專案最好一次只有一個人改。

## 常見問題

**一直顯示「伺服器拒絕讀取資料」**：檢查步驟 8 的兩個值是否完整貼上、沒有多餘空白，並確認有重新執行 `npx wrangler deploy`。

**出現「儲存失敗」**：通常是登入過期。重新整理頁面、重新登入後再改一次。

**想在自己電腦上測試（選用）**：

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 execute ai-pm --local --file=schema.sql
npx wrangler dev
```

然後打開 `http://localhost:8787`。`.dev.vars` 會關閉登入檢查，**只能用在本機**，不要上傳或部署。

## 安全說明

- Cloudflare Access 在請求進到網頁之前就會擋下未登入的人。
- Worker 另外會驗證 Access 簽發的登入憑證（`Cf-Access-Jwt-Assertion`），沒有有效憑證的 `/api` 請求一律拒絕。
- 寫入只接受同一網址發出的請求。
- 若之後綁定公司自己的網域，請確認 Access 保護也涵蓋該網域。
