// TVAutoPlayer 内容管理服务端（零依赖，Node >= 22.5）
// 终端接口: GET /api/manifest, GET /media/<file>
// 管理接口: /api/media /api/program /api/schedules
// 内容保存即生效：manifest 直接由当前数据生成，contentVersion 为内容哈希
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const db = require('./db');
const alist = require('./alist');
const { buildManifest, validateSchedule, newScheduleId } = require('./manifest');

// 同目录 config.env 存放本机配置（KEY=VALUE，# 为注释）。
// 用 Node 读取而不是批处理，Windows 上中文路径、CRLF 都不会出问题；已在环境变量里的值优先。
function loadConfigFile() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(__dirname, 'config.env'), 'utf8');
  } catch {
    return; // 没有配置文件时全部走默认值
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadConfigFile();

const PORT = process.env.PORT || 8300;
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true }); // 重封装临时文件与历史文件仍然读这里
// 主媒体库的实际存储目录可以在后台改到任意文件夹；这里缓存解析结果，
// 改动后调用 resetMainDir() 失效，后续上传、扫描、/media 都落到新目录。
let mainDirCache = null;
function mainDir() {
  if (mainDirCache) return mainDirCache;
  let row = null;
  try { row = db.prepare('SELECT path FROM libraries WHERE is_main = 1 LIMIT 1').get(); } catch { /* 表尚未建好 */ }
  mainDirCache = row && row.path ? row.path : MEDIA_DIR;
  return mainDirCache;
}
const resetMainDir = () => { mainDirCache = null; };
// 历史文件可能留在旧目录：读取和删除都要两个目录都看一遍
const storedFile = (name) => {
  for (const dir of [mainDir(), MEDIA_DIR]) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
};
const removeStoredFile = (name) => {
  for (const dir of new Set([mainDir(), MEDIA_DIR])) fs.rmSync(path.join(dir, name), { force: true });
};
const MAX_UPLOAD_GB = Math.max(1, Number(process.env.MAX_UPLOAD_GB) || 8);
const MAX_UPLOAD = MAX_UPLOAD_GB * 1024 * 1024 * 1024;
// 媒体库现在由后台管理；MEDIA_EXTRA_DIRS 仅作为兼容入口，启动时自动注册为媒体库。
const EXTRA_MEDIA_DIRS = (process.env.MEDIA_EXTRA_DIRS || '')
  .split(path.delimiter)
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => path.resolve(dir));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 可选环境变量口令（兼容旧方案）

// ---------- 网络存储凭证 ----------
// OpenList 账号密码不能明文落库：用本机密钥文件做 AES-256-GCM 加密，
// 密钥文件与数据库同目录，权限 600，随数据库一起备份。
const SECRET_FILE = path.join(__dirname, 'data', '.secret');
function secretKey() {
  try { return fs.readFileSync(SECRET_FILE); } catch { /* 首次使用，下面生成 */ }
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
  return key;
}
function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}
function decryptSecret(text) {
  if (!text || !String(text).startsWith('v1:')) return '';
  const [, iv, tag, data] = String(text).split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ---------- 密码 / 会话 ----------
const scrypt = (pwd, saltHex) => {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(pwd, salt, 64).toString('hex');
};
function ensureDefaultAdmin() {
  const row = db.prepare('SELECT * FROM admin_user LIMIT 1').get();
  if (row) return { username: row.username, locked: Date.now()/1000 < row.locked_until };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scrypt('admin', salt);
  db.prepare('INSERT INTO admin_user (username, password_hash, salt) VALUES (?,?,?)').run('admin', hash, salt);
  console.log('[auth] 首次启动，已创建默认账户 admin / admin  —— 请登录后尽快修改密码！');
}
ensureDefaultAdmin();

// 内存会话，key=sid, value={username, exp}；12h 过期
const sessions = new Map();
const SESSION_TTL = 12 * 3600;
setInterval(() => {
  const now = Date.now()/1000;
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}, 60_000);

function readCookie(req, name) {
  const c = req.headers['cookie'] || '';
  const m = c.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function setSessionCookie(res, sid, expire) {
  res.setHeader('Set-Cookie', `auth=${encodeURIComponent(sid)}; Path=/; ${expire ? `Max-Age=${SESSION_TTL}` : 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'}; SameSite=Lax; HttpOnly`);
}
function authByCookie(req) {
  const sid = readCookie(req, 'auth'); if (!sid) return null;
  const s = sessions.get(sid); if (!s || s.exp < Date.now()/1000) { sessions.delete(sid); return null; }
  return s.username;
}
function requireAuth(req, res) {
  // 1) cookie 会话  2) 环境变量备用 token  3) 无 env 时自动放行（开发便捷）
  const u = authByCookie(req); if (u) return u;
  if (ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN) return 'admin';
  // ADMIN_TOKEN 未设置且没有用户表 — 开发期自动放行
  if (!ADMIN_TOKEN && sessions.size === 0) return null; // 走 /api/login
  return null;
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'ts', 'm4v', 'mov']);
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.ts': 'video/mp2t', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
};

const kindOf = (filename) => {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'IMAGE';
  if (VIDEO_EXT.has(ext)) return 'VIDEO';
  return null;
};

// ---------- 工具 ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (data == null) data = '';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  // 媒体库列表一次要返回上千行 JSON，局域网下也有近 1MB；压缩后约剩十分之一。
  const accept = (res.req && res.req.headers['accept-encoding']) || '';
  if (Buffer.byteLength(data) > 1024 && /\bgzip\b/.test(accept)) {
    data = zlib.gzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data));
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = Buffer.byteLength(data);
  res.writeHead(code, headers);
  res.end(data);
}
const ok = (res, body = {}) => send(res, 200, body);
const bad = (res, msg) => send(res, 400, { error: msg });

/**
 * Links a file that lives outside the media folder into the library without copying it.
 * A symlink is tried first because it also works across volumes; when the platform refuses
 * it (Windows without developer mode or admin rights) a hard link is used, which needs no
 * privileges but only works inside the same volume. Returns false when both fail, so the
 * caller can fall back to a real copy.
 */
