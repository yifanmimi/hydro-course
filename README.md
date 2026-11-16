# 水利技師六科系統課程

網址：https://yifanmimi.github.io/hydro-course/

前台：GitHub Pages（`index.html`、`config.js`、`episodes.js`）
後台：Google Apps Script（`Code.gs`、`appsscript.json`），影片與講義存在擁有者的 Google 雲端硬碟「水利技師課程影片」資料夾，本 repo 不存放任何影片。

使用者用 Google 帳號登入，後台驗證身分後，依試算表「水利課程白名單」決定能不能看：「觀看」可以看影片和講義，「管理」還可以在網頁上管理名單，其他帳號一律拒絕。每個帳號各自記住看到哪裡，手機電腦同步。

## 部署後台（只要做一次）

1. 到 script.google.com 建立新專案，名稱「水利技師課程後台」，把 `Code.gs` 整個貼上
2. 專案設定：勾「在編輯器中顯示 appsscript.json」，把 `appsscript.json` 整個貼上
3. 專案設定 → 指令碼屬性：新增 `CLIENT_ID` = `265991764431-7mv80vl7iighqahnbd1nihgpff50odf6.apps.googleusercontent.com`（與邊坡圖資共用）
4. 編輯器上方選 `setup` 按「執行」並授權（只有擁有者需要授權一次）
5. 部署 → 新增部署作業 → 網頁應用程式：執行身分「我」，存取權「所有人」，複製網址（結尾 `/exec`）
6. 把網址填進本 repo 的 `config.js` 的 `API_URL`

## 開啟 GitHub Pages

repo 的 Settings → Pages → Branch 選 `main`、資料夾 `/ (root)` → Save。

## 影片怎麼上架

每晚的製作排程會把影片切成 3MB 以下的分段，放進雲端硬碟 `_影片分段/<代碼>/`，再寫一個 `_影片目錄/<代碼>.json`。網頁最多 10 分鐘內就會看到新影片（在 Apps Script 執行 `refreshCatalog` 可立刻生效）。後台每小時會自動把分段合併成完整 mp4，放在「影片備份」資料夾。
