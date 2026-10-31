/**
 * ระบบภาพกิจกรรม โรงเรียนเบญจมราชรังสฤษฎิ์ ๒ — ส่วนหลังบ้าน (Google Apps Script, JSON API)
 *
 * หน้าเว็บอยู่บน GitHub Pages แล้วเรียก API นี้ด้วย fetch (POST, body เป็น JSON แบบ text/plain)
 *
 * โครงสร้าง Drive (ในบัญชีที่ Deploy เช่น picture@ben2.ac.th):
 *   ROOT_FOLDER_ID/
 *     2569-10-26 ประชุมครู.../   ← 1 โฟลเดอร์ = 1 กิจกรรม (มีโฟลเดอร์ย่อยข้างในได้)
 *     _face_index/               ← ระบบสร้างเอง: ดัชนีใบหน้า + optout.json (ห้ามแชร์)
 *
 * สิทธิ์
 *   ทุกคน        ดูรายการกิจกรรม ดูรูป ค้นหาด้วยใบหน้า ขอไม่ให้ค้นเจอหน้า
 *   ผู้อัปโหลด    ชื่อ + PIN (ผู้ดูแลเพิ่มให้ในหน้าแอดมิน) สร้างกิจกรรม อัปโหลดรูป
 *   ผู้ดูแล       รหัสผ่านผู้ดูแล (ตั้งครั้งแรกในหน้าแอดมิน) ทำดัชนี จัดการผู้อัปโหลดและคำขอ
 *
 * Deploy: การทำให้ใช้งานได้ → เว็บแอป → เรียกใช้ในฐานะ: ฉัน · ผู้มีสิทธิ์เข้าถึง: ทุกคน
 */

const PROPS = PropertiesService.getScriptProperties();
const INDEX_FOLDER_NAME = '_face_index';
const Q = 200;                 // ตัวคูณแปลงค่าใบหน้า (float) เป็น int8 — ต้องตรงกับหน้าเว็บ
const MAX_RESULTS = 300;
const OPTOUT_FILE = 'optout.json';
const OPTOUT_THR = 0.55;
const OPTOUT_MAX = 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const LOGIN_MAX_FAIL = 8;      // ผิดเกินนี้ใน 15 นาที → ล็อกชั่วคราว

/* ======================= ทางเข้า ======================= */

