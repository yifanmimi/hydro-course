/**
 * 水利技師六科系統課程：後台 API（Google Apps Script）
 * 前台在 GitHub Pages，使用者用 Google 帳號登入，前台把登入憑證送來這裡驗證。
 *
 * 白名單：試算表「水利課程白名單」（第一次執行 setup 自動建立）
 *   - A 欄帳號、B 欄「觀看」或「管理」、C 欄備註
 *   - 部署者本人永遠是管理；不在表上的帳號 → 拒絕
 *   - 也可以在網頁的「管理」直接新增、修改、移除
 *
 * 影片：放在課程資料夾（ROOT_ID）底下
 *   _影片分段/<代碼>/part00.bin, part01.bin ...（每段 3MB 以下，分段式 mp4 依序接起來就是完整影片）
 *   _影片目錄/<代碼>.json  {code, parts:[檔案id...], mime, size, minutes, handout:講義PDF檔案id, name}
 *   影片備份/<名稱>.mp4   由 mergeBackups 自動把分段合併成完整影片（每小時執行）
 * 觀看進度：存在指令碼屬性，每個帳號一筆。
 *
 * 部署：執行身分「我」，存取權「所有人」
 * 指令碼屬性：CLIENT_ID（必填）、ROOT_ID（課程資料夾 id，setup 會自動填預設值）
 */

const DEFAULT_ROOT_ID = '1XNElH8kTvjqaWYYNfazk7O2QXQgc1MeW';
const ACL_NAME = '水利課程白名單';
const ROLE_LABEL = { view: '觀看', admin: '管理' };
const props = PropertiesService.getScriptProperties();
const cache = CacheService.getScriptCache();

/** 在編輯器執行一次：建立資料夾、白名單、每小時合併備份的觸發器 */
function setup() {
  if (!props.getProperty('ROOT_ID')) props.setProperty('ROOT_ID', DEFAULT_ROOT_ID);
  ['_影片分段', '_影片目錄', '影片備份'].forEach(sub_);
  Logger.log('課程資料夾：' + root_().getUrl());
  Logger.log('白名單：' + aclSheet_().getParent().getUrl());
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'mergeBackups'))
    ScriptApp.newTrigger('mergeBackups').timeBased().everyHours(1).create();
  if (!props.getProperty('CLIENT_ID')) Logger.log('還沒設定指令碼屬性 CLIENT_ID');
  Logger.log('目前可播放：' + Object.keys(catalog_(true)).join(', '));
}

