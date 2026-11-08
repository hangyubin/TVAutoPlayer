'use strict';

/**
 * AList / OpenList 客户端。
 * 只依赖 Node 内置 fetch，接口按 AList v3 的 /api/auth/login、/api/fs/list、/api/fs/get 实现。
 */

const tokenCache = new Map();

function normalizeBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

async function call(baseUrl, pathName, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = token;
  const res = await fetch(`${normalizeBase(baseUrl)}${pathName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`接口返回异常（HTTP ${res.status}）`); }
  if (json.code !== 200) throw new Error(json.message || `接口错误 ${json.code}`);
  return json.data;
}

/** 用账号密码换 token，凭证不变时复用缓存。 */
async function login(baseUrl, username, password) {
  const key = `${normalizeBase(baseUrl)}|${username}|${password}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const data = await call(baseUrl, '/api/auth/login', { username, password });
  if (!data || !data.token) throw new Error('登录失败：未返回 token');
  tokenCache.set(key, { token: data.token, expiresAt: Date.now() + 6 * 3600 * 1000 });
  return data.token;
}

function dropToken(baseUrl, username, password) {
  tokenCache.delete(`${normalizeBase(baseUrl)}|${username}|${password}`);
}

/** 在 token 失效时自动重登一次。 */
async function withToken(baseUrl, username, password, run) {
  let token = await login(baseUrl, username, password);
  try {
    return await run(token);
  } catch (e) {
    if (!/401|token|login/i.test(e.message)) throw e;
    dropToken(baseUrl, username, password);
    token = await login(baseUrl, username, password);
    return run(token);
  }
}

/** 列出目录内容，最多取 maxPages 页。 */
async function list(baseUrl, username, password, dirPath, perPage = 200) {
  return withToken(baseUrl, username, password, async (token) => {
    const items = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await call(baseUrl, '/api/fs/list', {
        path: dirPath, page, per_page: perPage, refresh: false,
      }, token);
      const content = (data && data.content) || [];
      items.push(...content);
      if (content.length < perPage) break;
    }
    return items.map((item) => ({
      name: item.name,
      isDir: !!item.is_dir,
      size: Number(item.size) || 0,
      modified: item.modified || '',
    }));
  });
}

/** 取文件的云盘直链。 */
async function rawUrl(baseUrl, username, password, filePath) {
  return withToken(baseUrl, username, password, async (token) => {
    const data = await call(baseUrl, '/api/fs/get', { path: filePath }, token);
    if (!data || !data.raw_url) throw new Error('未取到直链');
    return data.raw_url;
  });
}

module.exports = { login, list, rawUrl, normalizeBase };