function doGet() {
  return json_({ ok: true, name: 'BEN2 Activity Photos API' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง' }); }
  const fn = API[req && req.action];
  if (!fn) return json_({ ok: false, error: 'ไม่รู้จักคำสั่งนี้' });
  try {
    return json_({ ok: true, data: fn(req) });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

const API = {
  /* ---- ทุกคน ---- */
  events:   r => listEvents_(),
  albums:   r => listAlbums_(),
  photos:   r => listPhotos_(r.eventId),
  image:    r => getImage_(r.id, r.size),
  search:   r => search_(r.desc, r.threshold, r.eventId),
  optout:   r => requestOptOut_(r.desc),
  uploaders: r => listUploaders_().map(u => u.name),

  /* ---- ผู้อัปโหลด (หรือผู้ดูแล) ---- */
  uploaderLogin: r => ({ name: requireUploader_(r) }),
  createEvent:   r => { requireUploader_(r); return createEvent_(r.date, r.title); },
  upload:        r => { const who = requireUploader_(r); return uploadPhoto_(r, who); },

  /* ---- ผู้ดูแล ---- */
  adminStatus:   r => ({ hasPassword: !!PROPS.getProperty('ADMIN_HASH') }),
  adminSetup:    r => setupAdminPassword_(r.newPassword),
  adminLogin:    r => { requireAdmin_(r); return true; },
  adminPassword: r => { requireAdmin_(r); return setAdminPassword_(r.newPassword); },
  adminEvents:   r => { requireAdmin_(r); return adminListEvents_(); },
  adminPending:  r => { requireAdmin_(r); return adminPending_(r.eventId); },
  adminSaveBatch: r => { requireAdmin_(r); return saveFaces_(r.eventId, r.entries); },
  adminResetIndex: r => { requireAdmin_(r); return resetIndex_(r.eventId); },
  adminOptOuts:  r => { requireAdmin_(r); return readOptOut_().data.entries.map((e, i) => ({ i: i, at: e.at })); },
  adminRemoveOptOut: r => { requireAdmin_(r); return removeOptOut_(r.at); },
  adminShareStatus: r => { requireAdmin_(r); return shareStatus_(); },
  adminSetGithubToken: r => { requireAdmin_(r); return setGithubToken_(r.token); },
  adminPublishShare: r => { requireAdmin_(r); return publishShare_(String(r.eventId || '')); },
  adminUploaders: r => { requireAdmin_(r); return listUploaders_().map(u => ({ name: u.name, at: u.at || '' })); },
  adminSetUploader: r => { requireAdmin_(r); return setUploader_(r.name, r.pin); },
  adminRemoveUploader: r => { requireAdmin_(r); return removeUploader_(r.name); },
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================= รหัสผ่าน / PIN ======================= */

function salt_() {
  let s = PROPS.getProperty('SALT');
  if (!s) { s = Utilities.getUuid(); PROPS.setProperty('SALT', s); }
  return s;
}

function hash_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt_() + '|' + String(text), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

/** กันเดารหัส: นับครั้งที่ผิดต่อกุญแจ (ผู้ดูแล / ชื่อผู้อัปโหลด) */
function guard_(key, ok) {
  const cache = CacheService.getScriptCache();
  const k = 'fail_' + Utilities.base64EncodeWebSafe(key).slice(0, 200);
  const n = Number(cache.get(k) || 0);
  if (n >= LOGIN_MAX_FAIL) throw new Error('ใส่รหัสผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่');
  if (!ok) {
    cache.put(k, String(n + 1), 900);
    Utilities.sleep(1200);
    return false;
  }
  return true;
}

function checkPassword_(pw) {
  if (!pw) throw new Error('กรุณาใส่รหัสผ่าน');
  const h = PROPS.getProperty('ADMIN_HASH');
  if (!h) throw new Error('ยังไม่ได้ตั้งรหัสผ่านผู้ดูแล');
  return guard_('admin', hash_(pw) === h);
}

function requireAdmin_(r) {
  if (!checkPassword_(r.password)) throw new Error('รหัสผ่านผู้ดูแลไม่ถูกต้อง');
}

function validNewPassword_(p) {
  p = String(p || '');
  if (p.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  return p;
}

function setupAdminPassword_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (PROPS.getProperty('ADMIN_HASH')) throw new Error('ตั้งรหัสผ่านไปแล้ว');
    PROPS.setProperty('ADMIN_HASH', hash_(validNewPassword_(p)));
    return true;
  } finally { lock.releaseLock(); }
}

function setAdminPassword_(p) {
  PROPS.setProperty('ADMIN_HASH', hash_(validNewPassword_(p)));
  return true;
}

function listUploaders_() {
  return JSON.parse(PROPS.getProperty('UPLOADERS') || '[]');
}

function setUploader_(name, pin) {
  name = String(name || '').trim();
  pin = String(pin || '').trim();
  if (!name) throw new Error('กรุณาใส่ชื่อ');
  if (!/^\d{6,}$/.test(pin)) throw new Error('PIN ต้องเป็นตัวเลขอย่างน้อย 6 หลัก');
  const list = listUploaders_().filter(u => u.name !== name);
  list.push({ name: name, h: hash_('pin|' + pin), at: new Date().toISOString() });
  list.sort((a, b) => a.name.localeCompare(b.name, 'th'));
  PROPS.setProperty('UPLOADERS', JSON.stringify(list));
  return true;
}

function removeUploader_(name) {
  PROPS.setProperty('UPLOADERS', JSON.stringify(listUploaders_().filter(u => u.name !== name)));
  return true;
}

/** คืนชื่อผู้อัปโหลด — ผ่านด้วย ชื่อ+PIN หรือรหัสผ่านผู้ดูแล */
function requireUploader_(r) {
  if (r.password) { requireAdmin_(r); return 'ผู้ดูแล'; }
  const name = String(r.uploader || '');
  const u = listUploaders_().find(x => x.name === name);
  const ok = !!u && u.h === hash_('pin|' + String(r.pin || ''));
  if (!guard_('up|' + name, ok)) throw new Error('ชื่อหรือ PIN ไม่ถูกต้อง');
  return u.name;
}

/* ======================= โฟลเดอร์ ======================= */

function rootId_() {
  const id = PROPS.getProperty('ROOT_FOLDER_ID');
  if (!id) throw new Error('ยังไม่ได้ตั้งค่า ROOT_FOLDER_ID');
  return id;
}

function indexFolder_() {
  const root = DriveApp.getFolderById(rootId_());
  const it = root.getFoldersByName(INDEX_FOLDER_NAME);
  return it.hasNext() ? it.next() : root.createFolder(INDEX_FOLDER_NAME);
}

/** กิจกรรม = โฟลเดอร์ย่อยชั้นแรกของโฟลเดอร์หลัก (แคช 10 นาที) */
function listEvents_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('events');
  if (hit) return JSON.parse(hit);
  const out = [];
  const it = DriveApp.getFolderById(rootId_()).getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName() === INDEX_FOLDER_NAME) continue;
    out.push({ id: f.getId(), name: f.getName() });
  }
  out.sort((a, b) => b.name.localeCompare(a.name, 'th'));
  cache.put('events', JSON.stringify(out), 600);
  return out;
}

function clearEventsCache_() { CacheService.getScriptCache().remove('events'); }

function assertEvent_(id) {
  const ev = listEvents_().find(e => e.id === id);
  if (!ev) throw new Error('ไม่พบกิจกรรมนี้');
  return ev;
}

/** ขอได้เฉพาะไฟล์ที่อยู่ใต้โฟลเดอร์หลัก (และไม่ใช่ในโฟลเดอร์ดัชนี) */
function assertInRoot_(fileId) {
  const cache = CacheService.getScriptCache();
  if (cache.get('ok_' + fileId)) return;
  const rootId = rootId_();
  let queue = [];
  const ps = DriveApp.getFileById(fileId).getParents();
  while (ps.hasNext()) queue.push(ps.next());
  for (let depth = 0; depth < 6 && queue.length; depth++) {
    const next = [];
    for (const p of queue) {
      if (p.getName() === INDEX_FOLDER_NAME) continue;
      if (p.getId() === rootId) { cache.put('ok_' + fileId, '1', 21600); return; }
      const pp = p.getParents();
      while (pp.hasNext()) next.push(pp.next());
    }
    queue = next;
  }
  throw new Error('ไม่พบรูปนี้ในคลังภาพกิจกรรม');
}

function listImages_(folder, out) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if ((f.getMimeType() || '').indexOf('image/') === 0) out.push({ id: f.getId(), name: f.getName() });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) listImages_(subs.next(), out);
  return out;
}

