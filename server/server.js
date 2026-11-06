// TVAutoPlayer 内容管理服务端（零依赖，Node >= 22.5）
// 终端接口: GET /api/manifest, GET /media/<file>
// 管理接口: /api/media /api/program /api/schedules
// 内容保存即生效：manifest 直接由当前数据生成，contentVersion 为内容哈希
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const db = require('./db');
const { buildManifest, validateSchedule, newScheduleId } = require('./manifest');

const PORT = process.env.PORT || 8080;
const MEDIA_DIR = path.join(__dirname, 'media');
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2GB
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 可选环境变量口令（兼容旧方案）

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
};

const kindOf = (filename) => {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'IMAGE';
  if (VIDEO_EXT.has(ext)) return 'VIDEO';
  return null;
};

// ---------- 工具 ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
const ok = (res, body = {}) => send(res, 200, body);
const bad = (res, msg) => send(res, 400, { error: msg });

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

// 流式保存上传：multipart 请求体直接写入临时文件，避免大文件占用内存
function saveUpload(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const m = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(contentType);
    if (!m) { req.resume(); return reject(new Error('缺少 boundary')); }
    const boundary = `--${m[1] || m[2]}`;
    const tmp = path.join(MEDIA_DIR, `.upload-${crypto.randomUUID()}.tmp`);
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
      if (size > MAX_UPLOAD) { fail(new Error('文件过大')); req.destroy(); }
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
    if (head.indexOf(boundary) !== 0) throw new Error('multipart 格式错误');
    const headerEnd = head.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('multipart 格式错误');
    const header = head.slice(0, headerEnd).toString('utf8');
    const fm = /filename="([^"]*)"/.exec(header);
    if (!fm) throw new Error('缺少文件名');
    const start = headerEnd + 4;
    // 结尾形如 \r\n--boundary--\r\n（部分客户端省略末尾换行）
    const tailLen = Math.max(0, Math.min(totalSize - start, boundary.length + 16));
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, totalSize - tailLen);
    const idx = tail.indexOf('\r\n' + boundary);
    if (idx < 0) throw new Error('multipart 结尾格式错误');
    const end = totalSize - tailLen + idx - 1;
    if (end < start) throw new Error('上传内容为空');
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
      const file = path.join(MEDIA_DIR, name);
      if (!fs.existsSync(file)) return send(res, 404, { error: '媒体不存在' });
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

    // ----- 媒体库 -----
    if (p === '/api/media' && req.method === 'GET') {
      return ok(res, db.prepare('SELECT * FROM media ORDER BY id DESC').all());
    }
    if (p === '/api/media' && req.method === 'POST') {
      let up = await saveUpload(req);
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
      const sha256 = await sha256OfRange(up.tmp, up.start, up.end);
      const exists = db.prepare('SELECT * FROM media WHERE sha256 = ? AND kind = ?').get(sha256, kind);
      if (exists) {
        fs.rmSync(up.tmp, { force: true });
        return ok(res, { ...exists, duplicated: true });
      }
      const storeName = `${sha256.slice(0, 16)}${path.extname(up.filename).toLowerCase()}`;
      await copyRange(up.tmp, up.start, up.end, path.join(MEDIA_DIR, storeName));
      fs.rmSync(up.tmp, { force: true });
      const info = db.prepare(
        'INSERT INTO media (filename, orig_name, sha256, kind, size) VALUES (?,?,?,?,?)'
      ).run(storeName, up.filename.slice(0, 120), sha256, kind, up.size);
      notifyContentChanged();
      return ok(res, db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid));
    }
    // 扫描服务器上的文件夹，把图片/视频批量导入媒体库（适合已有大量素材、网页上传太慢的场景）
    if (p === '/api/media/scan' && req.method === 'POST') {
      const body = await jsonBody(req);
      const rawDir = String(body.dir || '').trim();
      const scanDir = path.resolve(rawDir || path.join(__dirname, 'import'));
      // 默认导入目录不存在时自动创建，留空扫描不会直接报错
      if (!rawDir) { try { fs.mkdirSync(scanDir, { recursive: true }); } catch { /* 忽略创建失败 */ } }
      let st = null;
      try { st = fs.statSync(scanDir); } catch { /* 目录不存在 */ }
      if (!st || !st.isDirectory()) return bad(res, `文件夹不存在：${scanDir}`);
      if (path.resolve(scanDir) === path.resolve(MEDIA_DIR)) {
        return bad(res, '请选择其他文件夹；媒体目录由系统自动管理');
      }
      const MAX_FILES = 200;
      const files = [];
      let truncated = false;
      const walk = (dir, depth) => {
        if (truncated || depth > 5) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (truncated) return;
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (!e.isFile() || !kindOf(e.name)) continue;
          files.push(full);
          if (files.length >= MAX_FILES) { truncated = true; return; }
        }
      };
      walk(scanDir, 0);

      let added = 0, skipped = 0, failed = 0;
      const errors = [];
      for (const file of files) {
        try {
          const kind = kindOf(file);
          const statSize = fs.statSync(file).size;
          if (statSize <= 0) { failed++; errors.push(`${path.basename(file)}: 空文件`); continue; }
          const sha256 = await sha256OfRange(file, 0, statSize - 1);
          if (db.prepare('SELECT 1 FROM media WHERE sha256 = ? AND kind = ?').get(sha256, kind)) {
            skipped++;
            continue;
          }
          let source = file, srcStart = 0, srcEnd = statSize - 1, finalSize = statSize;
          let tmpRemux = null;
          if (kind === 'VIDEO' && path.extname(file).toLowerCase() === '.mkv' && isLegacyMkv(file, 0)) {
            if (!ffmpegAvailable()) {
              failed++;
              errors.push(`${path.basename(file)}: 旧封装 MKV，请先安装 ffmpeg`);
              continue;
            }
            const rr = await remuxMkv({ tmp: file, start: 0, end: statSize - 1, filename: path.basename(file) });
            if (rr.error) { failed++; errors.push(`${path.basename(file)}: ${rr.error}`); continue; }
            source = rr.up.tmp;
            srcStart = rr.up.start;
            srcEnd = rr.up.end;
            finalSize = rr.up.size;
            tmpRemux = rr.up.tmp;
          }
          const storeName = `${sha256.slice(0, 16)}${path.extname(file).toLowerCase()}`;
          await copyRange(source, srcStart, srcEnd, path.join(MEDIA_DIR, storeName));
          if (tmpRemux) fs.rmSync(tmpRemux, { force: true });
          db.prepare('INSERT INTO media (filename, orig_name, sha256, kind, size) VALUES (?,?,?,?,?)')
            .run(storeName, path.basename(file).slice(0, 120), sha256, kind, finalSize);
          added++;
        } catch (e) {
          failed++;
          errors.push(`${path.basename(file)}: ${e.message}`);
        }
      }
      if (added) notifyContentChanged();
      console.log(`[scan] ${scanDir} 扫描 ${files.length} 个，新增 ${added}，重复 ${skipped}，失败 ${failed}`);
      return ok(res, {
        dir: scanDir, scanned: files.length, added, skipped, failed, truncated,
        errors: errors.slice(0, 10),
      });
    }
    let m = /^\/api\/media\/(\d+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(m[1]);
      if (!row) return send(res, 404, { error: '媒体不存在' });
      db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
      for (const s of db.prepare('SELECT id, items_json FROM schedules').all()) {
        const items = JSON.parse(s.items_json).filter(it => it.mediaId !== row.id);
        db.prepare('UPDATE schedules SET items_json = ? WHERE id = ?').run(JSON.stringify(items), s.id);
      }
      fs.rmSync(path.join(MEDIA_DIR, row.filename), { force: true });
      notifyContentChanged();
      return ok(res);
    }

    // ----- 默认节目单 -----
    if (p === '/api/program' && req.method === 'GET') {
      const items = db.prepare(`
        SELECT pi.id, pi.media_id AS mediaId, pi.duration_sec AS durationSec,
               m.orig_name AS name, m.kind FROM program_items pi
        JOIN media m ON m.id = pi.media_id ORDER BY pi.position`).all();
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
      if (!Array.isArray(items) || items.length === 0) return bad(res, '时段节目单不能为空');
      if (items.length > 1) return bad(res, '一个时段只能有一个内容（一个直播源或一个媒体）');
      for (const it of items) {
        if (it.liveId != null) {
          if (!db.prepare('SELECT 1 FROM live_streams WHERE id = ?').get(it.liveId)) return bad(res, `直播源 ${it.liveId} 不存在`);
        } else if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(it.mediaId)) {
          return bad(res, `媒体 ${it.mediaId} 不存在`);
        }
      }
      const json = JSON.stringify(items.map(it => it.liveId != null
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
      for (const s of db.prepare('SELECT id, items_json FROM schedules').all()) {
        const items = JSON.parse(s.items_json).filter(it => it.liveId !== row.id);
        db.prepare('UPDATE schedules SET items_json = ? WHERE id = ?').run(JSON.stringify(items), s.id);
      }
      notifyContentChanged();
      return ok(res);
    }

    send(res, 404, { error: '接口不存在' });
  } catch (e) {
    send(res, e.message === '文件过大' ? 413 : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`管理后台:  http://localhost:${PORT}/`);
  if (lan) console.log(`局域网地址: http://${lan.address}:${PORT}/  (电视端 manifest: /api/manifest)`);
});
