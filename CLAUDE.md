# CLAUDE.md — 專案與協作說明

## 專案
高山無線電站台 VR 地圖：結合地圖與 AR/VR 視角的無線電中繼台路徑規劃工具。
純靜態網頁,無建置步驟。詳見 `README.md`。

## 常用指令
```bash
python3 -m http.server 8000   # 本機預覽 http://localhost:8000
node test/geo.test.js         # 執行單元測試（無相依）
```

## 程式結構
- `js/geo.js` 地理/RF 數學  ·  `js/elevation.js` 高程/遮蔽/繞射/涵蓋
- `js/parse.js` 匯入解析  ·  `js/map.js` 地圖  ·  `js/ar.js` AR 視角  ·  `js/app.js` 主控
- 數學或解析邏輯有變動時,請同步更新並執行 `test/geo.test.js`。

## 協作偏好（使用者指定）
- **該做就做,不要一直問確認。** 合理且可逆的下一步（含合併已審好的 PR、
  推送修正、部署設定等）直接執行,不必逐項徵求同意;完成後回報即可。
- 只有在真正無法自行判斷、或動作難以復原且影響重大時才詢問。