function listPhotos_(eventId) {
  assertEvent_(eventId);
  const cache = CacheService.getScriptCache();
  const hit = cache.get('ph_' + eventId);
  if (hit) return JSON.parse(hit);
  const list = listImages_(DriveApp.getFolderById(eventId), []);
  list.sort((a, b) => a.name.localeCompare(b.name));
  try { cache.put('ph_' + eventId, JSON.stringify(list), 300); } catch (e) {}
  return list;
}

/** จำนวนรูป + รูปปก (รูปแรกตามชื่อไฟล์) ของกิจกรรม — แคช 6 ชั่วโมง ล้างเมื่อมีการอัปโหลด */
function summary_(eventId) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sum_' + eventId);
  if (hit) return JSON.parse(hit);
  let count = 0, cover = '', coverName = null;
  const stack = [eventId];
  while (stack.length) {
    const fid = stack.pop();
    let token;
    do {
      const res = Drive.Files.list({
        q: "'" + fid + "' in parents and trashed = false and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')",
        fields: 'nextPageToken, files(id, name, mimeType)', pageSize: 1000, pageToken: token,
        supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      for (const f of res.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') stack.push(f.id);
        else { count++; if (coverName === null || f.name < coverName) { coverName = f.name; cover = f.id; } }
      }
      token = res.nextPageToken;
    } while (token);
  }
  const out = { count: count, cover: cover };
  cache.put('sum_' + eventId, JSON.stringify(out), 21600);
  return out;
}

/** รูปเป็น data URL ตามขนาดด้านยาว 100–2048 px */
function getImage_(id, size) {
  id = String(id || '');
  assertInRoot_(id);
  size = Math.max(100, Math.min(2048, Number(size) || 400));
  const meta = Drive.Files.get(id, { fields: 'thumbnailLink', supportsAllDrives: true });
  if (meta.thumbnailLink) {
    const link = meta.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, '=s' + size);
    const res = UrlFetchApp.fetch(link, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      const b = res.getBlob();
      return 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(b.getBytes());
    }
  }
  const blob = DriveApp.getFileById(id).getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > 8 * 1024 * 1024) throw new Error('รูปนี้ยังไม่มีภาพย่อ ลองใหม่ภายหลัง');
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(bytes);
}

