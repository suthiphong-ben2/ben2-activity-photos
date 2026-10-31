/* ใช้ร่วมกันทุกหน้า: เรียก API, ตรวจจับใบหน้า, ตัวช่วยเล็กๆ */
(function () {
  const API = window.BEN2PH_API;
  const FACE_VER = '1.7.15';
  const FACE_JS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@' + FACE_VER + '/dist/face-api.js';
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@' + FACE_VER + '/model/';
  const Q = 200; // ต้องตรงกับ Code.gs

  const $ = id => document.getElementById(id);

  /** เรียก Apps Script (POST, text/plain เพื่อไม่ต้องทำ CORS preflight) */
  async function api(action, body) {
    if (!API || !/^https:\/\//.test(API)) throw new Error('ยังไม่ได้ตั้งค่าลิงก์ API ใน config.js');
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, body || {})),
      });
    } catch (e) {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    }
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (' + res.status + ')'); }
    if (!j.ok) throw new Error(j.error || 'ทำรายการไม่สำเร็จ');
    return j.data;
  }

  /* ---------- ใบหน้า (face-api ทำงานในเบราว์เซอร์ทั้งหมด) ---------- */
  let ready = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('โหลดตัวตรวจจับใบหน้าไม่สำเร็จ'));
      document.head.appendChild(s);
    });
  }
  function loadModels() {
    if (!ready) {
      ready = (async () => {
        if (!window.faceapi) await loadScript(FACE_JS);
        try { await faceapi.tf.setBackend('webgl'); } catch (e) {}
        await faceapi.tf.ready();
        await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
      })().catch(err => { ready = null; throw err; });
    }
    return ready;
  }
  function detectFaces(img, minConfidence) {
    return faceapi
      .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: minConfidence || 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
  }
  /** ค่าใบหน้า 128 ตัวเลข → int8 → base64 */
  function encodeDesc(desc) {
    const b = new Int8Array(128);
    for (let i = 0; i < 128; i++) b[i] = Math.max(-127, Math.min(127, Math.round(desc[i] * Q)));
    const u = new Uint8Array(b.buffer);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  /** รูป → [{d, b}] สำหรับเก็บในดัชนี */
  async function facesOf(img) {
    const dets = await detectFaces(img, 0.5);
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const r = v => Math.round(v * 1000) / 1000;
    return dets.map(d => ({
      d: encodeDesc(d.descriptor),
      b: [r(d.detection.box.x / W), r(d.detection.box.y / H), r(d.detection.box.width / W), r(d.detection.box.height / H)],
    }));
  }

  /* ---------- รูป ---------- */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('เปิดรูปไม่ได้'));
      img.src = src;
    });
  }
  /** ย่อไฟล์ให้ด้านยาวไม่เกิน max px → data URL */
  async function resizeFile(file, max, quality) {
    const src = URL.createObjectURL(file);
    try {
      const img = await loadImage(src);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality || 0.9);
    } finally { URL.revokeObjectURL(src); }
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('อ่านไฟล์ไม่ได้'));
      fr.readAsDataURL(file);
    });
  }

  function setStatus(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', kind === 'error');
    el.classList.toggle('ok', kind === 'ok');
  }
  function errMsg(e) { return (e && e.message) || String(e); }

  /** ชื่อโฟลเดอร์ "2569-10-26 ชื่อ" → { date: '26 ต.ค. 2569', title } */
  const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function splitEvent(name) {
    const m = /^(25\d\d)-(\d\d)-(\d\d)\s+(.*)$/.exec(name || '');
    if (!m) return { date: '', title: name || '' };
    return { date: (+m[3]) + ' ' + (TH_MON[+m[2] - 1] || '') + ' ' + m[1], title: m[4] };
  }

  /** ปรับความสูงกรอบเมื่อฝังในเว็บโรงเรียน */
  function reportHeight() {
    if (window.parent === window) return;
    const send = () => parent.postMessage({ ben2ph: true, height: document.documentElement.scrollHeight }, '*');
    new ResizeObserver(send).observe(document.body);
    send();
  }

  window.BEN2 = { $, api, loadModels, detectFaces, facesOf, encodeDesc, loadImage, resizeFile, fileToBase64, setStatus, errMsg, splitEvent, reportHeight };
})();