function linkExternal(src, dest) {
  try {
    fs.symlinkSync(src, dest, 'file');
    return true;
  } catch {
    // Not permitted: Windows requires SeCreateSymbolicLinkPrivilege.
  }
  try {
    fs.linkSync(src, dest);
    return true;
  } catch {
    // Different volume: the caller copies the file instead.
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { reject(new Error('文件过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 内容哈希作为 contentVersion（终端只比较是否变化）；保持为 31 位以内整数
const contentVersionOf = (manifest) => {
  const copy = Object.assign({}, manifest);
  delete copy.contentVersion;
  const hex = crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
  const value = parseInt(hex.slice(0, 7), 16);
  return value === 0 ? 1 : value;
};

// 删除媒体或直播源时同步清理时段引用；时段因此变空时自动停用，
// 否则会留下一个「启用但没有任何内容」的时段：终端静默跳过，后台也难察觉。
function detachFromSchedules(matches) {
  let disabled = 0;
  for (const s of db.prepare('SELECT id, items_json, enabled FROM schedules').all()) {
    const items = JSON.parse(s.items_json);
    const kept = items.filter((it) => !matches(it));
    if (kept.length === items.length) continue;
    const enabled = kept.length === 0 ? 0 : s.enabled;
    db.prepare('UPDATE schedules SET items_json = ?, enabled = ? WHERE id = ?')
      .run(JSON.stringify(kept), enabled, s.id);
    if (kept.length === 0) disabled++;
  }
  return disabled;
}

// ---------- 长轮询通知 ----------
// 后台保存后立即唤醒挂起的 /api/watch 请求，终端无需等待固定轮询周期
const WATCH_HOLD_MS = 25000;
const contentWatchers = new Set();
const notifyContentChanged = () => {
  const pending = [...contentWatchers];
  contentWatchers.clear();
  pending.forEach((wake) => { try { wake(); } catch { /* 忽略单次唤醒异常 */ } });
};

const jsonBody = async (req) => {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw new Error('请求体不是合法 JSON'); }
};

// 直播源可用性 + 稳定性探测：
// 1) 拉取 m3u8 校验 #EXTM3U，记录首包延迟；2) 主播放列表自动跟进首个变体；
// 3) 下载首个分片（至多 2MB 或 6 秒）估算吞吐 KB/s。
// verdict: good（可用且速度达标）| slow（可用但偏慢）| fail（不可用）。
const PROBE_UA = { 'User-Agent': 'TVAutoPlayer-Probe/1.0' };
const PROBE_SLOW_KBPS = 500;   // 低于 500 KB/s（约 4 Mbps）判定偏慢
const PROBE_SLOW_LATENCY = 3000;

async function probeFetchText(url, timeoutMs) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: PROBE_UA });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch { /* 中断剩余下载 */ }
    return { text, finalUrl: res.url, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? '连接超时' : '无法连接' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeFetchBytes(url, maxBytes, timeoutMs) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let bytes = 0, statusError = null;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: PROBE_UA });
    if (!res.ok) {
      statusError = `HTTP ${res.status}`;
    } else {
      const reader = res.body.getReader();
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      try { await reader.cancel(); } catch { /* 中断剩余下载 */ }
    }
  } catch { /* 超时或断连：用已下载字节估算速度 */ }
  clearTimeout(timer);
  if (statusError) return { error: statusError };
  if (bytes === 0) return { error: '无法连接' };
  const secs = Math.max((Date.now() - t0) / 1000, 0.1);
  return { bytes, kbps: Math.round(bytes / 1024 / secs) };
}

async function probeLiveUrl(url) {
  const first = await probeFetchText(url, 8000);
  if (first.error) {
    return { ok: false, verdict: 'fail', reason: first.error === '连接超时' ? '连接超时（8 秒）' : first.error };
  }
  if (!first.text.includes('#EXTM3U')) {
    return { ok: false, verdict: 'fail', reason: '响应不是 m3u8 播放列表' };
  }

  // 主播放列表：跟进第一个变体流的播放列表
  let playlistUrl = first.finalUrl, text = first.text;
  const latencyMs = first.latencyMs;
  const firstLink = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (text.includes('#EXT-X-STREAM-INF') && firstLink) {
    const sub = await probeFetchText(new URL(firstLink, first.finalUrl).href, 8000);
    if (sub.error) return { ok: false, verdict: 'fail', reason: '子播放列表' + sub.error };
    playlistUrl = sub.finalUrl; text = sub.text;
  }

  // 媒体播放列表：下载首个分片估算吞吐
  const seg = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
  let kbps = 0;
  if (seg) {
    const r = await probeFetchBytes(new URL(seg, playlistUrl).href, 2 * 1024 * 1024, 6000);
    if (r.error) return { ok: false, verdict: 'fail', reason: '分片下载失败：' + r.error };
    kbps = r.kbps;
  }
  const slow = (kbps > 0 && kbps < PROBE_SLOW_KBPS) || latencyMs > PROBE_SLOW_LATENCY;
  return { ok: true, verdict: slow ? 'slow' : 'good', latencyMs, kbps };
}

const probeSummary = (p) =>
  p.kbps ? `延迟 ${p.latencyMs}ms · 测速约 ${p.kbps} KB/s` : `延迟 ${p.latencyMs}ms`;

// 客户端请求体问题返回 400，避免把用户输入错误报成服务端 500
const clientError = (msg) => Object.assign(new Error(msg), { status: 400 });

// 流式保存上传：multipart 请求体直接写入临时文件，避免大文件占用内存
function saveUpload(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const m = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(contentType);
    if (!m) { req.resume(); return reject(clientError('缺少 boundary')); }
    const boundary = `--${m[1] || m[2]}`;
    const tmp = path.join(mainDir(), `.upload-${crypto.randomUUID()}.tmp`);
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rmSync(tmp, { force: true });
      reject(e);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { fail(Object.assign(new Error(`文件超过 ${MAX_UPLOAD_GB}GB 上限`), { status: 413 })); req.destroy(); }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      try {
        resolve(locateMultipartFile(tmp, size, boundary));
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        reject(e);
      }
    });
    req.pipe(out);
  });
}

// 从已落盘的 multipart 体中定位 file 字段的数据区间（只读头部与尾部小块）
function locateMultipartFile(tmp, totalSize, boundary) {
  const fd = fs.openSync(tmp, 'r');
  try {
    const head = Buffer.alloc(Math.min(totalSize, 64 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.indexOf(boundary) !== 0) throw clientError('multipart 格式错误');
    const headerEnd = head.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw clientError('multipart 格式错误');
    const header = head.slice(0, headerEnd).toString('utf8');
    const fm = /filename="([^"]*)"/.exec(header);
    if (!fm) throw clientError('缺少文件名');
    const start = headerEnd + 4;
    // 结尾形如 \r\n--boundary--\r\n（部分客户端省略末尾换行）
    const tailLen = Math.max(0, Math.min(totalSize - start, boundary.length + 16));
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, totalSize - tailLen);
    const idx = tail.indexOf('\r\n' + boundary);
    if (idx < 0) throw clientError('multipart 结尾格式错误');
    const end = totalSize - tailLen + idx - 1;
    if (end < start) throw clientError('上传内容为空');
    return {
      filename: path.basename(fm[1]), tmp,
      start, end, size: end - start + 1,
    };
  } finally {
    fs.closeSync(fd);
  }
}

const sha256OfRange = (file, start, end) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file, { start, end })
    .on('data', (c) => h.update(c))
    .on('end', () => resolve(h.digest('hex')))
    .on('error', reject);
});

const copyRange = (src, start, end, dest) => new Promise((resolve, reject) => {
  fs.createReadStream(src, { start, end })
    .pipe(fs.createWriteStream(dest))
    .on('finish', resolve)
    .on('error', reject);
});

// Cuts the multipart data range into the destination file while hashing it in the same pass.
// Large uploads used to be read twice (hash, then copy); one pass halves the disk reads.
const extractAndHash = (src, start, end, dest) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  const rs = fs.createReadStream(src, { start, end, highWaterMark: 1024 * 1024 });
  const ws = fs.createWriteStream(dest);
  let settled = false;
  const fail = (e) => {
    if (settled) return;
    settled = true;
    rs.destroy();
    ws.destroy();
    fs.rmSync(dest, { force: true });
    reject(e);
  };
  rs.on('error', fail);
  ws.on('error', fail);
  ws.on('finish', () => {
    if (settled) return;
    settled = true;
    resolve(h.digest('hex'));
  });
  rs.on('data', (chunk) => h.update(chunk));
  rs.pipe(ws);
});