/* ======================= อัปโหลด ======================= */

function cleanName_(s, max) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max || 120);
}

/** สร้างโฟลเดอร์กิจกรรม "ปปปป-ดด-วว ชื่อ" (พ.ศ.) ถ้ามีชื่อเดียวกันอยู่แล้วจะใช้โฟลเดอร์เดิม */
function createEvent_(date, title) {
  if (!/^25\d\d-\d\d-\d\d$/.test(String(date || ''))) throw new Error('วันที่ไม่ถูกต้อง');
  title = cleanName_(title, 150);
  if (!title) throw new Error('กรุณาใส่ชื่อกิจกรรม');
  const name = date + ' ' + title;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const root = DriveApp.getFolderById(rootId_());
    const it = root.getFoldersByName(name);
    const f = it.hasNext() ? it.next() : root.createFolder(name);
    clearEventsCache_();
    return { id: f.getId(), name: name };
  } finally { lock.releaseLock(); }
}

/**
 * r: { eventId, name, mime, data(base64), faces:[{d,b}] }
 * ข้ามถ้ามีไฟล์ชื่อเดียวกันในกิจกรรมแล้ว (อัปโหลดซ้ำ/ต่อจากที่ค้างได้)
 */
function uploadPhoto_(r, who) {
  const ev = assertEvent_(String(r.eventId || ''));
  const mime = String(r.mime || '');
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mime)) throw new Error('รองรับเฉพาะไฟล์รูป JPG / PNG / WEBP / HEIC');
  const name = cleanName_(r.name, 150) || ('photo-' + Date.now() + '.jpg');
  const folder = DriveApp.getFolderById(ev.id);
  const same = folder.getFilesByName(name);
  if (same.hasNext()) {
    const f = same.next();
    return { id: f.getId(), skipped: true };
  }
  const bytes = Utilities.base64Decode(String(r.data || ''));
  if (!bytes.length) throw new Error('ไฟล์ว่าง');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('ไฟล์ใหญ่เกิน 25 MB');
  const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription('อัปโหลดโดย ' + who + ' · ' + new Date().toISOString());
  CacheService.getScriptCache().removeAll(['ph_' + ev.id, 'sum_' + ev.id]);
  let filtered = 0;
  if (Array.isArray(r.faces)) filtered = saveFaces_(ev.id, [{ id: file.getId(), name: name, faces: r.faces }]).filtered;
  // อัลบั้มที่ยังไม่มีหน้าแชร์ LINE → สร้างให้อัตโนมัติจากรูปแรก
  if (PROPS.getProperty('GITHUB_TOKEN') && !PROPS.getProperty('SH_' + ev.id)) {
    try { publishShare_(ev.id); } catch (e) { console.warn('publishShare: ' + e); }
  }
  return { id: file.getId(), skipped: false, filtered: filtered };
}

