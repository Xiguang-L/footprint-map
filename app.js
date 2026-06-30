/* =========================================================================
 * 家庭旅行足迹地图  ——  Phase 2 + 多图升级
 *
 * 登录：Google（GIS 令牌模式，drive.file 权限）
 * 存储：你自己的 Google Drive 文件夹「家庭旅行足迹地图」
 *   - footprints.json：所有打卡点（每张照片只存一张小缩略图，加载快）
 *   - 每张照片的“高清版”单独存成一个图片文件，记录里只放它的 fileId
 *   - 点击缩略图时，才按需从 Drive 拉取高清原图看大图
 * ========================================================================= */

// ===================== 一、Google 登录（GIS 令牌模式） =====================
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

let tokenClient = null;
let accessToken = null;
let signedIn = false;
let tokenResolve = null;

// —— 把令牌存本地，有效期（约 1 小时）内重开/刷新免登录 ——
const TOKEN_KEY = "gdrive-token";
function saveToken(token, expiresInSec) {
  const expiresAt = Date.now() + (expiresInSec - 60) * 1000; // 留 60s 余量
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt })); } catch (e) {}
}
function loadStoredToken() {
  try {
    const o = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (o && o.token && o.expiresAt > Date.now()) return o;
  } catch (e) {}
  return null;
}
function clearStoredToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
}

function whenGisReady(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) cb();
  else setTimeout(() => whenGisReady(cb), 100);
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) {
        saveToken(resp.access_token, Number(resp.expires_in) || 3600);
      }
      const t = resp && resp.access_token ? resp.access_token : null;
      if (tokenResolve) { tokenResolve(t); tokenResolve = null; }
    },
    error_callback: (err) => {
      console.warn("登录被取消或出错：", err);
      if (tokenResolve) { tokenResolve(null); tokenResolve = null; }
    },
  });
  document.getElementById("btn-auth").disabled = false;
}

function requestToken(prompt) {
  return new Promise((resolve) => {
    tokenResolve = resolve;
    // 兜底：8 秒内没有回调就当作失败，避免状态卡住
    setTimeout(() => {
      if (tokenResolve === resolve) { tokenResolve = null; resolve(null); }
    }, 8000);
    try {
      tokenClient.requestAccessToken({ prompt });
    } catch (e) {
      console.error(e);
      resolve(null);
    }
  });
}

// silent=true：静默登录（prompt:'none'，不弹窗，失败就维持未登录）
async function doSignIn() {
  if (!tokenClient) { alert("登录组件还在加载，请过一两秒再点。"); return; }
  setStatus("正在登录…");
  const token = await requestToken("");
  if (!token) { updateAuthUI(); return; }
  accessToken = token;
  signedIn = true;
  updateAuthUI();
  try {
    await loadFromDrive();
  } catch (e) {
    console.error(e);
    alert("从 Google Drive 载入数据失败：" + e.message);
  }
}

// 用本地保存的令牌恢复登录（有效期内免重新点）
async function restoreSession() {
  const stored = loadStoredToken();
  if (!stored) { updateAuthUI(); return; }
  accessToken = stored.token;
  signedIn = true;
  updateAuthUI();
  try {
    await loadFromDrive();
  } catch (e) {
    console.warn("用已存令牌载入失败（可能已失效，请重新登录）", e);
  }
}

function signOut() {
  if (accessToken && google.accounts.oauth2.revoke) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  clearStoredToken();
  accessToken = null;
  signedIn = false;
  folderId = null;
  dataFileId = null;
  places = [];
  photoUrlCache.forEach((url) => URL.revokeObjectURL(url));
  photoUrlCache.clear();
  renderAll();
  updateAuthUI();
}

function setStatus(msg) {
  document.getElementById("auth-status").textContent = msg;
}

function updateAuthUI() {
  const btn = document.getElementById("btn-auth");
  if (signedIn) {
    btn.textContent = "退出";
    setStatus("已登录 · 数据存在你的 Google Drive");
  } else {
    btn.textContent = "用 Google 登录";
    setStatus("未登录");
  }
}

document.getElementById("btn-auth").addEventListener("click", () => {
  if (signedIn) signOut();
  else doSignIn();
});

document.getElementById("btn-connect").addEventListener("click", () => {
  if (!signedIn) { alert("请先登录，再连接家庭地图。"); return; }
  if (localStorage.getItem(FILE_KEY)) {
    if (confirm("当前已连接一张共享地图。\n点【确定】重新选择共享文件；点【取消】断开、回到你自己的地图。")) {
      connectToFamilyMap();
    } else {
      disconnectFamilyMap();
      alert("已断开，回到你自己的地图。");
    }
  } else {
    connectToFamilyMap();
  }
});

// ===================== 二、Google Drive 存取 =====================
const APP_FOLDER_NAME = "家庭旅行足迹地图";
const DATA_FILE_NAME = "footprints.json";
let folderId = null;
let dataFileId = null;
let myFolderId = null; // “我自己”的文件夹（存照片用，与是否连接共享地图无关）

async function driveFetch(url, options = {}) {
  if (!accessToken) throw new Error("未登录");
  const headers = Object.assign({}, options.headers, {
    Authorization: "Bearer " + accessToken,
  });
  const resp = await fetch(url, Object.assign({}, options, { headers }));
  if (resp.status === 401) {
    clearStoredToken();
    accessToken = null;
    signedIn = false;
    updateAuthUI();
    throw new Error("登录已过期，请重新点右上角登录后再操作。");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("Drive 请求失败 (" + resp.status + ") " + text);
  }
  return resp;
}

// 路1：整张地图（含内嵌照片）就是“一个 JSON 文件”。
// 家人直接“选这一个文件”就能共读共写（drive.file 允许读写你选中的单个文件）。
// 已连接的那个文件 id 存在本地（一次连接，长期生效）。
const FILE_KEY = "family-file-id";

// 自己地图的文件夹（仅“自己模式”用；找不到时按需新建）
async function resolveFolder(createIfMissing) {
  if (folderId) return folderId;
  const q = `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name)`
  );
  const data = await res.json();
  if (data.files && data.files.length) { folderId = data.files[0].id; return folderId; }
  if (createIfMissing) {
    const res2 = await driveFetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    folderId = (await res2.json()).id;
    return folderId;
  }
  return null;
}

async function findDataFile() {
  const q = `name='${DATA_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name)`
  );
  const data = await res.json();
  dataFileId = data.files && data.files.length ? data.files[0].id : null;
}

async function readDataFile(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  const data = await res.json().catch(() => []);
  places = Array.isArray(data) ? data : [];
}