// 启动时清理异常退出遗留的上传/重封装临时文件，避免长期占用磁盘
(function cleanupTempFiles() {
  let names = [];
  const dir = mainDir();
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const name of names) {
    if (!/^\.(upload|pending|remux)-/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch { /* 忽略单个文件清理失败 */ }
  }
})();

// ---------- 旧封装 MKV 处理 ----------
// 2008 年前后 mkvmerge v2 时代生成的 MKV（DocTypeVersion=1，常伴 zlib 压缩字幕轨），
// 会被电视端 Media3 解析器拒绝（ERROR_CODE_PARSING_CONTAINER_MALFORMED）。
// 主机装有 ffmpeg 时上传自动无损重封装（-c copy，剥离字幕轨）；否则拒绝并给出指引。
let ffmpegChecked = false, ffmpegOk = false;
function ffmpegAvailable() {
  if (!ffmpegChecked) {
    ffmpegChecked = true;
    try { ffmpegOk = spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0; }
    catch { ffmpegOk = false; }
    if (ffmpegOk) console.log('[mkv] 检测到 ffmpeg，旧封装 MKV 上传时将自动重封装');
  }
  return ffmpegOk;
}

// 读取上传区间头部 EBML，识别 DocTypeVersion=1 的旧封装；解析失败一律放行（不误伤正常文件）
function isLegacyMkv(tmp, start) {
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'r');
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, start);
    if (n < 32) return false;
    const b = head.slice(0, n);
    if (b.readUInt32BE(0) !== 0x1A45DFA3) return false; // 非 EBML
    const docTypeAt = b.indexOf(Buffer.from([0x42, 0x82])); // DocType
    const verAt = b.indexOf(Buffer.from([0x42, 0x87]));     // DocTypeVersion
    if (docTypeAt < 0 || verAt < 0 || verAt + 3 >= b.length) return false;
    const docLen = b[docTypeAt + 2] - 0x80;
    if (docLen <= 0 || docTypeAt + 3 + docLen > b.length) return false;
    const docType = b.slice(docTypeAt + 3, docTypeAt + 3 + docLen).toString('latin1');
    return docType === 'matroska' && b[verAt + 3] < 2;
  } catch { return false; }
  finally { if (fd !== null) fs.closeSync(fd); }
}

// 无损重封装：首条视频流 + 全部音频流 -c copy，剥离字幕轨，容器重写为现代格式。
// 注意必须映射 0:a 而不是 0:a:0，否则多音轨视频的第二条及之后音轨会被丢弃。
// 成功返回新的上传描述（up.tmp 指向重封装产物）；失败返回 error 文案。
async function remuxMkv(up) {
  const src = path.join(MEDIA_DIR, `.remux-src-${crypto.randomUUID()}.mkv`);
  const dst = path.join(MEDIA_DIR, `.remux-dst-${crypto.randomUUID()}.mkv`);
  try {
    await copyRange(up.tmp, up.start, up.end, src);
    // spawnSync 会短暂阻塞事件循环（数百 MB 约数秒），终端轮询超时后自动重试，可接受
    const r = spawnSync('ffmpeg', [
      '-v', 'error', '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-sn', dst,
    ], { timeout: 300000 });
    if (r.status !== 0 || !fs.existsSync(dst)) throw new Error(r.stderr ? String(r.stderr).slice(0, 200) : 'ffmpeg 失败');
    const size = fs.statSync(dst).size;
    fs.rmSync(src, { force: true });
    fs.rmSync(up.tmp, { force: true });
    return { up: { filename: up.filename, tmp: dst, start: 0, end: size - 1, size } };
  } catch (e) {
    fs.rmSync(src, { force: true });
    fs.rmSync(dst, { force: true });
    return { error: '旧封装 MKV 自动重封装失败，请手动执行 ffmpeg -i 文件.mkv -c copy 输出.mkv 后重新上传' };
  }
}

// ---------- 媒体库 ----------
const MAIN_LIBRARY_ID = db.ensureMainLibrary(MEDIA_DIR);

/** 注册一个媒体库（供环境变量兼容入口使用），已存在则复用。 */
function registerLibrary(name, dirPath) {
  const resolved = path.resolve(dirPath);
  const existing = db.prepare('SELECT id FROM libraries WHERE path = ?').get(resolved);
  if (existing) return existing.id;
  const base = (name || path.basename(resolved) || '媒体库').trim().slice(0, 40);
  let candidate = base;
  for (let i = 2; db.prepare('SELECT 1 FROM libraries WHERE name = ?').get(candidate); i += 1) {
    candidate = `${base} (${i})`;
  }
  const info = db.prepare('INSERT INTO libraries (name, path) VALUES (?, ?)').run(candidate, resolved);
  return Number(info.lastInsertRowid);
}

// 旧的 MEDIA_EXTRA_DIRS 自动登记为媒体库，之后完全由后台管理
for (const dir of EXTRA_MEDIA_DIRS) registerLibrary(path.basename(dir), dir);