/* ======================= ดัชนีใบหน้า ======================= */

function indexName_(eventId) { return 'idx_' + eventId + '.json'; }

function readIndex_(eventId) {
  const it = indexFolder_().getFilesByName(indexName_(eventId));
  if (!it.hasNext()) return null;
  const file = it.next();
  return { file: file, data: JSON.parse(file.getBlob().getDataAsString()) };
}

function writeIndex_(eventId, data, file) {
  const blob = Utilities.newBlob(JSON.stringify(data), 'application/json', indexName_(eventId));
  if (file) Drive.Files.update({}, file.getId(), blob);
  else indexFolder_().createFile(blob);
}

function validDesc_(desc) {
  return Array.isArray(desc) && desc.length === 128 && desc.every(v => typeof v === 'number' && isFinite(v));
}

function toInt8_(desc) {
  return desc.map(v => Math.max(-127, Math.min(127, Math.round(v * Q))));
}

function dist2_(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

const OPTOUT_T2 = OPTOUT_THR * OPTOUT_THR * Q * Q;

function validFace_(f) {
  return f && typeof f.d === 'string' && f.d.length <= 200 && Array.isArray(f.b) && f.b.length === 4;
}

/** entries: [{id, name, faces:[{d: base64 int8[128], b:[x,y,w,h] 0–1]}]} */
function saveFaces_(eventId, entries) {
  const ev = assertEvent_(String(eventId || ''));
  if (!Array.isArray(entries)) throw new Error('ข้อมูลไม่ถูกต้อง');
  const vecs = optOutVectors_();
  let filtered = 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const idx = readIndex_(ev.id);
    const data = idx ? idx.data : { v: 1, folderId: ev.id, folderName: ev.name, photos: {} };
    for (const e of entries) {
      const faces = (e.faces || []).filter(validFace_)
        .map(f => ({ d: f.d, b: f.b.map(Number) }))
        .filter(f => {
          const keep = !isOptedOut_(Utilities.base64Decode(f.d), vecs);
          if (!keep) filtered++;
          return keep;
        });
      data.photos[String(e.id)] = { n: cleanName_(e.name, 150), f: faces };
    }
    data.folderName = ev.name;
    data.updated = new Date().toISOString();
    writeIndex_(ev.id, data, idx && idx.file);
    return { total: Object.keys(data.photos).length, filtered: filtered };
  } finally { lock.releaseLock(); }
}

function adminListEvents_() {
  clearEventsCache_();
  return listEvents_().map(ev => {
    const idx = readIndex_(ev.id);
    let photos = 0, faces = 0;
    if (idx) {
      const p = idx.data.photos || {};
      photos = Object.keys(p).length;
      for (const k in p) faces += p[k].f.length;
    }
    return { id: ev.id, name: ev.name, indexed: photos, faces: faces, updated: idx ? idx.data.updated : '' };
  });
}

/** รูปที่ยังไม่มีในดัชนี + ลบรายการของรูปที่ไม่อยู่ในโฟลเดอร์แล้ว */
function adminPending_(eventId) {
  const ev = assertEvent_(String(eventId || ''));
  CacheService.getScriptCache().removeAll(['ph_' + ev.id, 'sum_' + ev.id]);
  const imgs = listImages_(DriveApp.getFolderById(ev.id), []);
  const ids = new Set(imgs.map(x => x.id));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const idx = readIndex_(ev.id);
    const have = idx ? (idx.data.photos || {}) : {};
    let pruned = 0;
    for (const k of Object.keys(have)) if (!ids.has(k)) { delete have[k]; pruned++; }
    if (idx && pruned) { idx.data.updated = new Date().toISOString(); writeIndex_(ev.id, idx.data, idx.file); }
    return { total: imgs.length, pruned: pruned, pending: imgs.filter(x => !have[x.id]) };
  } finally { lock.releaseLock(); }
}

