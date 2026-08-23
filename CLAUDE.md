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
- `js/sky.js` 天文/星座/衛星　·　`js/groups.js` 地點群組
- `js/map.js` 地圖　·　`js/ar.js` AR 視角　·　`js/app.js` 主控
- 數學或解析邏輯有變動時，請同步更新並執行 `test/geo.test.js`。

## 實體型別
- `me` 我的位置　·　`station` 站臺/中繼台　·　`peak` 參考山峰　·　`marker` 自訂標註
- 站臺、山峰、標註都可帶 `group` 欄位；沒帶就依 type 落到預設群組。
- 群組一律透過 `Groups.colorOf()` / `Groups.groupIdOf()` 取用，勿自行判斷顏色。
- 新增實體型別時，`app.js` 的 `allTargets()`、`ar.js` 的陸地目標清單、
  `map.js` 的 `render()` 三處都要同步。

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
