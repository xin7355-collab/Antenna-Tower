# CLAUDE.md — 專案與協作說明

## 專案
塔臺對準儀：結合地圖與 AR 視角的無線電高山站臺（中繼台）路徑規劃與對準工具。
純靜態網頁，無建置步驟。詳見 `README.md`。

## 常用指令
```bash
python3 -m http.server 8000   # 本機預覽 http://localhost:8000
node test/geo.test.js         # 執行單元測試（無相依）
```

## 程式結構
- `js/geo.js` 地理/RF 數學（含 targetTopAlt 目標有效高度）
- `js/elevation.js` 高程/遮蔽/繞射/涵蓋/天際線輪廓
- `js/parse.js` 匯入解析（JSON/CSV/GPX + 萬用座標）
- `js/sky.js` 天文/星座/衛星　·　`js/sats.js` 多衛星追蹤（TLE+SGP4）
- `js/groups.js` 地點群組　·　`js/ui.js` 對話框/提示
- `js/map.js` 地圖　·　`js/ar.js` AR 視角　·　`js/app.js` 主控
- 數學或解析邏輯有變動時，請同步更新並執行 `test/geo.test.js`。

## 實體型別
- `me` 我的位置　·　`station` 站臺/中繼台　·　`peak` 參考山峰　·　`marker` 自訂標註
- 站臺、山峰、標註都可帶 `group` 欄位；沒帶就依 type 落到預設群組。
- 群組一律透過 `Groups.colorOf()` / `Groups.groupIdOf()` 取用，勿自行判斷顏色。
- 新增實體型別時，`app.js` 的 `allTargets()`、`ar.js` 的陸地目標清單、
  `map.js` 的 `render()` 三處都要同步。

## 手機優先
- 一律用 `UI.ask/confirm/alert/toast`，**不要用瀏覽器內建的
  `alert`/`confirm`/`prompt`** —— 本 App 會以「加入主畫面」的獨立模式執行，
  iOS 在該模式下對內建對話框的支援不可靠。
- 關鍵按鈕（浮層、AR 控制列）用 `UI.bindTap` 綁定，**不要只設 `onclick`**：
  iOS 獨立模式的「觸控→合成 click」不可靠，會變成按了沒反應。
- 呼叫原生全螢幕後要**驗證真的進了全螢幕**（`toggleFullscreen` 的
  setTimeout 檢查）：iPhone 的 API 可能存在、呼叫不報錯、但什麼都不發生。
- 錯誤原因用會停留的 `UI.alert` 呈現，別用幾秒就消失的 toast ——
  沒看到原因的失敗，感受上就是「壞掉了」。
- AR 仰角上下限為 `PITCH_MIN/PITCH_MAX`（-60°～90°）。上限必須含天頂，
  星座常在 60° 以上，鎖太低會變成手機轉不過去。
- 全螢幕要保留 `_setPseudoFull` 這條 CSS 後備路徑：iPhone Safari 沒有
  元素全螢幕 API，只靠原生 API 會按了沒反應。
- 面板可點元件在窄螢幕要 ≥40px 高、輸入框字級 ≥16px（小於 16px 時
  iOS 會在聚焦時自動放大整頁）。

## AR 顯示與感測器
- AR「顯示」的仰角（標籤/HUD/對準提示）用光學等效地球半徑
  `K_DISPLAY`（=`Elevation.K_OPTICAL`≈1.13），與山稜線一致；
  無線電分析（遮蔽/連結預算）仍用設定的 4/3，勿混用。
- 羅盤給的是**磁北**，`_onOrient` 以 `settings.declination`（預設 -4.5，
  台灣）換算真北後才用。
- 視野角是實例屬性 `this.hfov`（可被雙指縮放與設定改動），
  **不要再引入固定的 HFOV 常數**；垂直視野依 `VFOV_RATIO` 連動。
- 衛星一律走 `js/sats.js`（TLE 快取 12h + vendor/satellite 的 SGP4 本地
  傳播），不要對衛星位置輪詢網路；wheretheiss 只是 ISS 抓不到 TLE 時的
  備援。`Sky.predictPasses`（圓軌道近似）只給該備援用，TLE 在手時
  一律用 `Sats.nextPass`。
- 衛星目錄的 NORAD 編號可能錯：抓回的名稱要跟 `match` 比對，不合就用
  `nameQuery` 搜尋補救 —— 新增衛星時兩者都要填。

## 天際線（山體輪廓）
- 仰角用可見光的等效地球半徑 `Elevation.K_OPTICAL`（≈1.13），
  不是無線電的 4/3 —— AR 疊在相機畫面上才對得準。
- 取資料（`computeSkyline`）與算稜線（`skylineFromRays`）分開，後者為純函式，
  改動時請一併補測試。

## 用語
- 一律使用「**站臺**」（不用「站台」）。
- 應用程式名稱：**塔臺對準儀**（不加副標）。

## 目標高度規則
- 目標有效高度 = `trueAlt`（目標真實高度，絕對海拔）若有填則**優先覆蓋**；
  否則為 `alt`（地面海拔）+ `antenna`（塔臺/天線高）。
- 一律透過 `Geo.targetTopAlt(t, 預設天線)` 取得，勿自行相加。

## 協作偏好（使用者指定）
- **該做就做，不要一直問確認。** 合理且可逆的下一步（含合併已審好的 PR、
  推送修正、部署設定等）直接執行，不必逐項徵求同意；完成後回報即可。
- 只有在真正無法自行判斷、或動作難以復原且影響重大時才詢問。