function listLibraries() {
  return db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM media m WHERE m.library_id = l.id) AS mediaCount
    FROM libraries l
    ORDER BY l.is_main DESC, l.id
  `).all().map((row) => {
    const provider = row.provider || 'LOCAL';
    let exists = provider !== 'LOCAL';
    if (provider === 'LOCAL') {
      try { exists = fs.statSync(row.path).isDirectory(); } catch { /* 目录不可访问 */ }
    }
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      isMain: !!row.is_main,
      enabled: !!row.enabled,
      provider,
      baseUrl: row.base_url || '',
      rootPath: row.root_path || '',
      mediaCount: row.mediaCount,
      exists,
    };
  });
}

/**
 * 扫描若干媒体库，把图片/视频登记进 media 表。
 * 主库是服务端自己的目录，文件直接改名入库；外部库用链接引用，原文件不动。
 */
async function scanLibraries(libs, progress = null) {
  const MAX_FILES = 5000;
  const files = [];
  let truncated = false;
  let already = 0;
  // 一次读出已入库清单，循环里不再逐文件查库；重复扫描可直接跳过，无需再算哈希。
  const knownNames = new Set(
    db.prepare('SELECT filename FROM media').all().map((row) => row.filename)
  );
  const knownSources = new Set(
    db.prepare('SELECT source_path FROM media WHERE source_path IS NOT NULL').all()
      .map((row) => row.source_path)
  );

  const walk = (dir, lib, depth) => {
    if (truncated || depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (truncated) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, lib, depth + 1); continue; }
      if (!e.isFile() || !kindOf(e.name)) continue;
      const resolved = path.resolve(full);
      if (lib.is_main) {
        // 已入库的文件（上传或上次扫描后改名）直接跳过，不重复读盘
        if (path.dirname(resolved) === path.resolve(lib.path) && knownNames.has(e.name)) {
          already++;
          continue;
        }
      } else if (knownSources.has(resolved)) {
        already++;
        continue;
      }
      files.push({ file: resolved, lib });
      if (files.length >= MAX_FILES) { truncated = true; return; }
    }
  };
  for (const lib of libs) {
    let usable = false;
    try { usable = fs.statSync(lib.path).isDirectory(); } catch { /* 跳过不可访问的库 */ }
    if (usable) walk(lib.path, lib, 0);
  }
  if (progress) { progress.phase = 'hash'; progress.total = files.length; progress.scanned = 0; }

  const insertMedia = db.prepare(
    'INSERT INTO media (filename, orig_name, sha256, kind, size, library_id, source_path) VALUES (?,?,?,?,?,?,?)'
  );
  const findDuplicate = db.prepare('SELECT filename FROM media WHERE sha256 = ? AND kind = ?');

  let added = 0, skipped = 0, failed = 0;
  const errors = [];

  const processOne = async ({ file, lib }) => {
    const name = path.basename(file);
    const kind = kindOf(name);
    try {
      const statSize = fs.statSync(file).size;
      if (statSize <= 0) { failed++; errors.push(`${name}: 空文件`); return; }
      let sha256 = await sha256OfRange(file, 0, statSize - 1);
      let finalSize = statSize;
      let source = file, srcStart = 0, srcEnd = statSize - 1;
      let fromTemp = false;
      if (kind === 'VIDEO' && path.extname(name).toLowerCase() === '.mkv' && isLegacyMkv(file, 0)) {
        if (!ffmpegAvailable()) {
          failed++;
          errors.push(`${name}: 旧封装 MKV，请先安装 ffmpeg`);
          return;
        }
        const rr = await remuxMkv({ tmp: file, start: 0, end: statSize - 1, filename: name });
        if (rr.error) { failed++; errors.push(`${name}: ${rr.error}`); return; }
        source = rr.up.tmp;
        srcStart = rr.up.start;
        srcEnd = rr.up.end;
        finalSize = rr.up.size;
        sha256 = await sha256OfRange(source, srcStart, srcEnd);
        fromTemp = true;
      }
      const dup = findDuplicate.get(sha256, kind);
      if (dup) {
        if (fromTemp) fs.rmSync(source, { force: true });
        skipped++;
        errors.push(`${name}: 与已入库的 ${dup.filename} 内容重复，原文件已保留`);
        return;
      }
      const storeName = `${sha256.slice(0, 16)}${path.extname(name).toLowerCase()}`;
      const target = path.join(mainDir(), storeName);
      fs.rmSync(target, { force: true });
      if (fromTemp) {
        // 重封装后的临时文件在媒体目录里，必须先把内容落盘再删源文件
        if (lib.is_main) fs.rmSync(file, { force: true });
        await copyRange(source, srcStart, srcEnd, target);
        fs.rmSync(source, { force: true });
      } else if (lib.is_main) {
        // 同目录改名不额外占空间
        if (path.resolve(file) !== path.resolve(target)) fs.renameSync(file, target);
      } else if (!linkExternal(file, target)) {
        // 软链接不可用（如 Windows 未开开发者模式）时退回复制
        await copyRange(file, 0, statSize - 1, target);
      }
      insertMedia.run(
        storeName, name.slice(0, 120), sha256, kind, finalSize,
        lib.id, lib.is_main ? null : file
      );
      added++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  };

  // 哈希与磁盘读取是主要耗时，4 路并发重叠执行；每批结束让出事件循环，
  // 保证扫描期间电视端的 /api/manifest 与 /api/watch 仍能正常响应。
  const CONCURRENCY = 4;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    await Promise.all(files.slice(i, i + CONCURRENCY).map(processOne));
    await new Promise((resolve) => setImmediate(resolve));
    if (progress) {
      progress.scanned = Math.min(i + CONCURRENCY, files.length);
      progress.added = added;
      progress.skipped = skipped;
      progress.failed = failed;
    }
  }

  if (added) notifyContentChanged();
  const names = libs.map((lib) => lib.name).join('、');
  console.log(`[scan] ${names} 扫描 ${files.length} 个，新增 ${added}，重复 ${skipped}，失败 ${failed}`);
  return {
    libraries: libs.map((lib) => ({ id: lib.id, name: lib.name })),
    limit: MAX_FILES, scanned: files.length, already, added, skipped, failed, truncated,
    errors: errors.slice(0, 10),
  };
}

/**
 * 扫描 OpenList / AList 媒体库：只读目录树，登记路径与大小，不下载内容、不计算哈希。
 * 播放时才按需换取直链，所以整库秒级完成。
 */
async function scanRemoteLibrary(lib, progress = null) {
  const MAX_FILES = 5000;
  const creds = {
    baseUrl: lib.base_url,
    username: lib.username,
    password: decryptSecret(lib.password),
  };
  const errors = [];
  const found = [];
  let truncated = false;

  const walk = async (dir, depth) => {
    if (truncated || depth > 5) return;
    let entries;
    try {
      entries = await alist.list(creds.baseUrl, creds.username, creds.password, dir);
    } catch (e) {
      errors.push(`${dir}: ${e.message}`);
      return;
    }
    if (progress) progress.scanned = found.length;
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue;
      const full = `${dir.replace(/\/+$/, '')}/${entry.name}`;
      if (entry.isDir) {
        await walk(full, depth + 1);
        continue;
      }
      if (!kindOf(entry.name)) continue;
      found.push({ path: full, name: entry.name, size: entry.size });
      if (found.length >= MAX_FILES) { truncated = true; return; }
    }
  };
  await walk(lib.root_path || '/', 0);

  const known = new Set(
    db.prepare('SELECT remote_path FROM media WHERE library_id = ?').all(lib.id)
      .map((row) => row.remote_path)
  );
  const insert = db.prepare(
    'INSERT INTO media (filename, orig_name, sha256, kind, size, library_id, remote_path) VALUES (?,?,?,?,?,?,?)'
  );

  let added = 0, already = 0;
  for (const item of found) {
    if (known.has(item.path)) { already += 1; continue; }
    const kind = kindOf(item.name);
    const fp = crypto.createHash('sha256')
      .update(`${lib.id}:${item.path}`).digest('hex').slice(0, 16);
    insert.run(
      `ol_${fp}${path.extname(item.name).toLowerCase()}`,
      item.name.slice(0, 120), '', kind, item.size, lib.id, item.path
    );
    added += 1;
  }

  if (added) notifyContentChanged();
  console.log(`[scan] ${lib.name} 远程扫描 ${found.length} 个，新增 ${added}，已入库 ${already}，失败 ${errors.length}`);
  return {
    libraries: [{ id: lib.id, name: lib.name }],
    limit: MAX_FILES, scanned: found.length, already, added, skipped: 0,
    failed: errors.length, truncated, errors: errors.slice(0, 10),
  };
}

// ---------- 扫描任务 ----------
// 大目录扫描要跑几十秒，同步等结果时页面只能干转圈，还可能被反向代理超时掐断。
// 改成后台任务 + 状态轮询：接口立刻返回，前端每秒取一次进度，同时防止重复触发。
const scanTasks = new Map();

function startScanTask(lib) {
  const task = {
    running: true, phase: 'walk', scanned: 0, total: 0,
    added: 0, skipped: 0, failed: 0, error: '',
    startedAt: Date.now(), finishedAt: 0,
  };
  scanTasks.set(lib.id, task);
  const running = lib.provider === 'ALIST'
    ? scanRemoteLibrary(lib, task)
    : scanLibraries([lib], task);
  running.then((result) => {
    // 最终结果覆盖实时进度，前端拿到的计数是准确的。
    Object.assign(task, result, { running: false, phase: 'done', finishedAt: Date.now() });
  }).catch((e) => {
    Object.assign(task, { running: false, phase: 'error', error: e.message, finishedAt: Date.now() });
  });
  return task;
}

/**
 * 把 OpenList 上的媒体流式转发给终端，Range 原样透传，电视可以正常拖动进度。
 * 直链按媒体库与云盘路径缓存，过期时由 401/403 触发重取，不会让播放永久失败。
 */
// 云盘直链有有效期（通常 1~4 小时）。播放一个 MKV 会发多次 Range 请求（起播、拖动、
// 缓冲补给），每次都去问一次 OpenList 会白白多出一次往返。这里按「媒体库 + 云盘路径」
// 缓存直链；直链失效时上游回 401/403，丢掉缓存重取一次即可，用户无感。
const RAW_URL_TTL_MS = 30 * 60 * 1000;
const RAW_URL_CACHE_LIMIT = 500;
const rawUrlCache = new Map();
/** 与云盘建立连接最多等这么久，避免云盘挂死时请求一直悬着。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 20000;

async function remoteDirectUrl(row, remotePath, refresh = false) {
  const key = `${row.library_id}|${remotePath}`;
  const hit = rawUrlCache.get(key);
  if (!refresh && hit && hit.expiresAt > Date.now()) return hit.url;
  const url = await alist.rawUrl(row.base_url, row.username, decryptSecret(row.password), remotePath);
  if (rawUrlCache.size >= RAW_URL_CACHE_LIMIT) rawUrlCache.clear();
  rawUrlCache.set(key, { url, expiresAt: Date.now() + RAW_URL_TTL_MS });
  return url;
}

async function openUpstream(target, rangeHeader, clientSignal) {
  const connecting = new AbortController();
  const timer = setTimeout(() => connecting.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);
  try {
    return await fetch(target, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
      redirect: 'follow',
      signal: AbortSignal.any([clientSignal, connecting.signal]),
    });
  } finally {
    // 只限制「拿到响应头」的时间；之后的传输不受影响，否则长片会被中途掐断。
    clearTimeout(timer);
  }
}

async function proxyRemoteMedia(req, res, name, row) {
  const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const client = new AbortController();
  res.on('close', () => client.abort());

  let upstream;
  try {
    const target = await remoteDirectUrl(row, row.remote_path);
    upstream = await openUpstream(target, req.headers.range, client.signal);
    // 直链已过期：云盘回 401/403，丢掉缓存重取一次再试。
    if (upstream.status === 401 || upstream.status === 403) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      const fresh = await remoteDirectUrl(row, row.remote_path, true);
      upstream = await openUpstream(fresh, req.headers.range, client.signal);
    }
  } catch (e) {
    if (res.writableEnded || res.destroyed) return;
    return send(res, client.signal.aborted ? 499 : 504, { error: `云盘无响应：${e.message}` });
  }
  if (!upstream.ok && upstream.status !== 206) {
    const body = await upstream.text().catch(() => '');
    return send(res, 502, { error: `云盘返回 ${upstream.status}${body ? `：${body.slice(0, 120)}` : ''}` });
  }

  const out = {
    'Content-Type': upstream.headers.get('content-type') || mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const length = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  if (length) out['Content-Length'] = length;
  if (contentRange) out['Content-Range'] = contentRange;

  res.writeHead(upstream.status === 206 ? 206 : 200, out);
  if (req.method === 'HEAD') {
    if (upstream.body) upstream.body.cancel().catch(() => {});
    return res.end();
  }
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body)
    .on('error', () => res.destroy())
    .pipe(res);
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // 终端公开接口
    if (p === '/api/manifest' && req.method === 'GET') {
      // 直接由当前媒体 / 节目单 / 时段生成，保存后立即对终端可见
      const manifest = buildManifest(db, 0);
      manifest.contentVersion = contentVersionOf(manifest);
      return send(res, 200, manifest);
    }
    if (p === '/api/watch' && req.method === 'GET') {
      // 长轮询：内容一变立即返回；无变化时最多挂起 WATCH_HOLD_MS 后返回当前版本
      const since = Number(url.searchParams.get('version') || '0');
      const currentVersion = () => contentVersionOf(buildManifest(db, 0));
      const respond = () => {
        if (res.writableEnded) return;
        let v = since;
        try { v = currentVersion(); } catch { /* 保留 since */ }
        send(res, 200, { contentVersion: v });
      };
      if (currentVersion() !== since) return respond();
      let timer = null;
      const finish = () => {
        contentWatchers.delete(finish);
        if (timer) { clearTimeout(timer); timer = null; }
        respond();
      };
      contentWatchers.add(finish);
      timer = setTimeout(finish, WATCH_HOLD_MS);
      req.on('close', () => {
        contentWatchers.delete(finish);
        if (timer) { clearTimeout(timer); timer = null; }
      });
      return;
    }
    if (p.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = path.basename(p.slice(7));
      // OpenList 媒体没有本地文件：实时换直链后按 Range 转发给电视。
      // 电视端始终只连本服务，云盘直链和账号凭证都不会暴露出去。
      const remote = db.prepare(`
        SELECT m.remote_path, l.id AS library_id, l.base_url, l.username, l.password
        FROM media m JOIN libraries l ON l.id = m.library_id
        WHERE m.filename = ? AND m.remote_path IS NOT NULL
      `).get(name);
      if (remote) return proxyRemoteMedia(req, res, name, remote);
      const file = storedFile(name);
      if (!file) return send(res, 404, { error: '媒体不存在' });
      const stat = fs.statSync(file);
      const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
      const range = req.headers['range'];
      const headers = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      let start = 0, end = stat.size - 1, status = 200;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          const s = m[1] === '' ? 0 : parseInt(m[1], 10);
          const e = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10);
          if (s >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
          start = s; end = Math.min(e, stat.size - 1); status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['Content-Length'] = end - start + 1;
        }
      } else {
        headers['Content-Length'] = stat.size;
      }
      res.writeHead(status, headers);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    // 管理页面（始终可访问，未登录时 HTML 内会显示登录 UI）
    if ((p === '/' || p === '/admin') && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'admin.html')),
        'text/html; charset=utf-8');
    }
    // 前端静态资源（CSS/JS），按子目录组织，便于拆分 admin.html 维护
    if (req.method === 'GET' && (p.startsWith('/css/') || p.startsWith('/js/'))) {
      const rel = p.replace(/^\/+/, '');
      const file = path.join(__dirname, 'public', rel);
      const pubRoot = path.join(__dirname, 'public') + path.sep;
      if (!file.startsWith(pubRoot)) return send(res, 403, { error: '禁止访问' });
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: '资源不存在' });
      const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': data.length,
        // 后台样式/脚本不常改，允许缓存 5 分钟，刷新页面不必重复下载。
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(data);
    }
    // 浏览器自动请求，不需要登录也不需要内容
    if (p === '/favicon.ico') return send(res, 204);

    // ----- 登录 / 会话 / 改密码（免 auth）-----
    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await jsonBody(req);
      const u = db.prepare('SELECT * FROM admin_user LIMIT 1').get();
      if (!u) return send(res, 500, { error: '账户未初始化' });
      const now = Math.floor(Date.now() / 1000);
      if (now < u.locked_until) return send(res, 429, { error: `账户已锁定，请 ${u.locked_until - now} 秒后再试` });
      const expected = scrypt(password || '', u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(u.password_hash))) {
        const fails = u.failures + 1;
        const lock = fails >= 6 ? now + 60 : 0;
        db.prepare('UPDATE admin_user SET failures = ?, locked_until = ?').run(fails, lock);
        return send(res, 401, { error: `用户名或密码错误（${fails}/6 次）${lock ? '，已锁定 60 秒' : ''}` });
      }
      db.prepare('UPDATE admin_user SET failures = 0, locked_until = 0').run();
      const sid = crypto.randomUUID();
      sessions.set(sid, { username: u.username, exp: now + SESSION_TTL });
      setSessionCookie(res, sid, true);
      return ok(res, { username: u.username, expiresIn: SESSION_TTL });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const sid = readCookie(req, 'auth'); if (sid) sessions.delete(sid);
      setSessionCookie(res, '', false); return ok(res);
    }
    if (p === '/api/me' && req.method === 'GET') {
      const u = authByCookie(req);
      if (!u && ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN) return ok(res, { username: 'admin', via: 'token' });
      return u ? ok(res, { username: u }) : send(res, 401, { error: '未登录' });
    }
    if (p === '/api/password' && req.method === 'PUT') {
      const who = requireAuth(req, res);
      if (!who) return send(res, 401, { error: '未登录' });
      const { oldPassword, newPassword } = await jsonBody(req);
      if (!newPassword || newPassword.length < 4) return bad(res, '新密码至少 4 位');
      const u = db.prepare('SELECT * FROM admin_user LIMIT 1').get();
      const expected = scrypt(oldPassword || '', u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(u.password_hash)))
        return send(res, 401, { error: '原密码错误' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = scrypt(newPassword, salt);
      db.prepare('UPDATE admin_user SET password_hash = ?, salt = ?').run(hash, salt);
      return ok(res);
    }

    // 以下均为管理接口，须登录
    const who = requireAuth(req, res);
    if (!who) return send(res, 401, { error: '未登录，请先登录' });

    // ----- 媒体库管理 -----
    if (p === '/api/libraries' && req.method === 'GET') {
      return ok(res, listLibraries());
    }
    if (p === '/api/libraries' && req.method === 'POST') {
      const body = await jsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return bad(res, '请填写媒体库名称');
      if (name.length > 40) return bad(res, '名称不能超过 40 个字符');
      if (db.prepare('SELECT 1 FROM libraries WHERE name = ?').get(name)) {
        return bad(res, '媒体库名称重复，请换一个');
      }

      if (String(body.provider || 'LOCAL').toUpperCase() === 'ALIST') {
        const baseUrl = alist.normalizeBase(body.baseUrl);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const rootPath = String(body.rootPath || '/').trim() || '/';
        if (!/^https?:\/\/.+/i.test(baseUrl)) return bad(res, '请填写 OpenList 地址，例如 http://192.168.2.249:5244');
        if (!username || !password) return bad(res, '请填写 OpenList 账号和密码');
        if (!rootPath.startsWith('/')) return bad(res, '目录路径必须以 / 开头');
        // 建库前先真实登录并列一次目录，避免存进一个连不上的库
        let entries;
        try {
          entries = await alist.list(baseUrl, username, password, rootPath);
        } catch (e) {
          return bad(res, `连接 OpenList 失败：${e.message}`);
        }
        const synthetic = `alist://${baseUrl.replace(/^https?:\/\//i, '')}${rootPath}`;
        if (db.prepare('SELECT 1 FROM libraries WHERE path = ?').get(synthetic)) {
          return bad(res, '这个 OpenList 目录已经在媒体库列表里了');
        }
        const info = db.prepare(`
          INSERT INTO libraries (name, path, provider, base_url, username, password, root_path)
          VALUES (?,?,?,?,?,?,?)
        `).run(name, synthetic, 'ALIST', baseUrl, username, encryptSecret(password), rootPath);
        console.log(`[library] 新增 OpenList 媒体库 ${name} -> ${baseUrl}${rootPath}`);
        return ok(res, {
          id: Number(info.lastInsertRowid),
          entries: entries.length,
          libraries: listLibraries(),
        });
      }

      const rawPath = String(body.path || '').trim();
      if (!rawPath) return bad(res, '请填写文件夹路径');
      if (!path.isAbsolute(rawPath)) {
        return bad(res, '请填写绝对路径，例如 /mnt/nas/videos 或 D:\\Videos');
      }
      const resolved = path.resolve(rawPath);
      let st = null;
      try { st = fs.statSync(resolved); } catch { /* 目录不存在 */ }
      if (!st || !st.isDirectory()) return bad(res, `文件夹不存在或不可访问：${resolved}`);
      if (db.prepare('SELECT 1 FROM libraries WHERE path = ?').get(resolved)) {
        return bad(res, '这个文件夹已经在媒体库列表里了');
      }
      const info = db.prepare('INSERT INTO libraries (name, path) VALUES (?, ?)').run(name, resolved);
      console.log(`[library] 新增媒体库 ${name} -> ${resolved}`);
      return ok(res, { id: Number(info.lastInsertRowid), libraries: listLibraries() });
    }

    // 目录浏览：本地目录树
    if (p === '/api/browse/local' && req.method === 'POST') {
      const body = await jsonBody(req);
      if (!body.path) {
        // 未指定起点时返回可浏览的根：Windows 列出存在的盘符，其余系统为 /
        const roots = [];
        if (process.platform === 'win32') {
          for (let i = 65; i <= 90; i += 1) {
            const drive = `${String.fromCharCode(i)}:\\`;
            try { if (fs.statSync(drive).isDirectory()) roots.push(drive); } catch { /* 盘符不存在 */ }
          }
        } else {
          roots.push('/');
        }
        return ok(res, { path: null, parent: null, roots, dirs: [] });
      }
      const target = path.resolve(String(body.path));
      let entries;
      try {
        entries = fs.readdirSync(target, { withFileTypes: true });
      } catch (e) {
        return bad(res, `目录不可访问：${e.message}`);
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return ok(res, {
        path: target,
        parent: path.dirname(target) === target ? null : path.dirname(target),
        dirs: dirs.slice(0, 500),
      });
    }

    // 目录浏览：OpenList 目录树（未入库时用请求里的临时凭证，入库后用库里的凭证）
    if (p === '/api/browse/openlist' && req.method === 'POST') {
      const body = await jsonBody(req);
      let baseUrl, username, password;
      if (body.libraryId) {
        const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(body.libraryId));
        if (!row || row.provider !== 'ALIST') return bad(res, '媒体库不存在');
        baseUrl = row.base_url;
        username = row.username;
        password = decryptSecret(row.password);
      } else {
        baseUrl = alist.normalizeBase(body.baseUrl);
        username = String(body.username || '').trim();
        password = String(body.password || '');
        if (!/^https?:\/\/.+/i.test(baseUrl)) return bad(res, '请先填写 OpenList 地址');
        if (!username || !password) return bad(res, '请先填写 OpenList 账号密码');
      }
      const target = String(body.path || '/').trim() || '/';
      let entries;
      try {
        entries = await alist.list(baseUrl, username, password, target);
      } catch (e) {
        return bad(res, e.message);
      }
      const parent = target === '/' ? null : path.posix.dirname(target);
      return ok(res, {
        path: target,
        parent,
        dirs: entries.filter((e) => e.isDir)
          .map((e) => ({ name: e.name, path: `${target.replace(/\/+$/, '')}/${e.name}` }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      });
    }
    const libMatch = /^\/api\/libraries\/(\d+)$/.exec(p);
    if (libMatch && req.method === 'PUT') {
      const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libMatch[1]);
      if (!row) return send(res, 404, { error: '媒体库不存在' });
      const body = await jsonBody(req);
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return bad(res, '名称不能为空');
        if (db.prepare('SELECT 1 FROM libraries WHERE name = ? AND id <> ?').get(name, row.id)) {
          return bad(res, '媒体库名称重复');
        }
        db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name.slice(0, 40), row.id);
      }
      if (body.enabled !== undefined) {
        db.prepare('UPDATE libraries SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, row.id);
      }
      // 本地库可以改挂载目录：远程库没有本地路径，改不了
      if (body.path !== undefined) {
        if (row.provider !== 'LOCAL') return bad(res, 'OpenList 媒体库不能修改本地路径');
        const raw = String(body.path).trim();
        if (!raw || !path.isAbsolute(raw)) return bad(res, '请填写文件夹的绝对路径');
        const dir = path.resolve(raw);
        let st = null;
        try { st = fs.statSync(dir); } catch { /* 不存在，下面统一报错 */ }
        if (!st || !st.isDirectory()) return bad(res, `文件夹不存在：${dir}`);
        try { fs.accessSync(dir, fs.constants.W_OK); } catch { return bad(res, `文件夹不可写入：${dir}`); }
        // 把库里已有的文件搬到新目录，避免换目录后旧素材失效；
        // 跨分区 rename 会失败，退回复制后删源。
        const oldDir = row.path && path.resolve(row.path);
        if (oldDir && oldDir !== dir) {
          for (const item of db.prepare('SELECT filename, remote_path FROM media WHERE library_id = ?').all(row.id)) {
            if (item.remote_path) continue;
            const src = path.join(oldDir, item.filename);
            const dest = path.join(dir, item.filename);
            if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
            try { fs.renameSync(src, dest); } catch {
              try { fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); } catch { /* 单个文件失败不影响换目录 */ }
            }
          }
        }
        db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(dir, row.id);
        resetMainDir();
      }
      return ok(res, { libraries: listLibraries() });
    }
    if (libMatch && req.method === 'DELETE') {
      const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libMatch[1]);
      if (!row) return send(res, 404, { error: '媒体库不存在' });
      if (row.is_main) return bad(res, '主媒体库不能删除');
      const items = db.prepare('SELECT id, filename, remote_path FROM media WHERE library_id = ?').all(row.id);
      let disabledSchedules = 0;
      for (const item of items) {
        db.prepare('DELETE FROM media WHERE id = ?').run(item.id);
        disabledSchedules += detachFromSchedules((it) => it.mediaId === item.id);
        // 只删媒体目录里的引用或副本；远程库没有本地文件，外部库的源文件保持原样
        if (!item.remote_path) removeStoredFile(item.filename);
      }
      db.prepare('DELETE FROM libraries WHERE id = ?').run(row.id);
      if (items.length) notifyContentChanged();
      console.log(`[library] 删除媒体库 ${row.name}，移除 ${items.length} 个媒体`);
      return ok(res, { removedMedia: items.length, disabledSchedules });
    }
    const libScan = /^\/api\/libraries\/(\d+)\/scan$/.exec(p);
    if (libScan && req.method === 'POST') {
      req.resume();
      const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libScan[1]);
      if (!lib) return send(res, 404, { error: '媒体库不存在' });
      const existing = scanTasks.get(lib.id);
      if (existing && existing.running) return ok(res, existing);
      return ok(res, startScanTask(lib));
    }
    const libScanStatus = /^\/api\/libraries\/(\d+)\/scan\/status$/.exec(p);
    if (libScanStatus && req.method === 'GET') {
      const task = scanTasks.get(Number(libScanStatus[1]));
      return ok(res, task || { running: false });
    }

    // ----- 媒体 -----
    if (p === '/api/media' && req.method === 'GET') {
      return ok(res, db.prepare(`
        SELECT m.*, l.name AS libraryName, l.is_main AS libraryIsMain
        FROM media m LEFT JOIN libraries l ON l.id = m.library_id
        ORDER BY m.id DESC
      `).all());
    }
    if (p === '/api/media' && req.method === 'POST') {
      // Browsers send Content-Length for multipart uploads, so oversize files are rejected
      // before the whole body is streamed. Without this the connection is reset mid-transfer
      // and the page just stops at some percentage.
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD) {
        res.setHeader('Connection', 'close');
        req.resume();
        return send(res, 413, {
          error: `文件超过 ${MAX_UPLOAD_GB}GB 上限。更大的文件请复制到服务端媒体文件夹后点「扫描媒体文件夹」`,
        });
      }
      let up = await saveUpload(req);
      // 文件夹上传时保留相对路径（webkitRelativePath），如 火影/第01集.mp4
      // 完整保留用户选中的文件夹名，便于按文件夹分类展示
      const rel = (url.searchParams.get('relpath') || '').replace(/\\/g, '/').replace(/\.\.\/|^\//g, '');
      const seg = rel.split('/').filter(Boolean);
      const subPath = seg.length ? seg.join('/') : null;
      const kind = kindOf(up.filename);
      if (!kind) { fs.rmSync(up.tmp, { force: true }); return bad(res, '不支持的格式（仅图片/视频）'); }
      if (kind === 'VIDEO' && path.extname(up.filename).toLowerCase() === '.mkv' && isLegacyMkv(up.tmp, up.start)) {
        if (!ffmpegAvailable()) {
          fs.rmSync(up.tmp, { force: true });
          return send(res, 422, { error: '该 MKV 为 2008 年前后的旧封装，电视端无法解析。请在服务器安装 ffmpeg 后重新上传（将自动无损重封装），或手动执行 ffmpeg -i 文件.mkv -c copy 输出.mkv 后上传' });
        }
        const rr = await remuxMkv(up);
        if (rr.error) {
          fs.rmSync(up.tmp, { force: true });
          return send(res, 422, { error: rr.error });
        }
        up = rr.up;
        console.log(`[mkv] ${up.filename} 为旧封装，已自动重封装`);
      }
      const ext = path.extname(up.filename).toLowerCase();
      const pendingPath = path.join(mainDir(), `.pending-${crypto.randomUUID()}${ext}`);
      let sha256;
      if (up.start === 0) {
        // Remux output is already a plain media file, so move it instead of copying.
        fs.renameSync(up.tmp, pendingPath);
        sha256 = await sha256OfRange(pendingPath, 0, up.size - 1);
      } else {
        sha256 = await extractAndHash(up.tmp, up.start, up.end, pendingPath);
        fs.rmSync(up.tmp, { force: true });
      }
      const exists = db.prepare('SELECT * FROM media WHERE sha256 = ? AND kind = ?').get(sha256, kind);
      if (exists) {
        fs.rmSync(pendingPath, { force: true });
        return ok(res, { ...exists, duplicated: true });
      }
      const storeName = `${sha256.slice(0, 16)}${ext}`;
      const target = path.join(mainDir(), storeName);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      // Same-folder rename: the file is never copied a second time.
      fs.renameSync(pendingPath, target);
      const info = db.prepare(
        'INSERT INTO media (filename, orig_name, sha256, kind, size, library_id, sub_path) VALUES (?,?,?,?,?,?,?)'
      ).run(storeName, up.filename.slice(0, 120), sha256, kind, up.size, MAIN_LIBRARY_ID, subPath);
      notifyContentChanged();
      return ok(res, db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid));
    }
    let m = /^\/api\/media\/(\d+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(m[1]);
      if (!row) return send(res, 404, { error: '媒体不存在' });
      db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
      const disabledSchedules = detachFromSchedules((it) => it.mediaId === row.id);
      if (!row.remote_path) removeStoredFile(row.filename);
      notifyContentChanged();
      return ok(res, { disabledSchedules });
    }

    // ----- 默认节目单 -----
    if (p === '/api/program' && req.method === 'GET') {
      const items = db.prepare(`
        SELECT pi.id, pi.media_id AS mediaId, pi.duration_sec AS durationSec,
               m.orig_name AS name, m.kind, l.name AS libraryName, l.is_main AS libraryIsMain
        FROM program_items pi
        JOIN media m ON m.id = pi.media_id
        LEFT JOIN libraries l ON l.id = m.library_id
        ORDER BY pi.position`).all();
      return ok(res, items);
    }
    if (p === '/api/program' && req.method === 'PUT') {
      const { items } = await jsonBody(req);
      if (!Array.isArray(items)) return bad(res, 'items 须为数组');
      const tx = db.prepare('INSERT INTO program_items (media_id, position, duration_sec) VALUES (?,?,?)');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM program_items').run();
        items.forEach((it, i) => {
          if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(it.mediaId)) throw new Error(`媒体 ${it.mediaId} 不存在`);
          tx.run(it.mediaId, i, Number.isInteger(it.durationSec) && it.durationSec > 0 ? it.durationSec : null);
        });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      notifyContentChanged();
      return ok(res);
    }

    // ----- 时段计划 -----
    if (p === '/api/schedules' && req.method === 'GET') {
      const list = db.prepare('SELECT * FROM schedules').all().map(s => ({
        id: s.id, startMinute: s.start_minute, endMinute: s.end_minute,
        enabled: !!s.enabled, items: JSON.parse(s.items_json),
      }));
      return ok(res, list);
    }
    const upsertSchedule = async (id) => {
      const body = await jsonBody(req);
      const { startMinute, endMinute, enabled, items } = body;
      const others = db.prepare('SELECT * FROM schedules').all()
        .map(s => ({ ...s, enabled: !!s.enabled }));
      const errs = validateSchedule(
        { id, startMinute, endMinute, enabled: enabled !== false }, others);
      if (errs.length) return bad(res, errs.join('；'));
      const list = Array.isArray(items) ? items : [];
      // 停用状态允许留空，便于把已经没有内容的时段先关掉。
      if (list.length === 0 && enabled !== false) return bad(res, '时段节目单不能为空');
      if (list.length > 1) return bad(res, '一个时段只能有一个内容（一个直播源或一个媒体）');
      for (const it of list) {
        if (it.liveId != null) {
          if (!db.prepare('SELECT 1 FROM live_streams WHERE id = ?').get(it.liveId)) return bad(res, `直播源 ${it.liveId} 不存在`);
        } else if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(it.mediaId)) {
          return bad(res, `媒体 ${it.mediaId} 不存在`);
        }
      }
      const json = JSON.stringify(list.map(it => it.liveId != null
        ? { liveId: it.liveId }
        : {
            mediaId: it.mediaId,
            durationSec: Number.isInteger(it.durationSec) && it.durationSec > 0 ? it.durationSec : null,
          }));
      db.prepare(`INSERT INTO schedules (id, start_minute, end_minute, enabled, items_json)
                  VALUES (?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET start_minute=excluded.start_minute,
                    end_minute=excluded.end_minute, enabled=excluded.enabled, items_json=excluded.items_json`)
        .run(id, startMinute, endMinute, enabled === false ? 0 : 1, json);
      notifyContentChanged();
      return ok(res, { id });
    };
    if (p === '/api/schedules' && req.method === 'POST') return upsertSchedule(newScheduleId());
    m = /^\/api\/schedules\/([\w-]+)$/.exec(p);
    if (m && req.method === 'PUT') return upsertSchedule(m[1]);
    if (m && req.method === 'DELETE') {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(m[1]);
      notifyContentChanged();
      return ok(res);
    }

    // ----- 直播源 -----
    if (p === '/api/live' && req.method === 'GET') {
      return ok(res, db.prepare('SELECT * FROM live_streams ORDER BY id').all());
    }
    if (p === '/api/live' && req.method === 'POST') {
      const { name, url: liveUrl, force } = await jsonBody(req);
      if (!name || !String(name).trim()) return bad(res, '名称不能为空');
      if (!/^https?:\/\/.+/i.test(String(liveUrl || ''))) return bad(res, '地址须为 http(s) 协议');
      let probeResult = null;
      if (!force) {
        const probe = await probeLiveUrl(String(liveUrl).trim());
        if (!probe.ok || probe.verdict === 'slow') {
          const why = probe.ok ? '测速偏慢' : probe.reason;
          return send(res, 400, {
            error: `直播地址检测未通过：${why}（${probeSummary(probe)}）`,
            probeFailed: true, reason: why, probe,
          });
        }
        probeResult = probe;
      }
      const info = db.prepare('INSERT INTO live_streams (name, url) VALUES (?,?)')
        .run(String(name).trim().slice(0, 60), String(liveUrl).trim());
      notifyContentChanged();
      const row = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(info.lastInsertRowid);
      if (probeResult) row.probe = probeResult;
      return ok(res, row);
    }
    m = /^\/api\/live\/(\d+)\/check$/.exec(p);
    if (m && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(m[1]);
      if (!row) return send(res, 404, { error: '直播源不存在' });
      return ok(res, await probeLiveUrl(row.url));
    }
    m = /^\/api\/live\/(\d+)$/.exec(p);
    if (m && req.method === 'PUT') {
      const row = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(m[1]);
      if (!row) return send(res, 404, { error: '直播源不存在' });
      const { name, url: liveUrl, enabled, force } = await jsonBody(req);
      const newName = name != null ? String(name).trim().slice(0, 60) : row.name;
      const newUrl = liveUrl != null ? String(liveUrl).trim() : row.url;
      if (!newName) return bad(res, '名称不能为空');
      if (!/^https?:\/\/.+/i.test(newUrl)) return bad(res, '地址须为 http(s) 协议');
      if (!force && newUrl !== row.url) {
        const probe = await probeLiveUrl(newUrl);
        if (!probe.ok || probe.verdict === 'slow') {
          const why = probe.ok ? '测速偏慢' : probe.reason;
          return send(res, 400, {
            error: `直播地址检测未通过：${why}（${probeSummary(probe)}）`,
            probeFailed: true, reason: why, probe,
          });
        }
      }
      db.prepare('UPDATE live_streams SET name = ?, url = ?, enabled = ? WHERE id = ?')
        .run(newName, newUrl, enabled === undefined ? row.enabled : (enabled ? 1 : 0), row.id);
      notifyContentChanged();
      return ok(res);
    }
    if (m && req.method === 'DELETE') {
      const row = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(m[1]);
      if (!row) return send(res, 404, { error: '直播源不存在' });
      db.prepare('DELETE FROM live_streams WHERE id = ?').run(row.id);
      const disabledSchedules = detachFromSchedules((it) => it.liveId === row.id);
      notifyContentChanged();
      return ok(res, { disabledSchedules });
    }

    send(res, 404, { error: '接口不存在' });
  } catch (e) {
    send(res, e.status || (e.message === '文件过大' || /GB 上限/.test(e.message) ? 413 : 500), { error: e.message });
  }
});

// Node 18+ aborts requests after 300s by default, which kills slow large uploads.
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`管理后台:  http://localhost:${PORT}/`);
  if (lan) console.log(`局域网地址: http://${lan.address}:${PORT}/  (电视端 manifest: /api/manifest)`);
});