async function loadFromDrive() {
  setStatus("正在从 Google Drive 载入…");
  const connectedFile = localStorage.getItem(FILE_KEY);
  if (connectedFile) {
    // 共享模式：直接读写家人共享的那个文件
    dataFileId = connectedFile;
    folderId = null;
    try {
      await readDataFile(connectedFile);
    } catch (e) {
      console.error("读取共享文件失败：", e);
      localStorage.removeItem(FILE_KEY);
      dataFileId = null; places = [];
      renderAll(); updateAuthUI();
      alert("无法访问已连接的家庭地图文件。\n错误详情：" + e.message + "\n（请把这行错误告诉开发者）");
      return;
    }
    renderAll(); updateAuthUI();
    return;
  }
  // 自己模式：找自己的文件夹 + footprints.json
  const fid = await resolveFolder(false);
  if (!fid) { places = []; renderAll(); updateAuthUI(); return; }
  folderId = fid;
  await findDataFile();
  if (dataFileId) await readDataFile(dataFileId);
  else places = [];
  renderAll();
  updateAuthUI();
}

async function saveToDrive() {
  const body = JSON.stringify(places);
  const connectedFile = localStorage.getItem(FILE_KEY);
  if (connectedFile) {
    dataFileId = connectedFile; // 共享模式：写入家人共享的那个文件
  } else {
    await resolveFolder(true);
    if (!dataFileId) {
      const res = await driveFetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: DATA_FILE_NAME, parents: [folderId], mimeType: "application/json" }),
      });
      dataFileId = (await res.json()).id;
    }
  }
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${dataFileId}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// 找/建“我自己”的文件夹（存照片用）。无论是否连接共享地图，照片都存到自己 Drive。
async function ensurePhotoFolder() {
  if (myFolderId) return myFolderId;
  const q = `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name)`
  );
  const data = await res.json();
  if (data.files && data.files.length) { myFolderId = data.files[0].id; return myFolderId; }
  const res2 = await driveFetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  myFolderId = (await res2.json()).id;
  return myFolderId;
}

// 上传一张高清图到“我自己”的 Drive，并设为“链接可见”，返回 fileId
async function uploadPhoto(blob) {
  const fid = await ensurePhotoFolder();
  const res = await driveFetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "photo-" + makeId() + ".jpg", parents: [fid], mimeType: "image/jpeg" }),
  });
  const id = (await res.json()).id;
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  // 设为“任何知道链接的人可查看”，这样家人/分享页都能加载
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  return id;
}

// 公开 Drive 图片的可直接用于 <img> 的地址
function publicPhotoUrl(fileId, w) {
  return `https://lh3.googleusercontent.com/d/${fileId}=w${w || 2560}`;
}

// 删除一个 Drive 文件（best-effort，失败忽略）
async function deletePhotoFile(fileId) {
  try {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE" });
  } catch (e) {
    console.warn("删除照片文件失败（忽略）", e);
  }
}

// 按需拉取高清原图，返回可用于 <img> 的本地地址（带缓存）
const photoUrlCache = new Map(); // fileId -> objectURL
async function fetchFullPhoto(fileId) {
  if (photoUrlCache.has(fileId)) return photoUrlCache.get(fileId);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  photoUrlCache.set(fileId, url);
  return url;
}

function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// —— 连接“家庭地图”：用 Google Picker 选中主人共享的那个数据文件（footprints.json）——
let pickerLoaded = false;
function loadPicker(cb) {
  if (pickerLoaded && window.google && google.picker) { cb(); return; }
  if (!window.gapi) { alert("Picker 组件还在加载，请过一两秒再试。"); return; }
  gapi.load("picker", () => { pickerLoaded = true; cb(); });
}

function connectToFamilyMap() {
  if (!signedIn || !accessToken) { alert("请先登录，再连接家庭地图。"); return; }
  if (typeof GOOGLE_API_KEY === "undefined" || !GOOGLE_API_KEY || GOOGLE_API_KEY.indexOf("AIza") !== 0) {
    alert("还没配置 Picker 的 API 密钥（config.js 里的 GOOGLE_API_KEY）。");
    return;
  }
  loadPicker(() => {
    // 显示“与我共享”的内容：进入共享的文件夹，选里面的 footprints.json（只显示 JSON 文件）
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setOwnedByMe(false)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMimeTypes("application/json")
      .setMode(google.picker.DocsViewMode.LIST);
    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE_API_KEY)
      // 关键：把令牌与本应用关联（App ID = 项目编号 = Client ID 开头那串数字）。
      // 否则 drive.file 选中文件后后端读不到、报 404。
      .setAppId(GOOGLE_CLIENT_ID.split("-")[0])
      .setTitle("进入共享的「家庭旅行足迹地图」文件夹，选中里面的 footprints.json")
      .addView(view)
      .setCallback(pickerCallback)
      .build();
    picker.setVisible(true);
  });
}

function pickerCallback(data) {
  if (!data || data.action !== google.picker.Action.PICKED) return;
  const doc = data.docs && data.docs[0];
  if (!doc) return;
  localStorage.setItem(FILE_KEY, doc.id);
  dataFileId = doc.id;
  folderId = null;
  setStatus("正在载入家庭地图…");
  loadFromDrive()
    .then(() => alert("已连接家庭地图，载入了 " + places.length + " 个打卡点。"))
    .catch((e) => {
      console.error(e);
      alert("连接后载入失败：" + e.message + "\n请确认主人已把该地图共享给你（编辑者）。");
    });
}

// 断开连接：回到“你自己的地图”
function disconnectFamilyMap() {
  localStorage.removeItem(FILE_KEY);
  folderId = null;
  dataFileId = null;
  if (signedIn) loadFromDrive().catch((e) => console.warn(e));
}

// ===================== 三、应用状态 =====================
let places = [];
const markerById = new Map();
let pendingLatLng = null;
let tempMarker = null;
let pendingPhotos = []; // 弹窗里的照片：新增的 { blob, thumb, name }；已有的 { existing:true, fileId, thumb, name }
let editingId = null;   // null = 新增模式；否则 = 正在编辑的打卡点 id
let currentFilter = null; // 分类筛选：null = 全部；否则 = 某个分类 key
let editLatLng = null;    // 编辑时的工作坐标（可被“调整位置”改动）
let repositioning = false; // 是否处于“调整位置”模式
let repositionMarker = null;