function resetIndex_(eventId) {
  const ev = assertEvent_(String(eventId || ''));
  const idx = readIndex_(ev.id);
  if (idx) idx.file.setTrashed(true);
  return true;
}

/* ======================= ค้นหา ======================= */

function search_(desc, threshold, eventId) {
  if (!validDesc_(desc)) throw new Error('ข้อมูลใบหน้าไม่ถูกต้อง');
  if (isOptedOut_(toInt8_(desc), optOutVectors_())) return { blocked: true, results: [] };
  const thr = Math.max(0.3, Math.min(0.6, Number(threshold) || 0.5));
  const thr2 = thr * thr * Q * Q;
  const q = desc.map(v => v * Q);

  const events = listEvents_();
  const names = {};
  events.forEach(e => names[e.id] = e.name);
  const targets = eventId ? [assertEvent_(String(eventId)).id] : events.map(e => e.id);

  const results = [];
  for (const evId of targets) {
    const idx = readIndex_(evId);
    if (!idx) continue;
    const photos = idx.data.photos || {};
    for (const pid in photos) {
      let best = Infinity;
      for (const face of photos[pid].f) {
        const v = Utilities.base64Decode(face.d);
        let s = 0;
        for (let i = 0; i < 128; i++) { const d = q[i] - v[i]; s += d * d; if (s > best) break; }
        if (s < best) best = s;
      }
      if (best <= thr2) {
        results.push({ id: pid, name: photos[pid].n, eventId: evId, eventName: names[evId] || '',
                       dist: Math.round(Math.sqrt(best) / Q * 1000) / 1000 });
      }
    }
  }
  results.sort((a, b) => a.dist - b.dist);
  return { blocked: false, results: results.slice(0, MAX_RESULTS) };
}

/* ======================= ขอไม่ให้ค้นเจอหน้า ======================= */

function readOptOut_() {
  const it = indexFolder_().getFilesByName(OPTOUT_FILE);
  if (!it.hasNext()) return { file: null, data: { entries: [] } };
  const file = it.next();
  return { file: file, data: JSON.parse(file.getBlob().getDataAsString()) };
}

function writeOptOut_(data, file) {
  const blob = Utilities.newBlob(JSON.stringify(data), 'application/json', OPTOUT_FILE);
  if (file) Drive.Files.update({}, file.getId(), blob);
  else indexFolder_().createFile(blob);
}

function optOutVectors_() {
  return readOptOut_().data.entries.map(e => Utilities.base64Decode(e.d));
}

function isOptedOut_(v, vecs) {
  for (const o of vecs) if (dist2_(v, o) <= OPTOUT_T2) return true;
  return false;
}

/** บันทึกค่าใบหน้าที่ขอ แล้วลบใบหน้าที่ตรงกันออกจากดัชนีทุกกิจกรรม */
function requestOptOut_(desc) {
  if (!validDesc_(desc)) throw new Error('ข้อมูลใบหน้าไม่ถูกต้อง');
  const v = toInt8_(desc);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const oo = readOptOut_();
    if (!oo.data.entries.some(e => dist2_(Utilities.base64Decode(e.d), v) <= OPTOUT_T2 / 4)) {
      if (oo.data.entries.length >= OPTOUT_MAX) throw new Error('ระบบรับคำขอเต็มแล้ว กรุณาติดต่อผู้ดูแล');
      oo.data.entries.push({ d: Utilities.base64Encode(v), at: new Date().toISOString() });
      writeOptOut_(oo.data, oo.file);
    }
    let removed = 0;
    for (const ev of listEvents_()) {
      const idx = readIndex_(ev.id);
      if (!idx) continue;
      const photos = idx.data.photos || {};
      let changed = false;
      for (const pid in photos) {
        const before = photos[pid].f.length;
        photos[pid].f = photos[pid].f.filter(f => dist2_(Utilities.base64Decode(f.d), v) > OPTOUT_T2);
        if (photos[pid].f.length !== before) { removed += before - photos[pid].f.length; changed = true; }
      }
      if (changed) { idx.data.updated = new Date().toISOString(); writeIndex_(ev.id, idx.data, idx.file); }
    }
    return { removed: removed };
  } finally { lock.releaseLock(); }
}

