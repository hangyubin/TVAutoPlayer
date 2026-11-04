// TVAutoPlayer 内容管理服务端（零依赖，Node >= 22.5）
// 终端接口: GET /api/manifest, GET /media/<file>
// 管理接口: /api/media /api/program /api/schedules
// 内容保存即生效：manifest 直接由当前数据生成，contentVersion 为内容哈希
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

const jsonBody = async (req) => {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw new Error('请求体不是合法 JSON'); }
};

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
      const up = await saveUpload(req);
      const kind = kindOf(up.filename);
      if (!kind) { fs.rmSync(up.tmp, { force: true }); return bad(res, '不支持的格式（仅图片/视频）'); }
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
      return ok(res, db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid));
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
      for (const it of items) {
        if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(it.mediaId)) return bad(res, `媒体 ${it.mediaId} 不存在`);
      }
      const json = JSON.stringify(items.map(it => ({
        mediaId: it.mediaId,
        durationSec: Number.isInteger(it.durationSec) && it.durationSec > 0 ? it.durationSec : null,
      })));
      db.prepare(`INSERT INTO schedules (id, start_minute, end_minute, enabled, items_json)
                  VALUES (?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET start_minute=excluded.start_minute,
                    end_minute=excluded.end_minute, enabled=excluded.enabled, items_json=excluded.items_json`)
        .run(id, startMinute, endMinute, enabled === false ? 0 : 1, json);
      return ok(res, { id });
    };
    if (p === '/api/schedules' && req.method === 'POST') return upsertSchedule(newScheduleId());
    m = /^\/api\/schedules\/([\w-]+)$/.exec(p);
    if (m && req.method === 'PUT') return upsertSchedule(m[1]);
    if (m && req.method === 'DELETE') {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(m[1]);
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