// 分类定义（标签文字可随意改；key 不要改，否则旧数据对不上）
const CATEGORIES = [
  { key: "sight", label: "景点", emoji: "🏞️" },
  { key: "food",  label: "美食", emoji: "🍜" },
  { key: "stay",  label: "住宿", emoji: "🏨" },
  { key: "work",  label: "出差", emoji: "💼" },
  { key: "wish",  label: "想去", emoji: "⭐" },
  { key: "fishing", label: "小猫钓鱼", emoji: "🐱" },
  { key: "other", label: "其他", emoji: "📍" },
];
const CAT_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
function catOf(p) { return CAT_BY_KEY[p.category] || CAT_BY_KEY["other"]; }

// ===================== 四、初始化地图 =====================
const map = L.map("map").setView([25, 30], 2);

// 底图：街道 / 卫星 / 地形，右上角可切换
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap 贡献者",
}).addTo(map);
const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "卫星影像 &copy; Esri" }
);
const terrainLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  attribution: "地形 &copy; OpenTopoMap (CC-BY-SA)",
});
L.control.layers({ "街道": streetLayer, "卫星": satelliteLayer, "地形": terrainLayer }).addTo(map);

// 标记聚合：点多时自动合并成数字气泡，放大才散开
const clusterGroup = L.markerClusterGroup({ maxClusterRadius: 50 });
map.addLayer(clusterGroup);

