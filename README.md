# AI 導入專案管理：部署到 Cloudflare

這個資料夾會在 Cloudflare 上架一個需要密碼才能進入的網頁。資料存在 Cloudflare D1 資料庫，換電腦、換瀏覽器都看得到同一份。

整體架構只有三件事：

| 元件 | 作用 |
| --- | --- |
| Cloudflare Worker | 提供網頁（`public/index.html`）與讀寫資料的 `/api` |
| Cloudflare D1 | 存放專案、工作項目、衝刺與設定 |
| 登入密碼 | 存在 Cloudflare 的加密機密（Secret）裡，不在程式碼中；輸入正確密碼後 30 天內免再登入 |

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

**步驟 6：設定登入密碼**

```bash
npx wrangler secret put APP_PASSWORD
```

會提示你輸入密碼（畫面不會顯示字元），請用一組夠長的密碼（建議 16 字元以上）。密碼只存在 Cloudflare，不會寫進任何檔案。

**步驟 7：上架**

```bash
npx wrangler deploy
```

完成後會顯示網址，格式像 `https://ai-pm.你的子網域.workers.dev`。打開會先看到登入頁，輸入剛才的密碼即可進入。頁面上方顯示「資料已儲存」代表一切正常。

**步驟 8：搬移舊資料**

在原本的版本（claude.ai 連結或下載的 html）按「匯出備份」，得到一個 `.json` 檔；再到新網址按「匯入備份」選擇該檔即可。

## GitHub Pages 單機版（選用）

倉庫內附 `.github/workflows/pages.yml`，推到 GitHub 後會自動把 `public/` 發佈到 GitHub Pages。這個版本沒有後端，資料存在瀏覽器裡，適合臨時查看或離線備用；要跨裝置同步請用 Cloudflare 版。

## 日常維護

**更新網頁**：把新的 html 檔改名為 `index.html`，覆蓋 `public/index.html`，再執行 `npx wrangler deploy`。資料庫內容不受影響。

**更換密碼**：再執行一次 `npx wrangler secret put APP_PASSWORD`。換密碼後所有已登入的瀏覽器都要重新登入。

**登出**：打開 `你的網址/logout`。

**備份**：網頁上的「匯出備份」仍然可用，建議每月存一份。也可以用指令備份整個資料庫：

```bash
npx wrangler d1 export ai-pm --remote --output=backup.sql
```

**多人同時使用**：網頁每 30 秒會自動讀取最新資料。若兩個人同時編輯同一個專案，以最後儲存的為準，所以同一個專案最好一次只有一個人改。

## 常見問題

**打開網址顯示「尚未設定密碼」**：步驟 6 還沒做，或做完後沒有重新執行 `npx wrangler deploy`。

**出現「儲存失敗」或「伺服器拒絕這次儲存」**：登入已過期（30 天）。重新整理頁面、重新登入後再改一次。

**想在自己電腦上測試（選用）**：

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 execute ai-pm --local --file=schema.sql
npx wrangler dev
```

然後打開 `http://localhost:8787`，密碼是 `.dev.vars` 裡的 `APP_PASSWORD`。`.dev.vars` 已列在 `.gitignore`，不會被上傳。

## 安全說明

- 沒有登入 cookie 的請求：網頁一律導向登入頁，`/api` 一律回 401。
- 登入 cookie 是 HttpOnly、SameSite=Lax、Secure，並以密碼衍生的金鑰做 HMAC 簽章，無法偽造。
- 密碼錯誤時伺服器會延遲回應，降低暴力嘗試速度；請仍使用夠長的隨機密碼。
- 寫入只接受同一網址發出的請求。
- 若之後綁定公司自己的網域，登入保護會自動涵蓋，不需額外設定。