function removeOptOut_(at) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const oo = readOptOut_();
    const n = oo.data.entries.length;
    oo.data.entries = oo.data.entries.filter(e => e.at !== at);
    if (oo.file && oo.data.entries.length !== n) writeOptOut_(oo.data, oo.file);
    return oo.data.entries.length !== n;
  } finally { lock.releaseLock(); }
}

/* ======================= หน้าแชร์ LINE (มีรูปปกแต่ละอัลบั้ม) ======================= */
/*
 * เก็บไฟล์ a/<รหัสอัลบั้ม>.html + a/<รหัสอัลบั้ม>.jpg ไว้ใน repo GitHub Pages
 * LINE อ่าน og:image จากหน้านี้ แล้วหน้าพาผู้ใช้ต่อไปที่อัลบั้ม (#e=...)
 * ต้องตั้ง GitHub token (fine-grained, เฉพาะ repo นี้, Contents: Read and write) ในหน้าผู้ดูแล
 */
const GH_REPO_DEFAULT = 'suthiphong-ben2/ben2-activity-photos';
const SITE_DEFAULT = 'https://suthiphong-ben2.github.io/ben2-activity-photos/';

function ghRepo_() { return PROPS.getProperty('GITHUB_REPO') || GH_REPO_DEFAULT; }
function siteUrl_() { return PROPS.getProperty('SITE_URL') || SITE_DEFAULT; }

function gh_(method, path, body) {
  const token = PROPS.getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('ยังไม่ได้ตั้ง GitHub token');
  const opt = {
    method: method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    muteHttpExceptions: true
  };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + ghRepo_() + path, opt);
  const code = res.getResponseCode();
  const text = res.getContentText();
  return { code: code, json: text ? JSON.parse(text) : null };
}

function ghPut_(path, base64, message) {
  const cur = gh_('get', '/contents/' + path + '?ref=main');
  const body = { message: message, content: base64, branch: 'main' };
  if (cur.code === 200 && cur.json && cur.json.sha) body.sha = cur.json.sha;
  const res = gh_('put', '/contents/' + path, body);
  if (res.code !== 200 && res.code !== 201) {
    throw new Error('บันทึกไป GitHub ไม่สำเร็จ (' + res.code + '): ' + ((res.json && res.json.message) || ''));
  }
}

