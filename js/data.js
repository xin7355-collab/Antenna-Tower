/*
 * data.js — 範例資料集
 * ------------------------------------------------------------------
 * 台灣高山峰位與「無線電高山站臺 / 中繼台」範例點。
 * 座標與高程為概略值，僅供展示；實際使用請自行以地圖點選校正，
 * 或改用精確測量座標。type:
 *   'me'      = 我的位置（可拖曳）
 *   'station' = 無線電高山站臺 / 中繼台（要通聯的對象）
 *   'peak'    = 參考山峰（AR 視角標示、遮蔽判斷用）
 */
(function (global) {
  'use strict';

  // 預設「我的位置」— 台東中興村一帶（對應照片拍攝地附近）
  const me = { id: 'me', type: 'me', name: '我的位置', lat: 22.7550, lng: 121.1450, alt: 10, antenna: 3 };

  // 無線電高山站臺 / 中繼台（範例；座標為概略值，請自行校正）
  const stations = [
    // 北部
    { id: 'st-zhuzi',  type: 'station', name: '竹子山台',   lat: 25.2040, lng: 121.5490, alt: 1103, antenna: 30, freqMHz: 145.700, note: '陽明山區，多家發射站' },
    { id: 'st-qixing', type: 'station', name: '七星山台',   lat: 25.1750, lng: 121.5600, alt: 1120, antenna: 15, freqMHz: 145.620, note: '陽明山最高峰' },
    { id: 'st-guanyin',type: 'station', name: '觀音山台',   lat: 25.1260, lng: 121.4230, alt: 616,  antenna: 20, freqMHz: 438.700, note: '新北五股' },
    { id: 'st-wufen',  type: 'station', name: '五分山台',   lat: 25.0700, lng: 121.7810, alt: 757,  antenna: 25, freqMHz: 145.500, note: '氣象雷達站' },
    { id: 'st-jiangzi',type: 'station', name: '姜子寮山台', lat: 25.0750, lng: 121.7060, alt: 729,  antenna: 15, freqMHz: 439.100, note: '基隆最高峰' },
    // 中部
    { id: 'st-egong',  type: 'station', name: '鵝公髻山台', lat: 24.6300, lng: 121.1500, alt: 1579, antenna: 15, freqMHz: 438.500, note: '新竹苗栗交界' },
    { id: 'st-dadu',   type: 'station', name: '大肚山台',   lat: 24.1550, lng: 120.6150, alt: 310,  antenna: 40, freqMHz: 145.780, note: '台中望高寮' },
    { id: 'st-hehuan', type: 'station', name: '合歡山台',   lat: 24.1420, lng: 121.2760, alt: 3416, antenna: 6,  freqMHz: 145.640, note: '中橫制高點' },
    { id: 'st-yubei',  type: 'station', name: '玉山北峰站', lat: 23.4920, lng: 120.9580, alt: 3858, antenna: 10, freqMHz: 145.660, note: '氣象站/通信' },
    // 南部/東部
    { id: 'st-guan',   type: 'station', name: '關山中繼台', lat: 23.2570, lng: 120.9210, alt: 3668, antenna: 6,  freqMHz: 145.700, note: '南橫制高點' },
    { id: 'st-shou',   type: 'station', name: '壽山台',     lat: 22.6400, lng: 120.2680, alt: 356,  antenna: 20, freqMHz: 438.900, note: '高雄市區' },
  ];

  // 參考山峰（含照片中出現者，座標概略）
  const peaks = [
    // 照片中出現的南台灣群峰
    { id: 'pk-yushan',   type: 'peak', name: '玉山',       lat: 23.4700, lng: 120.9573, alt: 3952 },
    { id: 'pk-nanyu',    type: 'peak', name: '南玉山',     lat: 23.4400, lng: 120.9300, alt: 3383 },
    { id: 'pk-xiugu',    type: 'peak', name: '秀姑巒山',   lat: 23.4730, lng: 121.0210, alt: 3825 },
    { id: 'pk-yunfeng',  type: 'peak', name: '雲峰',       lat: 23.3600, lng: 120.9700, alt: 3564 },
    { id: 'pk-xiangyang',type: 'peak', name: '向陽山',     lat: 23.2900, lng: 121.0300, alt: 3603 },
    { id: 'pk-guanshan', type: 'peak', name: '關山',       lat: 23.2570, lng: 120.9210, alt: 3668 },
    { id: 'pk-xiaoguan', type: 'peak', name: '小關山',     lat: 23.2100, lng: 120.8700, alt: 3249 },
    { id: 'pk-beinan',   type: 'peak', name: '卑南主山',   lat: 23.1900, lng: 120.8600, alt: 3295 },
    { id: 'pk-chuyun',   type: 'peak', name: '出雲山',     lat: 23.2600, lng: 120.7900, alt: 3140 },
    // 中北部著名百岳（供其它地點使用）
    { id: 'pk-xueshan',  type: 'peak', name: '雪山',       lat: 24.3840, lng: 121.2300, alt: 3886 },
    { id: 'pk-dabajian', type: 'peak', name: '大霸尖山',   lat: 24.4620, lng: 121.2560, alt: 3492 },
    { id: 'pk-nanhu',    type: 'peak', name: '南湖大山',   lat: 24.3610, lng: 121.4390, alt: 3742 },
    { id: 'pk-zhongyang',type: 'peak', name: '中央尖山',   lat: 24.3830, lng: 121.4460, alt: 3705 },
    { id: 'pk-qilai',    type: 'peak', name: '奇萊主山',   lat: 24.0890, lng: 121.2930, alt: 3560 },
    { id: 'pk-hehuan',   type: 'peak', name: '合歡山主峰', lat: 24.1420, lng: 121.2760, alt: 3417 },
    { id: 'pk-pintian',  type: 'peak', name: '品田山',     lat: 24.4010, lng: 121.2450, alt: 3524 },
    { id: 'pk-nengao',   type: 'peak', name: '能高山',     lat: 24.0200, lng: 121.2500, alt: 3262 },
    { id: 'pk-yubei',    type: 'peak', name: '玉山北峰',   lat: 23.4920, lng: 120.9580, alt: 3858 },
  ];

  global.SampleData = { me, stations, peaks };
})(typeof window !== 'undefined' ? window : globalThis);