function pinIcon(categoryKey) {
  const c = CAT_BY_KEY[categoryKey] || CAT_BY_KEY["other"];
  return L.divIcon({
    className: "",
    html: `<div class="pin-icon">${c.emoji}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 24],
    popupAnchor: [0, -22],
  });
}

function requireSignIn() {
  if (!signedIn) {
    alert("请先点右上角『用 Google 登录』，登录后才能添加打卡点。");
    return false;
  }
  return true;
}

// ---------- 高德搜索（国内准）+ OSM 兜底（国外）----------
// 火星坐标(GCJ-02) -> 国际坐标(WGS-84)；只对中国境内的点纠偏，国外原样返回
function gcj02ToWgs84(lng, lat) {
  const PI = Math.PI, a = 6378245.0, ee = 0.00669342162296594323;
  if (!(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55)) return [lng, lat]; // 国外不偏移
  const tLat = -100 + 2 * (lng - 105) + 3 * (lat - 35) + 0.2 * (lat - 35) * (lat - 35) +
    0.1 * (lng - 105) * (lat - 35) + 0.2 * Math.sqrt(Math.abs(lng - 105)) +
    (20 * Math.sin(6 * (lng - 105) * PI) + 20 * Math.sin(2 * (lng - 105) * PI)) * 2 / 3 +
    (20 * Math.sin((lat - 35) * PI) + 40 * Math.sin((lat - 35) / 3 * PI)) * 2 / 3 +
    (160 * Math.sin((lat - 35) / 12 * PI) + 320 * Math.sin((lat - 35) * PI / 30)) * 2 / 3;
  const tLng = 300 + (lng - 105) + 2 * (lat - 35) + 0.1 * (lng - 105) * (lng - 105) +
    0.1 * (lng - 105) * (lat - 35) + 0.1 * Math.sqrt(Math.abs(lng - 105)) +
    (20 * Math.sin(6 * (lng - 105) * PI) + 20 * Math.sin(2 * (lng - 105) * PI)) * 2 / 3 +
    (20 * Math.sin((lng - 105) * PI) + 40 * Math.sin((lng - 105) / 3 * PI)) * 2 / 3 +
    (150 * Math.sin((lng - 105) / 12 * PI) + 300 * Math.sin((lng - 105) / 30 * PI)) * 2 / 3;
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (tLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * PI);
  const dLng = (tLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng * 2 - (lng + dLng), lat * 2 - (lat + dLat)];
}

// 动态加载高德 JS API
function loadAMap() {
  if (typeof AMAP_KEY === "undefined" || !AMAP_KEY) return;
  if (typeof AMAP_SECURITY !== "undefined" && AMAP_SECURITY) {
    window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY };
  }
  const s = document.createElement("script");
  s.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&plugin=AMap.PlaceSearch`;
  s.async = true;
  document.head.appendChild(s);
}
loadAMap();

// 用高德 POI 搜索（结果转成 WGS-84）
function amapSearch(query) {
  return new Promise((resolve) => {
    if (!window.AMap || !AMap.PlaceSearch) { resolve([]); return; }
    try {
      const ps = new AMap.PlaceSearch({ pageSize: 8 });
      ps.search(query, (status, result) => {
        if (status !== "complete" || !result.poiList || !result.poiList.pois) { resolve([]); return; }
        resolve(
          result.poiList.pois.map((poi) => {
            const loc = poi.location || {};
            const lng = loc.lng != null ? loc.lng : (loc.getLng ? loc.getLng() : 0);
            const lat = loc.lat != null ? loc.lat : (loc.getLat ? loc.getLat() : 0);
            const [wlng, wlat] = gcj02ToWgs84(lng, lat);
            const ll = L.latLng(wlat, wlng);
            const addr = typeof poi.address === "string" ? poi.address : "";
            return { name: poi.name + (addr ? " · " + addr : ""), center: ll, bbox: L.latLngBounds(ll, ll) };
          })
        );
      });
    } catch (e) { console.warn("高德搜索出错", e); resolve([]); }
  });
}

// 用 OpenStreetMap 搜索（国外兜底）
function osmSearch(query) {
  return fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&accept-language=zh&limit=5`)
    .then((r) => r.json())
    .then((arr) =>
      (arr || []).map((it) => {
        const ll = L.latLng(parseFloat(it.lat), parseFloat(it.lon));
        const bb = it.boundingbox;
        return {
          name: it.display_name,
          center: ll,
          bbox: bb ? L.latLngBounds(L.latLng(+bb[0], +bb[2]), L.latLng(+bb[1], +bb[3])) : L.latLngBounds(ll, ll),
        };
      })
    )
    .catch(() => []);
}

// 合并：高德结果在前（国内优先），OSM 在后（国外兜底）
const combinedGeocoder = {
  geocode: function (query, cb) {
    Promise.all([amapSearch(query), osmSearch(query)]).then(([a, o]) => cb(a.concat(o)));
  },
};

const geocoder = L.Control.geocoder({
  defaultMarkGeocode: false,
  collapsed: false,
  geocoder: combinedGeocoder,
  placeholder: "搜索地点（国内更准）…",
  errorMessage: "没找到这个地点，换个说法试试",
})
  .on("markgeocode", (e) => {
    const r = e.geocode;
    if (r.bbox) map.flyToBounds(r.bbox, { maxZoom: 12 });
    else map.flyTo(r.center, 10);
    if (!requireSignIn()) return;
    pendingLatLng = r.center;
    if (tempMarker) tempMarker.remove();
    tempMarker = L.circleMarker(r.center, {
      radius: 9, color: "#0d9488", fillColor: "#0d9488", fillOpacity: 0.4, weight: 2,
    }).addTo(map);
    openModal(r.name.split(",")[0].trim());
  })
  .addTo(map);

map.on("click", (e) => {
  if (repositioning) { if (repositionMarker) repositionMarker.setLatLng(e.latlng); return; }
  if (!requireSignIn()) return;
  pendingLatLng = e.latlng;
  if (tempMarker) tempMarker.remove();
  tempMarker = L.circleMarker(e.latlng, {
    radius: 9, color: "#0d9488", fillColor: "#0d9488", fillOpacity: 0.4, weight: 2,
  }).addTo(map);
  openModal();
});

// ===================== 五、照片：缩略图与大图 =====================
// 兼容旧数据：旧版是单张 p.photo（data URL，无 fileId）
function getPhotos(p) {
  if (Array.isArray(p.photos)) return p.photos;
  if (p.photo) return [{ thumb: p.photo }];
  return [];
}

function photoThumbsHtml(p) {
  const photos = getPhotos(p);
  if (!photos.length) return "";
  const imgs = photos
    .map(
      (ph, i) =>
        `<img class="thumb-mini" src="${ph.thumb}" style="cursor:zoom-in" onclick="event.stopPropagation(); openGallery('${p.id}', ${i})">`
    )
    .join("");
  return `<div class="thumb-row">${imgs}</div>`;
}

// 把图片画到画布并等比缩放到最长边 maxSize
function drawScaled(img, maxSize) {
  let width = img.width;
  let height = img.height;
  if (Math.max(width, height) > maxSize) {
    if (width >= height) { height = Math.round((height * maxSize) / width); width = maxSize; }
    else { width = Math.round((width * maxSize) / height); height = maxSize; }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return canvas;
}

// 从一个文件，生成 { blob: 高清JPEG, thumb: 小缩略图dataURL }
function processPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("无法解码（可能是 HEIC 等浏览器不支持的格式）"));
      img.onload = () => {
        const thumb = drawScaled(img, 240).toDataURL("image/jpeg", 0.6);  // 内嵌缩略图，列表/弹窗用
        drawScaled(img, 2560).toBlob(                                      // 高清版，上传到 Drive
          (blob) => (blob ? resolve({ thumb, blob }) : reject(new Error("图片处理失败"))),
          "image/jpeg",
          0.85
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// —— 大图相册（可左右切换同一个点的多张照片）——
let galleryPhotos = [];
let galleryIndex = 0;

window.openGallery = function (placeId, startIndex) {
  const p = places.find((x) => x.id === placeId);
  if (!p) return;
  galleryPhotos = getPhotos(p);
  if (!galleryPhotos.length) return;
  galleryIndex = startIndex || 0;
  document.getElementById("lightbox").classList.add("open");
  showGalleryPhoto();
};

async function showGalleryPhoto() {
  const img = document.getElementById("lightbox-img");
  const ph = galleryPhotos[galleryIndex];
  const showNav = galleryPhotos.length > 1;
  document.getElementById("lb-prev").style.display = showNav ? "" : "none";
  document.getElementById("lb-next").style.display = showNav ? "" : "none";
  // 先用缩略图占位，再换成高清；快速切换时只在仍停留此张才替换
  img.src = ph.thumb || ""; // 先占位
  const direct = photoFullSrc(ph);
  if (direct) { img.src = direct; return; }
  if (ph.fileId) {
    // 旧的私有文件：鉴权获取（仅本人 Drive 有效；家人会回退到缩略图）
    try {
      const url = await fetchFullPhoto(ph.fileId);
      if (galleryPhotos[galleryIndex] === ph) img.src = url;
    } catch (e) {
      console.warn("载入原图失败，用缩略图显示", e);
    }
  }
}

// 大图的直接地址：公开链接 / 内嵌大图 / 公开 Drive 图
function photoFullSrc(ph) {
  if (ph.url) return ph.url;
  if (ph.full) return ph.full;
  if (ph.pub && ph.fileId) return publicPhotoUrl(ph.fileId, 2560);
  return null;
}

function galleryStep(n) {
  if (galleryPhotos.length <= 1) return;
  galleryIndex = (galleryIndex + n + galleryPhotos.length) % galleryPhotos.length;
  showGalleryPhoto();
}

function closeLightbox() {
  document.getElementById("lightbox").classList.remove("open");
}

document.getElementById("lightbox").addEventListener("click", (e) => {
  if (e.target.id === "lightbox") closeLightbox(); // 只点黑色背景才关
});
document.getElementById("lb-close").addEventListener("click", (e) => { e.stopPropagation(); closeLightbox(); });
document.getElementById("lb-prev").addEventListener("click", (e) => { e.stopPropagation(); galleryStep(-1); });
document.getElementById("lb-next").addEventListener("click", (e) => { e.stopPropagation(); galleryStep(1); });

// 手机左右滑动切换
let touchStartX = null;
const lbEl = document.getElementById("lightbox");
lbEl.addEventListener("touchstart", (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
lbEl.addEventListener("touchend", (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 40) galleryStep(dx < 0 ? 1 : -1);
  touchStartX = null;
});

// ===================== 六、渲染：地图标记 + 侧边列表 =====================
function popupHtml(p) {
  const cat = catOf(p);
  const dateLine = p.date ? `<div style="color:#64748b;font-size:12px">📅 ${p.date}</div>` : "";
  const notesLine = p.notes ? `<div style="margin-top:4px">${escapeHtml(p.notes)}</div>` : "";
  return `
    <div style="min-width:160px">
      <div style="font-weight:700;font-size:15px">${escapeHtml(p.title)}</div>
      <div style="font-size:12px;color:#64748b">${cat.emoji} ${cat.label}</div>
      ${dateLine}
      ${photoThumbsHtml(p)}
      ${notesLine}
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn" style="background:#e2e8f0;color:#334155" onclick="window.editPlace('${p.id}')">编辑</button>
        <button class="btn danger" onclick="window.deletePlace('${p.id}')">删除</button>
      </div>
    </div>`;
}

function addMarker(p) {
  const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p.category) });
  marker.bindPopup(popupHtml(p));
  clusterGroup.addLayer(marker);
  markerById.set(p.id, marker);
}

// 当前筛选下应显示的打卡点
function visiblePlaces() {
  return currentFilter ? places.filter((p) => (p.category || "other") === currentFilter) : places;
}

// 渲染顶部筛选条
function renderFilterBar() {
  const bar = document.getElementById("filter-bar");
  const chip = (key, label) =>
    `<button class="chip ${currentFilter === key ? "active" : ""}" data-key="${key || ""}">${label}</button>`;
  bar.innerHTML =
    chip(null, "全部") + CATEGORIES.map((c) => chip(c.key, `${c.emoji} ${c.label}`)).join("");
  bar.querySelectorAll(".chip").forEach((b) =>
    b.addEventListener("click", () => {
      currentFilter = b.dataset.key || null;
      renderAll();
    })
  );
}

function renderAll() {
  clusterGroup.clearLayers();
  markerById.clear();
  visiblePlaces().forEach(addMarker);
  renderFilterBar();
  renderList();
}

function renderList() {
  const listEl = document.getElementById("place-list");
  const vis = visiblePlaces();
  document.getElementById("count").textContent = currentFilter
    ? `${vis.length} / 共 ${places.length}`
    : `共 ${places.length} 个`;

  if (places.length === 0) {
    listEl.innerHTML = signedIn
      ? '<li class="empty">还没有打卡点，<br>去地图上点一下开始吧 🗺️</li>'
      : '<li class="empty">请先点右上角<br>『用 Google 登录』☁️</li>';
    return;
  }
  if (vis.length === 0) {
    listEl.innerHTML = '<li class="empty">这个分类下还没有打卡点</li>';
    return;
  }

  const sorted = [...vis].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  listEl.innerHTML = sorted
    .map(
      (p) => `
      <li class="place-card" data-id="${p.id}">
        <div class="pc-title">${escapeHtml(p.title)}</div>
        <div class="cat-badge">${catOf(p).emoji} ${catOf(p).label}</div>
        ${p.date ? `<div class="pc-date">📅 ${p.date}</div>` : ""}
        ${photoThumbsHtml(p)}
        ${p.notes ? `<div class="pc-notes">${escapeHtml(p.notes)}</div>` : ""}
        <div class="pc-actions">
          <button class="btn ghost btn-locate" style="background:#e2e8f0;color:#334155">定位</button>
          <button class="btn ghost btn-edit" style="background:#e2e8f0;color:#334155">编辑</button>
          <button class="btn danger btn-del">删除</button>
        </div>
      </li>`
    )
    .join("");

  listEl.querySelectorAll(".place-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".btn-locate").addEventListener("click", (ev) => { ev.stopPropagation(); flyTo(id); });
    card.querySelector(".btn-edit").addEventListener("click", (ev) => { ev.stopPropagation(); openEditModal(id); });
    card.querySelector(".btn-del").addEventListener("click", (ev) => { ev.stopPropagation(); deletePlace(id); });
    card.addEventListener("click", () => flyTo(id));
  });
}

function flyTo(id) {
  const p = places.find((x) => x.id === id);
  const marker = markerById.get(id);
  if (!p || !marker) return;
  // 若该点在某个聚合簇里，先展开/放大到它再弹出
  clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
}

// ===================== 七、增 / 删 =====================
function renderPhotoGrid() {
  const grid = document.getElementById("f-photo-grid");
  grid.innerHTML = pendingPhotos
    .map(
      (ph, i) => `
      <div class="ph">
        <img src="${ph.thumb}" alt="">
        <button type="button" class="ph-x" data-i="${i}">×</button>
      </div>`
    )
    .join("");
  grid.querySelectorAll(".ph-x").forEach((b) =>
    b.addEventListener("click", () => {
      pendingPhotos.splice(Number(b.dataset.i), 1);
      renderPhotoGrid();
    })
  );
}

function openModal(prefillTitle = "") {
  editingId = null;
  document.getElementById("modal-title").textContent = "新增打卡点";
  document.getElementById("f-title").value = prefillTitle;
  document.getElementById("f-notes").value = "";
  document.getElementById("f-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("f-cat").value = "sight";
  pendingPhotos = [];
  document.getElementById("f-photo").value = "";
  renderPhotoGrid();
  document.getElementById("btn-reposition").style.display = "none"; // 新增时位置由点击决定，不显示
  document.getElementById("f-coords").textContent =
    pendingLatLng ? `坐标：${pendingLatLng.lat.toFixed(4)}, ${pendingLatLng.lng.toFixed(4)}` : "";
  document.getElementById("modal").classList.add("open");
  document.getElementById("f-title").focus();
}

// 打开“编辑”弹窗：用已有打卡点的内容预填
function openEditModal(id) {
  const p = places.find((x) => x.id === id);
  if (!p) return;
  editingId = id;
  document.getElementById("modal-title").textContent = "编辑打卡点";
  document.getElementById("f-title").value = p.title || "";
  document.getElementById("f-notes").value = p.notes || "";
  document.getElementById("f-date").value = p.date || new Date().toISOString().slice(0, 10);
  document.getElementById("f-cat").value = p.category || "other";
  // 已有照片以“existing”形式进入网格，可单独删除；也可继续添加新照片
  pendingPhotos = getPhotos(p).map((ph) => ({ existing: true, thumb: ph.thumb, fileId: ph.fileId, pub: ph.pub, url: ph.url, full: ph.full }));
  document.getElementById("f-photo").value = "";
  renderPhotoGrid();
  editLatLng = { lat: p.lat, lng: p.lng };
  document.getElementById("btn-reposition").style.display = ""; // 编辑时可调整位置
  document.getElementById("f-coords").textContent = `坐标：${editLatLng.lat.toFixed(4)}, ${editLatLng.lng.toFixed(4)}`;
  document.getElementById("modal").classList.add("open");
  document.getElementById("f-title").focus();
}

// —— 调整位置（仅编辑时）——
function startReposition() {
  if (!editLatLng) return;
  repositioning = true;
  document.getElementById("modal").classList.remove("open"); // 暂时隐藏弹窗（表单内容保留）
  map.setView([editLatLng.lat, editLatLng.lng], Math.max(map.getZoom(), 6));
  repositionMarker = L.marker([editLatLng.lat, editLatLng.lng], {
    draggable: true,
    icon: pinIcon(document.getElementById("f-cat").value),
  }).addTo(map);
  document.getElementById("reposition-bar").classList.add("open");
}

function endReposition(commit) {
  if (commit && repositionMarker) {
    const ll = repositionMarker.getLatLng();
    editLatLng = { lat: ll.lat, lng: ll.lng };
    document.getElementById("f-coords").textContent = `坐标：${editLatLng.lat.toFixed(4)}, ${editLatLng.lng.toFixed(4)}`;
  }
  if (repositionMarker) { repositionMarker.remove(); repositionMarker = null; }
  document.getElementById("reposition-bar").classList.remove("open");
  repositioning = false;
  document.getElementById("modal").classList.add("open"); // 恢复弹窗（表单内容不变）
}

document.getElementById("btn-reposition").addEventListener("click", startReposition);
document.getElementById("repos-ok").addEventListener("click", () => endReposition(true));
document.getElementById("repos-cancel").addEventListener("click", () => endReposition(false));

window.editPlace = function (id) { openEditModal(id); };

function closeModal() {
  document.getElementById("modal").classList.remove("open");
  if (tempMarker) { tempMarker.remove(); tempMarker = null; }
  pendingLatLng = null;
  editingId = null;
}

// 选照片（可多张、可分多次选）
// —— HEIC 支持：浏览器不能直接解码 HEIC，先用 heic2any 转成 JPEG（按需加载）——
let heic2anyLoading = null;
function ensureHeic2any() {
  if (window.heic2any) return Promise.resolve();
  if (heic2anyLoading) return heic2anyLoading;
  heic2anyLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    s.integrity = "sha384-OTofQ0MEeiSgh62havBcemCIK0gqj809wX6UA0uPISNMRnR6NZyCdGzX3SbLrgwL";
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("加载 HEIC 解码库失败"));
    document.head.appendChild(s);
  });
  return heic2anyLoading;
}

function isHeic(file) {
  const t = (file.type || "").toLowerCase();
  const n = (file.name || "").toLowerCase();
  return t.indexOf("heic") >= 0 || t.indexOf("heif") >= 0 || n.endsWith(".heic") || n.endsWith(".heif");
}

// HEIC -> JPEG blob；非 HEIC 原样返回
async function toDecodableImage(file) {
  if (!isHeic(file)) return file;
  await ensureHeic2any();
  const out = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  return Array.isArray(out) ? out[0] : out;
}

document.getElementById("f-photo").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  for (const file of files) {
    try {
      if (isHeic(file)) setStatus(`正在转换 HEIC 照片「${file.name}」…`);
      const usable = await toDecodableImage(file);
      const { thumb, blob } = await processPhoto(usable);
      pendingPhotos.push({ thumb, blob });
    } catch (err) {
      console.warn(err);
      alert(`照片「${file.name}」读取失败：${err.message}`);
    }
  }
  setStatus(signedIn ? "已登录 · 数据存在你的 Google Drive" : "未登录");
  renderPhotoGrid();
});

document.getElementById("place-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!signedIn) { alert("请先登录。"); return; }
  const isEdit = editingId !== null;
  if (!isEdit && !pendingLatLng) return;

  const title = document.getElementById("f-title").value.trim();
  const date = document.getElementById("f-date").value;
  const notes = document.getElementById("f-notes").value.trim();
  const category = document.getElementById("f-cat").value;

  // 上传“新加的”高清图到自己 Drive（设为链接可见）；已有照片保留其字段
  const newOnes = pendingPhotos.filter((ph) => !ph.existing);
  const uploaded = [];
  if (newOnes.length) {
    setStatus(`正在上传照片 0/${newOnes.length}…`);
    try {
      for (let i = 0; i < newOnes.length; i++) {
        const fileId = await uploadPhoto(newOnes[i].blob);
        uploaded.push({ thumb: newOnes[i].thumb, fileId, pub: true });
        setStatus(`正在上传照片 ${i + 1}/${newOnes.length}…`);
      }
    } catch (err) {
      console.error(err);
      alert("上传照片失败：" + err.message);
      uploaded.forEach((u) => deletePhotoFile(u.fileId));
      updateAuthUI();
      return;
    }
  }
  let ni = 0;
  const finalPhotos = pendingPhotos.map((ph) =>
    ph.existing
      ? { thumb: ph.thumb, fileId: ph.fileId, pub: ph.pub, url: ph.url, full: ph.full }
      : uploaded[ni++]
  );

  if (isEdit) {
    // —— 编辑已有打卡点 ——
    const p = places.find((x) => x.id === editingId);
    if (!p) { closeModal(); return; }
    const backup = JSON.parse(JSON.stringify(p));
    const oldPhotos = getPhotos(p);
    p.title = title; p.date = date; p.notes = notes; p.category = category; p.photos = finalPhotos;
    if (editLatLng) { p.lat = editLatLng.lat; p.lng = editLatLng.lng; }
    setStatus("正在保存…");
    try {
      await saveToDrive();
    } catch (err) {
      Object.assign(p, backup); // 回滚
      uploaded.forEach((u) => deletePhotoFile(u.fileId));
      console.error(err);
      alert("保存失败：" + err.message);
      updateAuthUI();
      return;
    }
    updateAuthUI();
    // 删掉被移除的旧照片文件
    const keptIds = new Set(finalPhotos.filter((x) => x && x.fileId).map((x) => x.fileId));
    oldPhotos.forEach((ph) => { if (ph.fileId && !keptIds.has(ph.fileId)) deletePhotoFile(ph.fileId); });
    renderAll(); // 重画（分类变了图钉也会跟着变）
    closeModal();
    flyTo(p.id);
  } else {
    // —— 新增打卡点 ——
    const place = {
      id: makeId(),
      lat: pendingLatLng.lat,
      lng: pendingLatLng.lng,
      title, date, notes, category,
      photos: finalPhotos,
      createdAt: new Date().toISOString(),
    };
    places.push(place);
    setStatus("正在保存…");
    try {
      await saveToDrive();
    } catch (err) {
      places.pop();
      uploaded.forEach((u) => deletePhotoFile(u.fileId));
      console.error(err);
      alert("保存到 Google Drive 失败：" + err.message);
      updateAuthUI();
      return;
    }
    updateAuthUI();
    currentFilter = null; // 重置筛选，确保能看到刚加的点
    renderAll();
    closeModal();
    flyTo(place.id);
  }
});

document.getElementById("btn-cancel").addEventListener("click", closeModal);

document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

document.addEventListener("keydown", (e) => {
  const lb = document.getElementById("lightbox");
  if (lb.classList.contains("open")) {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") galleryStep(-1);
    else if (e.key === "ArrowRight") galleryStep(1);
    return;
  }
  if (e.key === "Escape") {
    if (repositioning) { endReposition(false); return; }
    if (document.getElementById("timeline-modal").classList.contains("open")) { closeTimeline(); return; }
    if (document.getElementById("stats-modal").classList.contains("open")) { closeStats(); return; }
    if (document.getElementById("modal").classList.contains("open")) closeModal();
  }
});

window.deletePlace = async function (id) {
  const p = places.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`确定删除「${p.title}」吗？`)) return;
  const backup = places.slice();
  places = places.filter((x) => x.id !== id);
  setStatus("正在保存…");
  try {
    await saveToDrive();
  } catch (err) {
    places = backup;
    console.error(err);
    alert("删除后保存失败：" + err.message);
    updateAuthUI();
    return;
  }
  updateAuthUI();
  // 顺手删掉它的照片文件（best-effort）
  getPhotos(p).forEach((ph) => { if (ph.fileId) deletePhotoFile(ph.fileId); });
  const m = markerById.get(id);
  if (m) { clusterGroup.removeLayer(m); markerById.delete(id); }
  renderList();
};

// ===================== 八、导出 / 导入备份 =====================
document.getElementById("btn-export").addEventListener("click", () => {
  if (places.length === 0) { alert("还没有数据可导出。"); return; }
  const blob = new Blob([JSON.stringify(places, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `旅行足迹备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// —— 生成一个自带数据、只读的足迹网页，分享给亲友（无需登录）——
function buildShareHtml(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c"); // 防止 </script> 截断
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN"><head><meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>旅行足迹</title>\n' +
    '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">\n' +
    '<style>html,body{height:100%;margin:0}#map{height:100%}' +
    '.pin{font-size:24px;filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))}' +
    '.lp-title{font-weight:700;font-size:15px}.lp-meta{font-size:12px;color:#64748b}' +
    '.lp-thumbs img{width:64px;height:64px;object-fit:cover;border-radius:6px;margin:4px 4px 0 0}' +
    '.credit{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;padding:4px 14px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.15);font:600 14px system-ui}' +
    '</style></head><body>\n' +
    '<div class="credit">🧭 旅行足迹</div><div id="map"></div>\n' +
    '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>\n' +
    '<script>\n' +
    'var DATA=' + json + ';\n' +
    'var map=L.map("map");\n' +
    'L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);\n' +
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +
    'var pts=[];\n' +
    'DATA.forEach(function(p){\n' +
    '  var icon=L.divIcon({className:"",html:"<div class=\\"pin\\">"+p.emoji+"</div>",iconSize:[24,24],iconAnchor:[12,22],popupAnchor:[0,-20]});\n' +
    '  var m=L.marker([p.lat,p.lng],{icon:icon}).addTo(map);\n' +
    '  var h="<div class=\\"lp-title\\">"+esc(p.title)+"</div><div class=\\"lp-meta\\">"+p.emoji+" "+esc(p.cat)+(p.date?(" · "+p.date):"")+"</div>";\n' +
    '  if(p.notes)h+="<div style=\\"margin-top:4px\\">"+esc(p.notes)+"</div>";\n' +
    '  if(p.thumbs&&p.thumbs.length){h+="<div class=\\"lp-thumbs\\">";p.thumbs.forEach(function(t){h+="<img src=\\""+t+"\\">";});h+="</div>";}\n' +
    '  m.bindPopup(h);pts.push([p.lat,p.lng]);\n' +
    '});\n' +
    'if(pts.length)map.fitBounds(pts,{padding:[40,40],maxZoom:10});else map.setView([20,0],2);\n' +
    '<\/script></body></html>';
}

function generateSharePage() {
  if (!places.length) { alert("还没有打卡点可分享。"); return; }
  const data = places.map((p) => ({
    lat: p.lat, lng: p.lng,
    title: p.title || "", date: p.date || "", notes: p.notes || "",
    emoji: catOf(p).emoji, cat: catOf(p).label,
    thumbs: getPhotos(p).map((ph) => ph.thumb).filter(Boolean),
  }));
  const blob = new Blob([buildShareHtml(data)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "我的旅行足迹.html";
  a.click();
  URL.revokeObjectURL(url);
  alert(
    "已生成『我的旅行足迹.html』。\n" +
    "这是一个自带数据、只读的网页：直接发给亲友、或放到网上都能打开，无需登录。\n" +
    "注：只包含照片缩略图，不含高清原图，也不会暴露你的 Google Drive。"
  );
}

document.getElementById("btn-share").addEventListener("click", generateSharePage);

document.getElementById("btn-import").addEventListener("click", () => {
  if (!requireSignIn()) return;
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error("格式不对");
      const existingIds = new Set(places.map((p) => p.id));
      const toAdd = imported.filter((p) => p && p.id && !existingIds.has(p.id));
      const backup = places.slice();
      places = places.concat(toAdd);
      try {
        await saveToDrive();
      } catch (err) {
        places = backup;
        alert("导入后保存到 Drive 失败：" + err.message);
        return;
      }
      renderAll();
      updateAuthUI();
      alert(`导入成功，新增 ${toAdd.length} 个打卡点。`);
    } catch (err) {
      alert("导入失败：文件格式不正确。");
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

// ===================== 九、工具：转义 =====================
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ===================== 十、统计面板 =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把两位国家码（如 cn / jp）变成国旗 emoji
function flag(cc) {
  if (!cc || cc.length !== 2) return "🌍";
  const A = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(A + up.charCodeAt(0) - 65, A + up.charCodeAt(1) - 65);
}

// 坐标 -> 地区（用 OpenStreetMap 反查；调用方需自行限速）
async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&accept-language=zh`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error("反查 HTTP " + resp.status);
  const a = (await resp.json()).address || {};
  return {
    country: a.country || null,
    countryCode: a.country_code || null,
    city: a.city || a.town || a.village || a.municipality || a.county || null,
    state: a.state || a.province || null,
  };
}

// 给缺少地区信息的点逐个补全（限速 1.1s/个），完成后存一次 Drive
async function backfillRegions(missing) {
  const body = document.getElementById("stats-body");
  let done = 0;
  let anySuccess = false;
  for (const p of missing) {
    body.innerHTML =
      `<div class="stats-progress">正在分析地区… ${done}/${missing.length}` +
      `<div class="stats-note">把坐标换成城市/国家（每秒约 1 个，首次稍慢，之后会记住）</div></div>`;
    try {
      p.region = await reverseGeocode(p.lat, p.lng);
      anySuccess = true;
    } catch (e) {
      console.warn("反查失败，跳过该点", e);
    }
    done++;
    await sleep(1100);
  }
  if (anySuccess) {
    try { await saveToDrive(); } catch (e) { console.warn("保存地区缓存失败（忽略）", e); }
  }
}

function computeStats() {
  const countryCount = {};
  const countryCode = {};
  const citySet = new Set();
  const catCount = {};
  let withRegion = 0;
  let minDate = null;
  let maxDate = null;
  places.forEach((p) => {
    const cat = p.category || "other";
    catCount[cat] = (catCount[cat] || 0) + 1;
    if (p.date) {
      if (!minDate || p.date < minDate) minDate = p.date;
      if (!maxDate || p.date > maxDate) maxDate = p.date;
    }
    if (p.region) {
      withRegion++;
      const r = p.region;
      if (r.country) {
        countryCount[r.country] = (countryCount[r.country] || 0) + 1;
        if (r.countryCode) countryCode[r.country] = r.countryCode;
      }
      if (r.city) citySet.add(r.city);
    }
  });
  return { total: places.length, countryCount, countryCode, cities: citySet.size, catCount, withRegion, minDate, maxDate };
}

function renderStatsBody() {
  const body = document.getElementById("stats-body");
  if (!signedIn) { body.innerHTML = `<div class="stats-progress">请先登录后再看统计。</div>`; return; }
  const s = computeStats();
  if (s.total === 0) {
    body.innerHTML = `<div class="stats-progress">还没有打卡点，先去地图上加几个吧 🗺️</div>`;
    return;
  }
  const countries = Object.keys(s.countryCount).sort((a, b) => s.countryCount[b] - s.countryCount[a]);
  const numCountries = countries.length;
  const pct = Math.min(100, Math.round((numCountries / 195) * 100));
  const maxCat = Math.max(1, ...Object.values(s.catCount));

  const countryList =
    countries
      .map(
        (name) =>
          `<div class="country-row"><span>${flag(s.countryCode[name])} ${escapeHtml(name)}</span><span style="color:#64748b">${s.countryCount[name]}</span></div>`
      )
      .join("") || `<div class="stats-note">还没识别出国家信息</div>`;

  const catList = CATEGORIES.filter((c) => s.catCount[c.key])
    .map((c) => {
      const n = s.catCount[c.key];
      return `<div class="cat-row"><span style="min-width:70px">${c.emoji} ${c.label}</span><span class="bar-mini"><div style="width:${Math.round((n / maxCat) * 100)}%"></div></span><span style="color:#64748b">${n}</span></div>`;
    })
    .join("");

  const unknown = s.total - s.withRegion;
  const dateSpan = s.minDate ? `${s.minDate} ～ ${s.maxDate}` : "—";

  body.innerHTML = `
    <div class="stats-grid">
      <div class="stat-box"><div class="num">${s.total}</div><div class="lbl">打卡点</div></div>
      <div class="stat-box"><div class="num">${numCountries}</div><div class="lbl">国家/地区</div></div>
      <div class="stat-box"><div class="num">${s.cities}</div><div class="lbl">城市</div></div>
    </div>
    <div class="stats-section">
      <h4>点亮世界 ${pct}%（${numCountries}/195 个国家）</h4>
      <div class="world-bar"><div style="width:${pct}%"></div></div>
    </div>
    <div class="stats-section">
      <h4>去过的国家/地区</h4>
      ${countryList}
    </div>
    <div class="stats-section">
      <h4>分类分布</h4>
      ${catList}
    </div>
    <div class="stats-section">
      <h4>时间跨度</h4>
      <div style="font-size:14px">${dateSpan}</div>
    </div>
    ${unknown > 0 ? `<div class="stats-note">注：还有 ${unknown} 个点没识别出地区（反查失败，下次打开会再试）。</div>` : ""}
  `;
}

async function openStats() {
  if (!requireSignIn()) return;
  document.getElementById("stats-modal").classList.add("open");
  renderStatsBody();
  const missing = places.filter((p) => !p.region);
  if (missing.length) {
    await backfillRegions(missing);
    renderStatsBody();
  }
}

function closeStats() {
  document.getElementById("stats-modal").classList.remove("open");
}

document.getElementById("btn-stats").addEventListener("click", openStats);
document.getElementById("btn-stats-close").addEventListener("click", closeStats);
document.getElementById("stats-modal").addEventListener("click", (e) => {
  if (e.target.id === "stats-modal") closeStats();
});

// ===================== 十一、时间轴 =====================
function tlEntryHtml(p) {
  const cat = catOf(p);
  const photos = getPhotos(p);
  const thumb = photos.length ? `<img src="${photos[0].thumb}" alt="">` : "";
  return `<div class="tl-entry" data-id="${p.id}">
    <span class="tl-date">${p.date || "—"}</span>
    ${thumb}
    <span class="tl-title">${cat.emoji} ${escapeHtml(p.title)}</span>
  </div>`;
}

function renderTimeline() {
  const body = document.getElementById("timeline-body");
  if (!signedIn) { body.innerHTML = `<div class="stats-progress">请先登录后再看时间轴。</div>`; return; }
  if (places.length === 0) { body.innerHTML = `<div class="stats-progress">还没有打卡点 🗺️</div>`; return; }

  const withDate = places.filter((p) => p.date).sort((a, b) => a.date.localeCompare(b.date));
  const noDate = places.filter((p) => !p.date);
  const groups = {};
  withDate.forEach((p) => { const y = p.date.slice(0, 4); (groups[y] = groups[y] || []).push(p); });

  let html = "";
  Object.keys(groups).sort().forEach((y) => {
    html += `<div class="timeline-year">${y}</div>` + groups[y].map(tlEntryHtml).join("");
  });
  if (noDate.length) html += `<div class="timeline-year">未注明日期</div>` + noDate.map(tlEntryHtml).join("");
  body.innerHTML = html;

  body.querySelectorAll(".tl-entry").forEach((el) =>
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      closeTimeline();
      currentFilter = null; // 取消筛选，确保能定位到
      renderAll();
      flyTo(id);
    })
  );
}

function openTimeline() {
  if (!requireSignIn()) return;
  document.getElementById("timeline-modal").classList.add("open");
  renderTimeline();
}
function closeTimeline() {
  document.getElementById("timeline-modal").classList.remove("open");
}

document.getElementById("btn-timeline").addEventListener("click", openTimeline);
document.getElementById("btn-timeline-close").addEventListener("click", closeTimeline);
document.getElementById("timeline-modal").addEventListener("click", (e) => {
  if (e.target.id === "timeline-modal") closeTimeline();
});

// ===================== 启动 =====================
// 填充分类下拉选项
document.getElementById("f-cat").innerHTML = CATEGORIES.map(
  (c) => `<option value="${c.key}">${c.emoji} ${c.label}</option>`
).join("");

renderAll();
restoreSession();   // 有本地有效令牌就直接恢复登录（约 1 小时内免重新点）
whenGisReady(initAuth);
