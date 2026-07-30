/*
 * data.js — 範例資料集
 * ------------------------------------------------------------------
 * 台灣高山峰位與「無線電高山站台 / 中繼台」範例點。
 * 座標與高程為概略值，僅供展示；實際使用請自行以地圖點選校正，
 * 或改用精確測量座標。type:
 *   'me'      = 我的位置（可拖曳）
 *   'station' = 無線電高山站台 / 中繼台（要通聯的對象）
 *   'peak'    = 參考山峰（AR 視角標示、遮蔽判斷用）
 */
(function (global) {
  'use strict';

  // 預設「我的位置」— 台東中興村一帶（對應照片拍攝地附近）
  const me = { id: 'me', type: 'me', name: '我的位置', lat: 22.7550, lng: 121.1450, alt: 10, antenna: 3 };

  // 無線電高山站台 / 中繼台（範例；請自行校正座標）
  const stations = [
    { id: 'st-zhuzi', type: 'station', name: '竹子山台', lat: 25.2040, lng: 121.5490, alt: 1103, antenna: 30, freqMHz: 145.700, note: '陽明山區，多家發射站' },
    { id: 'st-wufen', type: 'station', name: '五分山台', lat: 25.0700, lng: 121.7810, alt: 757,  antenna: 25, freqMHz: 145.500, note: '氣象雷達站' },
    { id: 'st-egong', type: 'station', name: '鵝公髻山台', lat: 24.6300, lng: 121.1500, alt: 1579, antenna: 15, freqMHz: 438.500, note: '新竹苗栗交界' },
    { id: 'st-guan',  type: 'station', name: '關山中繼台', lat: 23.2570, lng: 120.9210, alt: 3668, antenna: 6,  freqMHz: 145.700, note: '南橫制高點' },
  ];

  // 參考山峰（含照片中出現者，座標概略）
  const peaks = [
    { id: 'pk-yushan',   type: 'peak', name: '玉山',       lat: 23.4700, lng: 120.9573, alt: 3952 },
    { id: 'pk-nanyu',    type: 'peak', name: '南玉山',     lat: 23.4400, lng: 120.9300, alt: 3383 },
    { id: 'pk-xiugu',    type: 'peak', name: '秀姑巒山',   lat: 23.4730, lng: 121.0210, alt: 3825 },
    { id: 'pk-yunfeng',  type: 'peak', name: '雲峰',       lat: 23.3600, lng: 120.9700, alt: 3564 },
    { id: 'pk-xiangyang',type: 'peak', name: '向陽山',     lat: 23.2900, lng: 121.0300, alt: 3603 },
    { id: 'pk-guanshan', type: 'peak', name: '關山',       lat: 23.2570, lng: 120.9210, alt: 3668 },
    { id: 'pk-xiaoguan', type: 'peak', name: '小關山',     lat: 23.2100, lng: 120.8700, alt: 3249 },
    { id: 'pk-beinan',   type: 'peak', name: '卑南主山',   lat: 23.1900, lng: 120.8600, alt: 3295 },
    { id: 'pk-chuyun',   type: 'peak', name: '出雲山',     lat: 23.2600, lng: 120.7900, alt: 3140 },
  ];

  global.SampleData = { me, stations, peaks };
})(typeof window !== 'undefined' ? window : globalThis);