function doGet() {
  return json_({ ok: true, message: '水利技師課程 API 運作中' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const email = verify_(req.token);
    const role = role_(email);
    if (!role) return json_({ error: 'NO_ACCESS', email: email, message: email + ' 不在觀看名單上，請聯絡課程管理者。' });
    const needAdmin = () => { if (role !== 'admin') throw new Error('只有管理者可以使用這個功能。'); };
    switch (req.action) {
      case 'init': return json_({ email: email, role: role, catalog: publicCatalog_(), progress: progressGet_(email) });
      case 'part': return json_(part_(req.code, Number(req.i)));
      case 'handout': return json_(handout_(req.code));
      case 'save': return json_(progressSave_(email, req.code, req.t, req.d, req.done));
      case 'aclList': needAdmin(); return json_(aclList_());
      case 'aclSet': needAdmin(); if (String(req.email).toLowerCase() === email && req.role !== 'admin') throw new Error('不能降低自己的權限。'); return json_(aclSet_(req.email, req.role, req.note));
      case 'aclRemove': needAdmin(); return json_(aclRemove_(req.email, email));
      default: throw new Error('未知的動作');
    }
  } catch (err) {
    return json_({ error: err.code || 'ERROR', message: String(err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, msg) { const e = new Error(msg); e.code = code; throw e; }

/** 驗證 Google 登入憑證，回傳 email */
function verify_(token) {
  if (!token) fail_('TOKEN', '請先登入');
  const clientId = props.getProperty('CLIENT_ID');
  if (!clientId) fail_('SETUP', '後台尚未設定 CLIENT_ID');
  const key = 'tk_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail_('TOKEN', '登入已過期');
  const info = JSON.parse(res.getContentText());
  const okIss = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== clientId || !okIss || String(info.email_verified) !== 'true' || Number(info.exp) * 1000 < Date.now())
    fail_('TOKEN', '登入憑證無效');
  const email = String(info.email).toLowerCase();
  const ttl = Math.max(1, Math.min(1800, Number(info.exp) - Math.floor(Date.now() / 1000) - 30));
  cache.put(key, email, ttl);
  return email;
}

// ---------- 資料夾 ----------
function root_() { return DriveApp.getFolderById(props.getProperty('ROOT_ID') || DEFAULT_ROOT_ID); }
function sub_(name) {
  const key = 'DIR_' + name;
  const id = props.getProperty(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = root_().getFoldersByName(name);
  const f = it.hasNext() ? it.next() : root_().createFolder(name);
  props.setProperty(key, f.getId());
  return f;
}

// ---------- 影片目錄 ----------
/** 讀出所有 <代碼>.json（快取 10 分鐘）。force=true 重新讀 */
function catalog_(force) {
  if (!force) {
    const hit = cache.get('catalog');
    if (hit) return JSON.parse(hit);
  }
  const out = {};
  const it = sub_('_影片目錄').getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.json$/.test(f.getName())) continue;
    try {
      const m = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      if (m.code && m.parts && m.parts.length) out[m.code] = m;
    } catch (e) {}
  }
  try { cache.put('catalog', JSON.stringify(out), 600); } catch (e) {}
  return out;
}
function publicCatalog_() {
  const c = catalog_(), o = {};
  Object.keys(c).forEach(k => { const m = c[k]; o[k] = { n: m.parts.length, mime: m.mime, size: m.size, minutes: m.minutes, handout: !!m.handout }; });
  return o;
}
function entry_(code) {
  let m = catalog_()[code];
  if (!m) m = catalog_(true)[code];
  if (!m) throw new Error('這一集還沒上架');
  return m;
}
function part_(code, i) {
  const m = entry_(code);
  if (!(i >= 0 && i < m.parts.length)) throw new Error('分段編號錯誤');
  const bytes = DriveApp.getFileById(m.parts[i]).getBlob().getBytes();
  return { code: code, i: i, n: m.parts.length, b64: Utilities.base64Encode(bytes) };
}
function handout_(code) {
  const m = entry_(code);
  if (!m.handout) throw new Error('這一集的講義還沒上架');
  const f = DriveApp.getFileById(m.handout);
  return { name: f.getName(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
}
/** 新上架的影片放進目錄後，在編輯器執行一次可以立刻生效（不然最多等 10 分鐘） */
function refreshCatalog() { Logger.log(Object.keys(catalog_(true)).join(', ')); }

// ---------- 觀看進度 ----------
// 每個帳號一筆：{ e: { 代碼: [秒數, 長度, 看完0/1, 時間戳] }, last: 代碼 }
function progressGet_(email) {
  const s = props.getProperty('P_' + email);
  return s ? JSON.parse(s) : { e: {}, last: null };
}
function progressSave_(email, code, t, d, done) {
  if (!/^[a-z]{3}\d{2}$/.test(String(code))) throw new Error('代碼錯誤');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const p = progressGet_(email);
    p.e[code] = [Math.max(0, Math.floor(Number(t) || 0)), Math.max(0, Math.floor(Number(d) || 0)), done ? 1 : 0, Date.now()];
    p.last = code;
    props.setProperty('P_' + email, JSON.stringify(p));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// ---------- 白名單 ----------
function owner_() { return String(Session.getEffectiveUser().getEmail()).toLowerCase(); }

function aclSheet_() {
  let id = props.getProperty('ACL_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id).getSheets()[0]; } catch (e) {}
  }
  const ss = SpreadsheetApp.create(ACL_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(root_());
  const sh = ss.getSheets()[0];
  sh.setName('白名單');
  sh.getRange(1, 1, 1, 3).setValues([['帳號', '權限', '備註']]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 260); sh.setColumnWidth(3, 240);
  sh.getRange('B2:B').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['觀看', '管理'], true).build());
  sh.appendRow([owner_(), '管理', '擁有者']);
  props.setProperty('ACL_ID', ss.getId());
  return sh;
}

function aclRows_() {
  const hit = cache.get('acl');
  if (hit) return JSON.parse(hit);
  const sh = aclSheet_();
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 3).getValues() : [];
  const out = rows
    .map(r => ({ email: String(r[0]).trim().toLowerCase(), role: String(r[1]).trim() === '管理' ? 'admin' : (String(r[1]).trim() === '觀看' ? 'view' : ''), note: String(r[2] || '') }))
    .filter(r => r.email && r.role);
  cache.put('acl', JSON.stringify(out), 300);
  return out;
}

function role_(email) {
  if (email === owner_()) return 'admin';
  const r = aclRows_().find(x => x.email === email);
  return r ? r.role : null;
}

function aclList_() {
  return { owner: owner_(), rows: aclRows_(), sheetUrl: aclSheet_().getParent().getUrl() };
}

function aclSet_(email, role, note) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email 格式不正確');
  if (!ROLE_LABEL[role]) throw new Error('權限只能是觀看或管理');
  const sh = aclSheet_();
  const n = sh.getLastRow() - 1;
  const emails = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim().toLowerCase()) : [];
  const idx = emails.indexOf(email);
  if (idx >= 0) sh.getRange(idx + 2, 2, 1, 2).setValues([[ROLE_LABEL[role], note || '']]);
  else sh.appendRow([email, ROLE_LABEL[role], note || '']);
  cache.remove('acl');
  return aclList_();
}

function aclRemove_(email, me) {
  email = String(email || '').trim().toLowerCase();
  if (email === me || email === owner_()) throw new Error('不能移除自己或擁有者。');
  const sh = aclSheet_();
  const n = sh.getLastRow() - 1;
  const emails = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim().toLowerCase()) : [];
  const idx = emails.indexOf(email);
  if (idx >= 0) sh.deleteRow(idx + 2);
  cache.remove('acl');
  return aclList_();
}

/** 權限有 5 分鐘快取，想立刻生效可執行這個 */
function clearAccessCache() { cache.remove('acl'); }

// ---------- 合併成完整影片備份（每小時自動執行） ----------
function mergeBackups() {
  const c = catalog_(true);
  const dir = sub_('影片備份');
  const start = Date.now();
  Object.keys(c).sort().forEach(code => {
    if (Date.now() - start > 4 * 60 * 1000) return;   // 一次最多跑 4 分鐘，其餘下次再做
    const m = c[code];
    const key = 'BK_' + code;
    if (props.getProperty(key) === String(m.parts.length) + ':' + m.parts[0]) return;
    const name = (m.name || code) + '.mp4';
    const old = dir.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);
    uploadResumable_(dir.getId(), name, m.parts);
    props.setProperty(key, String(m.parts.length) + ':' + m.parts[0]);
  });
}

/** 用 Drive API 續傳上傳，一段一段送，不用把整部影片放進記憶體 */
function uploadResumable_(parentId, name, partIds) {
  const tok = ScriptApp.getOAuthToken();
  const sizes = partIds.map(id => DriveApp.getFileById(id).getSize());
  const total = sizes.reduce((a, b) => a + b, 0);
  const init = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post', contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + tok, 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(total) },
    payload: JSON.stringify({ name: name, parents: [parentId], mimeType: 'video/mp4' })
  });
  const url = init.getHeaders()['Location'] || init.getHeaders()['location'];
  let off = 0;
  partIds.forEach((id, i) => {
    const bytes = DriveApp.getFileById(id).getBlob().getBytes();
    const end = off + bytes.length - 1;
    const r = UrlFetchApp.fetch(url, {
      method: 'put', contentType: 'video/mp4', payload: bytes, muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Range': 'bytes ' + off + '-' + end + '/' + total }
    });
    const code = r.getResponseCode();
    if (!(code === 308 || code === 200 || code === 201)) throw new Error('備份上傳失敗：' + code + ' ' + r.getContentText());
    off = end + 1;
  });
}