function setGithubToken_(token) {
  token = String(token || '').trim();
  if (!token) { PROPS.deleteProperty('GITHUB_TOKEN'); return { ok: true, cleared: true }; }
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + ghRepo_(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('token ใช้กับ repo ' + ghRepo_() + ' ไม่ได้ (' + res.getResponseCode() + ')');
  const perm = (JSON.parse(res.getContentText()).permissions) || {};
  if (perm.push === false) throw new Error('token นี้ไม่มีสิทธิ์เขียน repo (ต้องเลือก Contents: Read and write)');
  PROPS.setProperty('GITHUB_TOKEN', token);
  return { ok: true };
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TH_MON_ = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function splitName_(name) {
  const m = /^(25\d\d)-(\d\d)-(\d\d)\s+(.*)$/.exec(name || '');
  if (!m) return { date: '', title: name || '' };
  return { date: (+m[3]) + ' ' + (TH_MON_[+m[2] - 1] || '') + ' ' + m[1], title: m[4] };
}

/** สร้าง/อัปเดตหน้าแชร์ของอัลบั้ม ใช้รูปปกปัจจุบัน */
function publishShare_(eventId) {
  const ev = assertEvent_(eventId);
  CacheService.getScriptCache().remove('sum_' + ev.id);
  const sum = summary_(ev.id);
  if (!sum.cover) throw new Error('อัลบั้มนี้ยังไม่มีรูป');
  const meta = Drive.Files.get(sum.cover, { fields: 'thumbnailLink', supportsAllDrives: true });
  if (!meta.thumbnailLink) throw new Error('รูปปกยังไม่มีภาพย่อ ลองใหม่อีกครั้งในอีกสักครู่');
  const img = UrlFetchApp.fetch(meta.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, '=s1200'), {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (img.getResponseCode() !== 200) throw new Error('ดึงรูปปกไม่สำเร็จ');

  const site = siteUrl_();
  const s = splitName_(ev.name);
  const target = site + '#e=' + encodeURIComponent(ev.id);
  const desc = [s.date, 'ดูและดาวน์โหลดรูปกิจกรรม', 'โรงเรียนเบญจมราชรังสฤษฎิ์ ๒'].filter(String).join(' · ');
  const v = Date.now().toString(36);
  const html = '<!doctype html>\n<html lang="th"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc_(s.title) + ' · ภาพกิจกรรม โรงเรียนเบญจมราชรังสฤษฎิ์ ๒</title>\n' +
    '<meta name="description" content="' + esc_(desc) + '">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:site_name" content="ภาพกิจกรรม โรงเรียนเบญจมราชรังสฤษฎิ์ ๒">\n' +
    '<meta property="og:title" content="' + esc_(s.title) + '">\n' +
    '<meta property="og:description" content="' + esc_(desc) + '">\n' +
    '<meta property="og:image" content="' + esc_(site + 'a/' + ev.id + '.jpg?v=' + v) + '">\n' +
    '<meta property="og:url" content="' + esc_(site + 'a/' + ev.id + '.html') + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta http-equiv="refresh" content="0; url=' + esc_(target) + '">\n' +
    '<script>location.replace(' + JSON.stringify(target) + ')</script>\n' +
    '</head><body style="font-family:sans-serif;padding:24px"><a href="' + esc_(target) + '">เปิดอัลบั้ม ' + esc_(s.title) + '</a></body></html>\n';

  ghPut_('a/' + ev.id + '.jpg', Utilities.base64Encode(img.getBlob().getBytes()), 'ปกอัลบั้ม: ' + s.title);
  ghPut_('a/' + ev.id + '.html', Utilities.base64Encode(html, Utilities.Charset.UTF_8), 'หน้าแชร์: ' + s.title);
  PROPS.setProperty('SH_' + ev.id, sum.cover);
  return { url: site + 'a/' + ev.id + '.html', cover: sum.cover };
}

/** อัลบั้มทั้งหมด + จำนวนรูป + ปก + มีหน้าแชร์แล้วหรือยัง */
function listAlbums_() {
  const props = PROPS.getProperties();
  return listEvents_().map(ev => Object.assign({}, ev, summary_(ev.id), { share: !!props['SH_' + ev.id] }));
}

function shareStatus_() {
  const props = PROPS.getProperties();
  return {
    hasToken: !!props.GITHUB_TOKEN,
    repo: ghRepo_(),
    albums: listEvents_().map(ev => {
      const sum = summary_(ev.id);
      const pub = props['SH_' + ev.id] || '';
      return { id: ev.id, name: ev.name, count: sum.count, shared: !!pub, stale: !!pub && pub !== sum.cover };
    })
  };
}

/* ======================= ติดตั้งครั้งแรก ======================= */

/** รันครั้งเดียวจาก editor: สร้างโฟลเดอร์หลักถ้ายังไม่มี (รันซ้ำได้) */
function setupOnce() {
  let rootId = PROPS.getProperty('ROOT_FOLDER_ID');
  if (!rootId) {
    const root = DriveApp.createFolder('ภาพกิจกรรม BEN2');
    root.createFolder(INDEX_FOLDER_NAME);
    rootId = root.getId();
    PROPS.setProperty('ROOT_FOLDER_ID', rootId);
  }
  salt_();
  Logger.log('ROOT_FOLDER_ID = ' + rootId);
  Logger.log('โฟลเดอร์: ' + DriveApp.getFolderById(rootId).getUrl());
}
