const $ = (s) => document.querySelector(s);
const api = async (m, url, body, isForm) => {
  const r = await fetch(url, {
    method: m,
    credentials: 'same-origin',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast(data.error || ('错误 ' + r.status)); throw new Error(data.error); }
  return data;
};
const toast = (msg) => {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2500);
};
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// 选项卡
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + b.dataset.tab));
  load();
});

let media = [], program = [], lives = [];

// ----- 直播源 -----
async function loadLive() {
  lives = await api('GET', '/api/live');
  $('#liveList').innerHTML = lives.map(s => `<tr>
    <td>${esc(s.name)}</td>
    <td title="${esc(s.url)}" style="max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.url)}</td>
    <td><span class="tag ${s.enabled?'img':''}">${s.enabled?'启用':'停用'}</span></td>
    <td><button class="btn sub" onclick="checkLive(${s.id})">检测</button>
        <button class="btn sub" onclick="toggleLive(${s.id},${s.enabled?0:1})">${s.enabled?'停用':'启用'}</button>
        <button class="btn warn" onclick="delLive(${s.id})">删除</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">暂无直播源，添加后到「时段」中编排</td></tr>';
}
async function addLive(force) {
  const name = $('#liveName').value.trim(), url = $('#liveUrl').value.trim();
  if (!name || !url) return toast('请填写名称和地址');
  if (!force) toast('正在检测地址...');
  const r = await fetch('/api/live', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, force: !!force }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    $('#liveName').value = ''; $('#liveUrl').value = '';
    const p = data.probe;
    toast(force ? '已保存（未通过检测）' : `已添加，检测通过（延迟 ${p.latencyMs}ms · ${p.kbps} KB/s）`);
    loadLive();
    return;
  }
  if (r.status === 400 && data.probeFailed) {
    if (confirm(`${data.error}\n\n可能是服务器访问受限（电视端未必不能播），或该源速度确实偏慢。\n仍要保存吗？`)) {
      return addLive(true);
    }
    return;
  }
  toast(data.error || ('错误 ' + r.status));
}
$('#liveAdd').onclick = () => addLive(false);
window.checkLive = async (id) => {
  toast('检测中（约 5-10 秒）...');
  try {
    const d = await api('GET', '/api/live/' + id + '/check');
    if (d.ok && d.verdict === 'good') toast(`稳定 ✓ 延迟 ${d.latencyMs}ms · ${d.kbps} KB/s`);
    else if (d.ok) toast(`可用但偏慢 ⚠ 延迟 ${d.latencyMs}ms · ${d.kbps} KB/s`);
    else toast('检测失败：' + (d.reason || '未知原因'));
  } catch {}
};
window.toggleLive = async (id, enabled) => {
  await api('PUT', '/api/live/' + id, { enabled: !!enabled });
  toast(enabled ? '已启用' : '已停用'); loadLive();
};
window.delLive = async (id) => {
  if (!confirm('删除该直播源？引用它的时段会自动移除该项。')) return;
  const r = await api('DELETE', '/api/live/' + id);
  toast(r.disabledSchedules ? `已删除，${r.disabledSchedules} 个时段已自动停用` : '已删除');
  loadLive();
};
const liveNameOf = (id) => {
  const s = lives.find(x => x.id === id);
  return s ? `[直播] ${s.name}` : `[直播] #${id}（已删除）`;
};
const itemNameOf = (it) => it.liveId != null ? liveNameOf(it.liveId) : mediaNameOf(it.mediaId);

// ----- 媒体库 -----
// 媒体列表：筛选（文件名/媒体库/文件夹/类型）+ 分页，数据一次拉全后在前端切片
let mediaPageNo = 1;
// 网盘媒体所在文件夹：取 remote_path 的目录部分，并去掉媒体库根目录前缀，
// 例如 /阿里云盘/动漫/火影/01.mp4 → 动漫/火影；
// 本地上传文件夹时取 sub_path 的目录部分，例如 动漫/火影/01.mp4 → 动漫/火影；
// 本地单文件上传无目录概念，返回空
const folderOf = (m) => {
  // 本地上传：sub_path 形如 动漫/火影/01.mp4，直接位于根时返回空（与单文件上传同组）
  if (m.sub_path) {
    const i = m.sub_path.lastIndexOf('/');
    return i < 0 ? '' : m.sub_path.slice(0, i);
  }
  if (!m.remote_path) return '';
  // 网盘：remote_path 形如 /阿里云盘/动漫/火影/01.mp4，去掉媒体库根目录前缀
  let rp = m.remote_path.startsWith('/') ? m.remote_path.slice(1) : m.remote_path;
  const libName = m.libraryName || '';
  if (libName) {
    if (rp === libName) return '/';
    if (rp.startsWith(libName + '/')) rp = rp.slice(libName.length + 1);
  }
  const i = rp.lastIndexOf('/');
  return i < 0 ? '/' : rp.slice(0, i) || '/';
};
// 判断素材 m 是否属于文件夹 f（含子目录，如 动漫 含 动漫/火影）
const inFolder = (m, f) => {
  const mf = folderOf(m);
  if (f === '/') return mf === '/';   // 网盘库根目录：仅根目录下的文件
  if (!f) return mf === '';           // 本地媒体（含本地上传的根目录文件）
  return mf === f || mf.startsWith(f + '/');
};
function renderMediaList() {
  const kw = ($('#mediaSearch').value || '').trim().toLowerCase();
  const lib = $('#mediaLib').value;
  const folder = $('#mediaFolder').value;
  const kind = $('#mediaKind').value;
  const size = +$('#mediaSize').value || 20;
  const filtered = media.filter((m) => {
    if (lib && (m.libraryName || '主媒体库') !== lib) return false;
    if (folder && folderOf(m) !== folder) return false;
    if (kind && m.kind !== kind) return false;
    // 额外匹配目录路径（网盘 remote_path / 本地上传 sub_path），便于用剧名或文件夹名搜索
    return !kw || `${m.orig_name} ${m.remote_path || ''} ${m.sub_path || ''}`.toLowerCase().includes(kw);
  });
  // 排序：默认文件名自然排序（适配剧集编号）
  let list;
  if (mediaSort === 'time') list = filtered.slice().sort((a, b) => b.id - a.id);
  else if (mediaSort === 'folder') list = filtered.slice().sort((a, b) => naturalCompare(folderOf(a) + '/' + a.orig_name, folderOf(b) + '/' + b.orig_name));
  else list = filtered.slice().sort((a, b) => naturalCompare(a.orig_name, b.orig_name));
  const pages = Math.max(1, Math.ceil(list.length / size));
  mediaPageNo = Math.min(Math.max(1, mediaPageNo), pages);
  const rows = list.slice((mediaPageNo - 1) * size, mediaPageNo * size).map((m) => {
    const url = 'media/' + m.filename;
    const thumb = m.kind === 'IMAGE'
      ? `<img class="thumb" src="${url}" alt="" onclick="openPreview('${url}', 'IMAGE')">`
      : `<span class="thumb vid" onclick="openPreview('${url}', 'VIDEO')">▶ 视频</span>`;
    const folderLine = folderOf(m) ? `<div class="muted" style="font-size:11px">${esc(folderOf(m))}</div>` : '';
    return `<tr>
      <td>${thumb}</td><td title="${esc(m.orig_name)}">${esc(m.orig_name)}${folderLine}</td>
      <td><span class="tag ${m.kind==='IMAGE'?'img':'vid'}">${m.kind==='IMAGE'?'图片':'视频'}</span></td>
      <td><span class="tag ${m.libraryIsMain ? 'img' : 'vid'}">${esc(m.libraryName || '主库')}</span></td>
      <td>${fmtSize(m.size)}</td>
      <td><button class="btn sub" onclick="openPreview('${url}', '${m.kind}')">预览</button>
          <button class="btn warn" onclick="delMedia(${m.id})">删除</button></td></tr>`;
  });
  $('#mediaList').innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="6" class="muted" style="padding:16px 6px">${media.length ? '没有匹配的媒体' : '还没有媒体，先上传或扫描媒体库'}</td></tr>`;
  $('#mediaTotal').textContent = `共 ${list.length} 条` + (list.length !== media.length ? `（全部 ${media.length} 条）` : '');
  $('#mediaPage').textContent = `${mediaPageNo} / ${pages}`;
  $('#mediaPrev').disabled = mediaPageNo <= 1;
  $('#mediaNext').disabled = mediaPageNo >= pages;
  // 媒体库下拉跟随当前数据，保留用户已选的库
  const names = Array.from(new Set(media.map((m) => m.libraryName || '主媒体库')));
  const libSel = $('#mediaLib');
  if (libSel.dataset.built !== names.join('|')) {
    const keep = libSel.value;
    libSel.innerHTML = '<option value="">全部媒体库</option>' +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    libSel.value = names.includes(keep) ? keep : '';
    libSel.dataset.built = names.join('|');
  }
  // 文件夹下拉跟随当前媒体库选择，网盘库的目录按 remote_path 归类
  const folderSel = $('#mediaFolder');
  const folders = Array.from(new Set(
    media.filter((m) => !lib || (m.libraryName || '主媒体库') === lib).map(folderOf).filter(Boolean)
  )).sort();
  const folderKey = lib + '|' + folders.join('|');
  if (folderSel.dataset.built !== folderKey) {
    const keep = folderSel.value;
    folderSel.innerHTML = '<option value="">全部文件夹</option>' +
      folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    folderSel.value = folders.includes(keep) ? keep : '';
    folderSel.dataset.built = folderKey;
  }
}
$('#mediaSearch').oninput = () => { mediaPageNo = 1; renderMediaList(); };
$('#mediaLib').onchange = () => { mediaPageNo = 1; renderMediaList(); };
$('#mediaFolder').onchange = () => { mediaPageNo = 1; renderMediaList(); };
$('#mediaKind').onchange = () => { mediaPageNo = 1; renderMediaList(); };
$('#mediaSort').onchange = () => { mediaSort = $('#mediaSort').value; mediaPageNo = 1; renderMediaList(); };
$('#mediaSize').onchange = () => { mediaPageNo = 1; renderMediaList(); };
$('#mediaPrev').onclick = () => { mediaPageNo--; renderMediaList(); };
$('#mediaNext').onclick = () => { mediaPageNo++; renderMediaList(); };

async function loadMedia() {
  media = await api('GET', '/api/media');
  renderMediaList();
  await loadLibraries();
}
// 按媒体库分组，节目单素材选择器里能直接看出素材来自哪个库
function groupMedia() {
  const groups = new Map();
  for (const m of media) {
    const key = m.libraryName || '主媒体库';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return groups;
}
const mediaNameOf = (id) => {
  const m = media.find(x => x.id === id);
  return m ? m.orig_name : `#${id}（已删除）`;
};
const ensureMedia = async () => {
  media = await api('GET', '/api/media');
  if (!$('#progPicker').classList.contains('hidden')) renderPicker();
  if (!$('#pickModal').classList.contains('hidden')) renderPm();
};
window.openPreview = (url, kind) => {
  const p = $('#preview');
  p.innerHTML = `<span class="close-btn" onclick="closePreview()">× 关闭</span>` +
    (kind === 'VIDEO'
      ? `<video src="${url}" controls preload="metadata" style="max-width:92vw;max-height:88vh"></video>`
      : `<img src="${url}" alt="">`);
  p.classList.add('show');
  p.onclick = (e) => { if (e.target === p) closePreview(); };
};
window.closePreview = () => {
  const p = $('#preview'); p.classList.remove('show'); p.innerHTML = `<span class="close-btn" onclick="closePreview()">× 关闭</span>`;
  p.onclick = null;
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreview(); });
window.delMedia = async (id) => {
  const target = media.find(m => m.id === id);
  const hint = target && target.source_path
    ? `该媒体来自外部文件夹（${target.source_path}），只会从媒体库移除，源文件保留；下次扫描若仍在文件夹中会重新加入。`
    : '引用它的节目单会自动移除该项。';
  if (!confirm(`删除该媒体？${hint}`)) return;
  const r = await api('DELETE', '/api/media/' + id);
  toast(r.disabledSchedules ? `已删除，${r.disabledSchedules} 个时段已自动停用` : '已删除');
  load();
};
const fmtSize = (n) => n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.ceil(n/1024)+' KB';
const fmtSpeed = (b) => b > 1048576 ? (b/1048576).toFixed(1)+' MB/s' : Math.ceil(b/1024)+' KB/s';
// 上传队列：持久化状态，支持暂停/继续/删除单个排队项
let currentXhr = null, queueAbort = false, queueXhrs = [];
let uploadItems = [], uploading = false, uploadSourceInput = null;
const upBox = () => $('#uploadBox'), fill = () => $('#barFill'), state = () => $('#upState'), right = () => $('#upRight'), queues = () => $('#queues');
function showUp() { upBox().classList.add('show'); }
function hideUp() { upBox().classList.remove('show'); queues().innerHTML = ''; }
function setPct(p) { fill().classList.remove('indeterminate'); fill().style.width = Math.max(0, Math.min(100, p)) + '%'; }

// 渲染上传队列：每个条目可删除（仅等待/失败状态）
function renderQueue() {
  queues().innerHTML = uploadItems.map((it, i) => {
    const canRemove = it.status === 'pending' || it.status === 'fail';
    const label = it.status === 'uploading' ? `${it.pct || 0}%` : (it.label || it.status);
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12px;padding:2px 0">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.file.name)}">${i+1}. ${esc(it.file.name)}</span>
      <span class="tag" style="background:${it.tagBg||'#eef1f3'};color:${it.tagColor||'#1f2329'}">${esc(label)}</span>
      ${canRemove ? `<button class="btn warn" style="padding:2px 8px;font-size:11px" data-del="${i}">删除</button>` : ''}
    </div>`;
  }).join('');
}
// 删除排队项
$('#queues').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn || uploading) return;            // 上传中禁止删除（避免索引错位）
  const i = +btn.dataset.del;
  if (uploadItems[i] && (uploadItems[i].status === 'pending' || uploadItems[i].status === 'fail')) {
    uploadItems.splice(i, 1);
    renderQueue();
    updateUploadButtons();
  }
});

function uploadOne(item, total) {
  return new Promise((resolve) => {
    const file = item.file;
    const fd = new FormData(); fd.append('file', file);
    // 文件夹上传时携带相对路径，服务端保留文件夹结构
    const relpath = file.webkitRelativePath || '';
    const url = '/api/media' + (relpath ? '?relpath=' + encodeURIComponent(relpath) : '');
    const xhr = new XMLHttpRequest();
    queueXhrs.push(xhr);
    xhr.open('POST', url);
    // 大文件放宽超时：每 MB 约 2 秒，下限 5 分钟、上限 60 分钟
    xhr.timeout = Math.min(3_600_000, Math.max(300_000, file.size / 1e6 * 2000));
    let lastLoaded = 0, lastT = Date.now(), lastRender = 0;
    item.status = 'uploading'; item.label = '上传中'; item.tagBg = '#e8f1ff'; item.tagColor = '#1e5ab8';
    renderQueue();
    const doneCount = uploadItems.filter((it) => it.status === 'done' || it.status === 'dup').length;
    state().textContent = `[${doneCount + 1}/${total}] 上传 ${file.name}`;
    state().classList.remove('err');
    right().textContent = fmtSize(file.size);

    xhr.upload.onprogress = (e) => {
      if (queueAbort) { xhr.abort(); return; }
      if (e.lengthComputable) {
        const p = e.loaded / e.total * 100;
        item.pct = p;
        setPct(p);
        const now = Date.now();
        const dt = (now - lastT) / 1000;
        const speed = dt > 0 ? (e.loaded - lastLoaded) / dt : 0;
        lastLoaded = e.loaded; lastT = now;
        right().textContent = `${Math.round(p)}% · ${fmtSize(e.loaded)}/${fmtSize(e.total)} · ${fmtSpeed(speed)}`;
        if (e.loaded >= e.total) {
          state().textContent = `[${doneCount + 1}/${total}] 处理中 ${file.name}`;
          right().textContent = '服务端校验中…（大文件需要数秒）';
          fill().classList.add('indeterminate');
        }
        item.label = `${Math.round(p)}%`;
        if (now - lastRender < 150) return;
        lastRender = now;
        renderQueue();
      }
    };
    xhr.onload = () => {
      fill().classList.remove('indeterminate');
      if (queueAbort) { resolve({ ok: false, aborted: true }); return; }
      const ok = xhr.status >= 200 && xhr.status < 300;
      let reason = '';
      if (!ok) { try { reason = (JSON.parse(xhr.responseText) || {}).error || ''; } catch {} }
      let result = null;
      if (ok) { try { result = JSON.parse(xhr.responseText); } catch {} }
      const dup = !!(result && result.duplicated);
      item.status = ok ? (dup ? 'dup' : 'done') : 'fail';
      item.label = ok ? (dup ? '重复' : '✓') : '✗';
      item.tagBg = ok ? '#e3f0e8' : '#ffe3e3';
      item.tagColor = ok ? '#16633c' : '#b71c1c';
      renderQueue();
      if (!ok) {
        state().textContent = `失败：${file.name}`;
        state().classList.add('err');
        right().textContent = reason || `HTTP ${xhr.status}`;
      }
      resolve({ ok, result, duplicated: dup });
    };
    xhr.onerror = () => {
      fill().classList.remove('indeterminate');
      if (queueAbort) { resolve({ ok: false, aborted: true }); return; }
      state().textContent = `上传中断：${file.name}`;
      state().classList.add('err');
      right().textContent = '网络断开、文件超过大小上限或服务端已停止';
      item.status = 'fail'; item.label = '✗'; item.tagBg = '#ffe3e3'; item.tagColor = '#b71c1c';
      renderQueue(); resolve({ ok: false });
    };
    xhr.ontimeout = () => {
      fill().classList.remove('indeterminate');
      if (queueAbort) { resolve({ ok: false, aborted: true }); return; }
      state().textContent = `上传超时：${file.name}`;
      state().classList.add('err');
      right().textContent = '网络过慢，建议改用「扫描媒体文件夹」导入';
      item.status = 'fail'; item.label = '超时'; item.tagBg = '#ffe3e3'; item.tagColor = '#b71c1c';
      renderQueue(); resolve({ ok: false });
    };
    xhr.onabort = () => { resolve({ ok: false, aborted: true }); };
    xhr.withCredentials = true;
    xhr.send(fd);
  });
}

// ----- 媒体库管理 -----
let libraries = [];
async function loadLibraries() {
  libraries = await api('GET', '/api/libraries');
  renderLibraries();
}
function renderLibraries() {
  $('#libList').innerHTML = libraries.map((l) => {
    const remote = l.provider === 'ALIST';
    const source = remote ? `${l.baseUrl}${l.rootPath}` : l.path;
    return `
    <div class="lib-card">
      <div class="top">
        <span class="name" title="${esc(l.name)}">${esc(l.name)}</span>
        <span class="badge ${remote ? 'remote' : 'local'}">${remote ? 'OpenList' : '本地'}</span>
      </div>
      <div class="src" title="${esc(source)}">${esc(source)}</div>
      <div class="foot">
        <span class="count">${l.mediaCount} 个媒体${l.enabled ? '' : ' · 已停用'}${l.exists ? '' : ' · 不可访问'}</span>
        ${!remote && l.isMain ? `<button class="btn sub" onclick="pickMainPath(${l.id})">更换文件夹</button>` : ''}
        <button class="btn sub" id="scan-lib-${l.id}" onclick="scanLibrary(${l.id})">扫描</button>
        ${l.isMain ? '' : `<button class="btn warn" onclick="delLibrary(${l.id})">删除</button>`}
      </div>
    </div>`;
  }).join('');
}
async function scanLibrary(id) {
  const lib = libraries.find(l => l.id === id);
  const btn = document.getElementById(`scan-lib-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '扫描中...'; }
  try {
    const r = await api('POST', `/api/libraries/${id}/scan`, {});
    let msg = `${lib ? lib.name : '媒体库'}：扫描 ${r.scanned} 个，新增 ${r.added}，重复 ${r.skipped}`;
    if (r.already) msg += `，已入库跳过 ${r.already}`;
    if (r.failed) msg += `，失败 ${r.failed}`;
    if (r.truncated) msg += `（单次上限 ${r.limit} 个，请再次扫描）`;
    toast(msg);
    await loadMedia();
    await loadLibraries();
    if (r.errors && r.errors.length) console.warn('scan errors:', r.errors);
  } catch (e) {
    // api() 已提示原因
    if (btn) { btn.disabled = false; btn.textContent = '扫描'; }
  }
}
window.scanLibrary = scanLibrary;
window.delLibrary = async (id) => {
  const lib = libraries.find(l => l.id === id);
  if (!confirm(`删除媒体库「${lib ? lib.name : id}」？\n库内的 ${lib ? lib.mediaCount : ''} 个媒体会从媒体库和节目单中移除，外部源文件不会被删除。`)) return;
  try {
    const r = await api('DELETE', `/api/libraries/${id}`);
    let msg = `已删除媒体库与 ${r.removedMedia} 个媒体`;
    if (r.disabledSchedules) msg += `，${r.disabledSchedules} 个时段因内容被清空而停用`;
    toast(msg);
    await loadMedia();
    await loadLibraries();
    loadProgram();
    loadSchedules();
  } catch (e) { /* api() 已提示原因 */ }
};

// ----- 新增媒体库：选择对话框（左选来源、右浏览目录、底栏确认） -----
const libModal = $('#libModal');
const pick = {
  type: 'LOCAL', mode: 'add', libId: null, path: '', parent: null, dirs: [],
  baseUrl: '', username: '', password: '', connected: false,
};

function pickOpen() {
  Object.assign(pick, {
    type: 'LOCAL', mode: 'add', libId: null, path: '', parent: null, dirs: [],
    baseUrl: '', username: '', password: '', connected: false,
  });
  $('#pickBase').value = ''; $('#pickUser').value = ''; $('#pickPass').value = ''; $('#pickName').value = '';
  $('#pickCred').classList.add('hidden');
  document.querySelectorAll('.pick-src').forEach((el) => {
    el.style.display = '';
    el.classList.toggle('on', el.dataset.type === 'LOCAL');
  });
  $('#pickName').style.display = '';
  $('#pickOk').textContent = '添加并扫描';
  $('#pickConnect').disabled = false;
  $('#pickConnect').textContent = '连接';
  libModal.classList.add('show');
  pickBrowse('');
}
// 主媒体库更换存储文件夹：只允许本地目录，选中后保存并重新扫描
function pickMainPath(id) {
  const lib = libraries.find((l) => l.id === id);
  Object.assign(pick, {
    type: 'LOCAL', mode: 'main', libId: id, path: '', parent: null, dirs: [],
    baseUrl: '', username: '', password: '', connected: false,
  });
  $('#pickCred').classList.add('hidden');
  document.querySelectorAll('.pick-src').forEach((el) => {
    el.style.display = el.dataset.type === 'ALIST' ? 'none' : '';
    el.classList.toggle('on', el.dataset.type === 'LOCAL');
  });
  $('#pickName').style.display = 'none';
  $('#pickOk').textContent = '使用此文件夹';
  libModal.classList.add('show');
  pickBrowse(lib ? lib.path : '');
}
function pickClose() { libModal.classList.remove('show'); }

function pickCrumb() {
  if (!pick.path) return pick.type === 'LOCAL' ? '<span>电脑</span>' : '<span>根目录</span>';
  if (pick.type === 'ALIST') {
    const parts = pick.path.split('/').filter(Boolean);
    let acc = '';
    const links = parts.map((part) => {
      acc += `/${part}`;
      return `<a data-path="${esc(acc)}">${esc(part)}</a>`;
    });
    return `<a data-path="/">根目录</a>${links.map((l) => `<span>/</span>${l}`).join('')}`;
  }
  const sep = pick.path.includes('\\') ? '\\' : '/';
  const parts = pick.path.split(sep).filter(Boolean);
  let acc = sep === '\\' ? '' : '/';
  const links = parts.map((part) => {
    acc = sep === '\\' ? `${acc}${part}\\` : `${acc === '/' ? '' : acc}/${part}`;
    return `<a data-path="${esc(acc)}">${esc(part)}</a>`;
  });
  return links.length ? links.join(`<span>${sep}</span>`) : `<span>${esc(pick.path)}</span>`;
}

function pickRender() {
  const list = $('#pickList');
  $('#pickCrumb').innerHTML = pickCrumb();
  $('#pickPath').textContent = pick.path || '未选择';
  $('#pickOk').disabled = !pick.path;
  // 跳转框跟随当前位置，但用户正在输入时不覆盖
  const jump = $('#pickJump');
  if (document.activeElement !== jump) jump.value = pick.path || '';
  const waiting = pick.type === 'ALIST' && !pick.connected;
  document.querySelector('.pick-jump').classList.toggle('hidden', waiting);
  $('#pickTip').classList.toggle('hidden', waiting);
  if (waiting) {
    list.innerHTML = '<div class="pick-empty">先填写地址、账号、密码，点「连接」后浏览网盘目录。</div>';
    return;
  }
  const rows = [];
  if (pick.parent) {
    rows.push(`<div class="pick-item up" data-path="${esc(pick.parent)}"><span class="ico">↑</span><span>返回上级</span></div>`);
  }
  for (const d of pick.dirs) {
    rows.push(`<div class="pick-item" data-path="${esc(d.path)}"><span class="ico">▸</span><span>${esc(d.name)}</span></div>`);
  }
  list.innerHTML = rows.length
    ? rows.join('')
    : '<div class="pick-empty">该目录下没有子文件夹，可直接添加此目录。</div>';
}

async function pickBrowse(target) {
  try {
    if (pick.type === 'LOCAL') {
      const r = await api('POST', '/api/browse/local', { path: target || '' });
      if (r.roots) {
        pick.path = '';
        pick.parent = null;
        pick.dirs = r.roots.map((p) => ({ name: p, path: p }));
      } else {
        pick.path = r.path;
        pick.parent = r.parent;
        pick.dirs = r.dirs;
      }
    } else {
      const r = await api('POST', '/api/browse/openlist', {
        baseUrl: pick.baseUrl,
        username: pick.username,
        password: pick.password,
        path: target || '/',
      });
      pick.connected = true;
      pick.path = r.path;
      pick.parent = r.parent;
      pick.dirs = r.dirs;
    }
    if (!$('#pickName').value && pick.path) {
      const seg = pick.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if (seg && !/^[A-Za-z]:$/.test(seg)) $('#pickName').value = seg;
    }
    pickRender();
    return true;
  } catch (e) {
    pickRender(); // api() 已提示原因
    return false;
  }
}

// 目录点击用事件委托，列表重绘后不需要重新绑定
$('#pickList').onclick = (e) => {
  const item = e.target.closest('[data-path]');
  if (item) pickBrowse(item.dataset.path);
};
$('#pickCrumb').onclick = (e) => {
  const item = e.target.closest('[data-path]');
  if (item) pickBrowse(item.dataset.path);
};
// 直接输入路径直达（例如 /阿里云盘/电影），不必从根目录一层层点
const pickJumpTo = () => {
  const value = $('#pickJump').value.trim();
  if (!value) return;
  if (pick.type === 'ALIST' && !pick.connected) return toast('请先连接 OpenList');
  pickBrowse(value);
};
$('#pickJumpBtn').onclick = pickJumpTo;
$('#pickJump').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); pickJumpTo(); }
};
document.querySelectorAll('.pick-src').forEach((el) => {
  el.onclick = () => {
    if (pick.type === el.dataset.type) return;
    pick.type = el.dataset.type;
    pick.path = ''; pick.parent = null; pick.dirs = []; pick.connected = false;
    document.querySelectorAll('.pick-src').forEach((x) => x.classList.toggle('on', x === el));
    $('#pickCred').classList.toggle('hidden', pick.type !== 'ALIST');
    if (pick.type === 'LOCAL') pickBrowse('');
    else pickRender();
  };
});

$('#pickConnect').onclick = async () => {
  pick.baseUrl = $('#pickBase').value.trim();
  pick.username = $('#pickUser').value.trim();
  pick.password = $('#pickPass').value;
  if (!pick.baseUrl || !pick.username || !pick.password) return toast('请填写地址、账号和密码');
  const btn = $('#pickConnect');
  btn.disabled = true; btn.textContent = '连接中...';
  const connected = await pickBrowse('/');
  btn.disabled = false;
  btn.textContent = connected ? '重新连接' : '连接';
};

$('#libAddBtn').onclick = pickOpen;
$('#pickClose').onclick = pickClose;
$('#pickCancel').onclick = pickClose;
$('#libModal').onclick = (e) => { if (e.target === libModal) pickClose(); };
$('#pickOk').onclick = async () => {
  if (!pick.path) return toast('请先进入并选择目录');
  const btn = $('#pickOk');
  if (pick.mode === 'main') {
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const r = await api('PUT', `/api/libraries/${pick.libId}`, { path: pick.path });
      libraries = r.libraries;
      renderLibraries();
      pickClose();
      toast(`主媒体库已改到 ${pick.path}，正在扫描`);
      await scanLibrary(pick.libId);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '使用此文件夹';
    }
    return;
  }
  const name = ($('#pickName').value || '').trim();
  if (!name) return toast('请填写媒体库名称');
  btn.disabled = true; btn.textContent = '添加中...';
  try {
    const payload = pick.type === 'ALIST'
      ? {
        provider: 'ALIST', name, baseUrl: pick.baseUrl,
        username: pick.username, password: pick.password, rootPath: pick.path,
      }
      : { name, path: pick.path };
    const r = await api('POST', '/api/libraries', payload);
    pickClose();
    libraries = r.libraries;
    renderLibraries();
    toast(`「${name}」已添加，正在扫描`);
    await scanLibrary(r.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '添加并扫描';
  }
};

function startUpload(fileList, sourceInput) {
  const files = Array.from(fileList || []);
  if (!files.length) return toast('请先选择文件或文件夹');
  // 新建上传队列（覆盖上一次已完成/取消的队列）
  uploadItems = files.map((f) => ({ file: f, pct: 0, status: 'pending', label: '等待' }));
  uploadSourceInput = sourceInput;
  queueAbort = false; queueXhrs = [];
  showUp();
  fill().classList.remove('indeterminate'); fill().style.width = '0%';
  updateUploadButtons();
  runUpload();
}

// 执行队列：跳过已成功/重复的，处理 pending/fail
async function runUpload() {
  if (uploading) return;
  uploading = true;
  queueAbort = false; queueXhrs = [];
  $('#uploadBtn').disabled = true;
  $('#uploadFolderBtn').disabled = true;
  state().classList.remove('err');
  updateUploadButtons();

  const total = uploadItems.length;
  for (const item of uploadItems) {
    if (queueAbort) break;
    if (item.status === 'done' || item.status === 'dup') continue; // 已成功的跳过
    await uploadOne(item, total);
  }

  uploading = false;
  const ok = uploadItems.filter((it) => it.status === 'done').length;
  const dup = uploadItems.filter((it) => it.status === 'dup').length;
  const fail = uploadItems.filter((it) => it.status === 'fail').length;
  const pending = uploadItems.filter((it) => it.status === 'pending').length;

  $('#uploadBtn').disabled = false;
  $('#uploadFolderBtn').disabled = false;
  setPct(100);
  if (queueAbort) {
    state().textContent = `已暂停：成功 ${ok} · 重复 ${dup} · 待传 ${pending + fail}`;
    right().textContent = '点「继续」从断点续传已完成的会自动跳过';
  } else {
    state().textContent = `完成：成功 ${ok}  ·  重复 ${dup}  ·  失败 ${fail}`;
    state().classList.toggle('err', fail > 0);
    right().textContent = fail > 0 ? `有 ${fail} 个失败，可删除后点「重传失败项」` : '';
  }
  toast(queueAbort ? '已暂停' : `上传完成（成功 ${ok}，重复 ${dup}，失败 ${fail}）`);
  if (uploadSourceInput) uploadSourceInput.value = '';
  if (!queueAbort && fail === 0) setTimeout(hideUp, 2500);
  if (ok > 0 || dup > 0) load();
  updateUploadButtons();
}

// 暂停：中止当前传输，保留队列状态
function pauseUpload() {
  queueAbort = true;
  queueXhrs.forEach((x) => { try { x.abort(); } catch {} });
}
// 继续：从断点续传（pending/fail 重传，done/dup 跳过）
function resumeUpload() {
  if (uploading) return;
  const remaining = uploadItems.filter((it) => it.status === 'pending' || it.status === 'fail');
  if (!remaining.length) { toast('没有需要继续上传的文件'); return; }
  runUpload();
}
// 重传失败项：仅重试失败的
function retryFailed() {
  if (uploading) return;
  const failed = uploadItems.filter((it) => it.status === 'fail');
  if (!failed.length) { toast('没有失败项需要重传'); return; }
  failed.forEach((it) => { it.status = 'pending'; it.label = '等待'; });
  runUpload();
}
// 清空队列
function clearUpload() {
  uploadItems = [];
  uploadSourceInput = null;
  queueAbort = false;
  hideUp();
  updateUploadButtons();
}

// 根据状态更新上传控制区按钮
function updateUploadButtons() {
  const pending = uploadItems.filter((it) => it.status === 'pending' || it.status === 'fail').length;
  const fail = uploadItems.filter((it) => it.status === 'fail').length;
  const hasItems = uploadItems.length > 0;
  const cancel = $('#uploadCancel');
  const retry = $('#uploadRetry');
  // 上传中：显示「暂停」，隐藏重传
  if (uploading) {
    cancel.style.display = '';
    cancel.textContent = '暂停';
    cancel.onclick = pauseUpload;
    retry.style.display = 'none';
    return;
  }
  // 上传已暂停/结束
  if (hasItems && pending > 0) {
    cancel.style.display = '';
    cancel.textContent = '继续上传';
    cancel.onclick = resumeUpload;
  } else if (hasItems) {
    cancel.style.display = '';
    cancel.textContent = '清空队列';
    cancel.onclick = clearUpload;
  } else {
    cancel.style.display = 'none';
  }
  // 有失败项时显示「重传失败项」
  retry.style.display = (hasItems && fail > 0) ? '' : 'none';
}
$('#uploadRetry').onclick = retryFailed;

$('#uploadBtn').onclick = () => startUpload($('#file').files, $('#file'));
$('#uploadFolderBtn').onclick = () => $('#folderFile').click();
$('#folderFile').onchange = () => startUpload($('#folderFile').files, $('#folderFile'));

// ----- 默认节目单 -----
async function loadProgram() {
  await ensureMedia();
  program = await api('GET', '/api/program');
  renderProgram();
}
function renderProgram() {
  $('#progCount').textContent = '共 ' + program.length + ' 项';
  if (!program.length) {
    $('#progList').innerHTML = '<tr><td colspan="5" class="muted" style="padding:18px 6px">节目单为空，点上方「选择素材」挑选内容。</td></tr>';
    return;
  }
  $('#progList').innerHTML = program.map((it, i) => {
    // 通过 mediaId 反查所属文件夹，同名剧集来自不同目录时可区分
    const m = media.find((x) => x.id === it.mediaId);
    const folder = m ? folderOf(m) : '';
    const folderLine = folder ? `<div class="muted" style="font-size:11px">${esc(folder)}</div>` : '';
    return `<tr class="drag-row" draggable="true" data-index="${i}">
    <td class="drag-handle">☰ ${i+1}</td><td title="${esc(it.name)}">${esc(it.name)}${folderLine}</td>
    <td><span class="tag ${it.libraryIsMain ? 'img' : 'vid'}">${esc(it.libraryName || '主库')}</span></td>
    <td>${it.durationSec ? it.durationSec+' 秒' : '<span class="muted">默认</span>'}</td>
    <td><button class="btn warn" onclick="rmItem(${i})">移除</button></td></tr>`;
  }).join('');
}
window.rmItem = (i) => {
  program.splice(i, 1);
  renderProgram();
  if (!$('#progPicker').classList.contains('hidden')) renderPicker();
};

// 节目单排序：文件名自然排序（第01集 < 第02集 < 第10集），可正序/倒序
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const strCmp = (a, b) => nameCollator.compare(a || '', b || '');
const progFolderOf = (it) => {
  const m = media.find((x) => x.id === it.mediaId);
  return m ? folderOf(m) : '';
};
function sortProgram(mode) {
  if (!program.length) return;
  switch (mode) {
    case 'name-asc':  program.sort((a, b) => strCmp(a.name, b.name)); break;
    case 'name-desc': program.sort((a, b) => strCmp(b.name, a.name)); break;
    case 'folder-asc':  program.sort((a, b) => strCmp(progFolderOf(a), progFolderOf(b)) || strCmp(a.name, b.name)); break;
    case 'folder-desc': program.sort((a, b) => strCmp(progFolderOf(b), progFolderOf(a)) || strCmp(b.name, a.name)); break;
    case 'lib-asc':  program.sort((a, b) => strCmp(a.libraryName, b.libraryName) || strCmp(a.name, b.name)); break;
    case 'dur-asc':  program.sort((a, b) => (a.durationSec || 0) - (b.durationSec || 0) || strCmp(a.name, b.name)); break;
    case 'dur-desc': program.sort((a, b) => (b.durationSec || 0) - (a.durationSec || 0) || strCmp(a.name, b.name)); break;
    case 'manual':
    default: return; // 手动：不改变当前顺序
  }
  renderProgram();
}
// 随机打乱节目单顺序
function shuffleProgram() {
  for (let i = program.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [program[i], program[j]] = [program[j], program[i]];
  }
  $('#progListSort').value = 'manual';
  renderProgram();
}
$('#progListSort').onchange = (e) => sortProgram(e.target.value);
$('#progShuffle').onclick = shuffleProgram;

// 拖动排序：把行拖到另一行的位置即可
let dragFrom = -1;
const progList = $('#progList');
const clearDragMarks = () => {
  progList.querySelectorAll('tr').forEach(el => el.classList.remove('dragging', 'drop-target'));
};
progList.addEventListener('dragstart', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || tr.dataset.index === undefined) return;
  dragFrom = +tr.dataset.index;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch {}
  tr.classList.add('dragging');
});
progList.addEventListener('dragend', () => { dragFrom = -1; clearDragMarks(); });
progList.addEventListener('dragover', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || dragFrom < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDragMarks();
  tr.classList.add('drop-target');
});
progList.addEventListener('dragleave', (e) => {
  if (!progList.contains(e.relatedTarget)) clearDragMarks();
});
progList.addEventListener('drop', (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  const tr = e.target.closest('tr');
  const to = tr && tr.dataset.index !== undefined ? +tr.dataset.index : program.length - 1;
  if (to !== dragFrom) {
    const [moved] = program.splice(dragFrom, 1);
    program.splice(to, 0, moved);
  }
  dragFrom = -1;
  clearDragMarks();
  $('#progListSort').value = 'manual';
  renderProgram();
});
// 素材选择：按库筛选 + 分类（全部/图片/视频）+ 搜索 + 缩略图卡片
// 点卡片即勾选，可连续选多项，再点「加入节目单」一次追加
let progKind = '';
const picked = new Set();
// 素材选择器按文件夹分层浏览：null 表示文件夹总览，进入后为该目录路径
let pickFolder = null;
// 单次最多渲染的卡片数，防止几千个素材一次性堆进页面卡死
const PICK_RENDER_MAX = 300;
// 素材排序：默认文件名自然排序（适配 第01集~第10集 这类编号），可选按文件夹或时间
let pickSort = 'name';
let mediaSort = 'name';
const naturalCompare = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
// 记录当前选择器筛选后的全部素材，供「全选/反选」使用（不只限渲染出的 300 个）
let pickView = [];
const folderLabel = (f) => {
  if (!f) return '（本地媒体）';
  if (f === '/') return '（根目录）';
  return f.split('/').filter(Boolean).pop() || f;
};

function updatePickBar() {
  $('#pickCount').textContent = picked.size;
  $('#pickAddSelected').disabled = picked.size === 0;
}

function renderPicker() {
  updatePickBar();
  const groups = groupMedia();
  const names = Array.from(groups.keys());
  const sel = $('#progLib');
  // 媒体库增减时才重建下拉，避免每次刷新把用户选的库重置掉
  if (sel.dataset.built !== names.join('|')) {
    const keep = sel.value;
    sel.innerHTML = '<option value="">全部媒体库</option>' +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = names.includes(keep) ? keep : '';
    sel.dataset.built = names.join('|');
  }
  const only = sel.value;
  const kw = ($('#progSearch').value || '').trim().toLowerCase();
  const list = media.filter((m) => {
    if (only && (m.libraryName || '主媒体库') !== only) return false;
    return !kw || `${m.orig_name} ${m.remote_path || ''} ${m.sub_path || ''}`.toLowerCase().includes(kw);
  });
  const items = list.filter((m) => !progKind || m.kind === progKind);
  const count = (kind) => kind ? list.filter((m) => m.kind === kind).length : list.length;
  $('#progKind').innerHTML = [['', '全部'], ['IMAGE', '图片'], ['VIDEO', '视频']]
    .map(([kind, label]) => `<button data-kind="${kind}" class="${progKind === kind ? 'on' : ''}">${label} ${count(kind)}</button>`)
    .join('');
  if (!items.length) {
    if (list.length) {
      $('#progPickList').innerHTML = `<p class="muted">当前筛选（${progKind === 'IMAGE' ? '图片' : '视频'}）没有素材。</p>`;
      return;
    }
    $('#progPickList').innerHTML = only
      ? `<p class="muted">「${esc(only)}」${kw ? '没有匹配的素材' : '还没有素材，去「媒体库」点该库卡片上的「扫描」'}。</p>`
      : '<p class="muted">媒体库为空，请先在「媒体库」上传或扫描。</p>';
    return;
  }
  const used = new Set(program.map((it) => it.mediaId));
  const cardOf = (m) => `
    <div class="pick-card ${used.has(m.id) ? 'used' : ''} ${picked.has(m.id) ? 'picked' : ''}" data-id="${m.id}" title="${esc(m.orig_name)}${used.has(m.id) ? '（已在节目单）' : ''}">
      <span class="check">✓</span>
      <span class="sel"></span>
      ${m.kind === 'IMAGE'
        ? `<img class="thumb" loading="lazy" src="/media/${encodeURIComponent(m.filename)}" alt="">`
        : '<div class="thumb vid">视频</div>'}
      <div class="nm">${esc(m.orig_name)}</div>
      <div class="ft">
        <span class="tag ${m.kind === 'IMAGE' ? 'img' : 'vid'}">${m.kind === 'IMAGE' ? '图片' : '视频'}</span>
        <span class="lib" title="${esc((m.libraryName || '主媒体库') + (folderOf(m) ? ' · ' + folderOf(m) : ''))}">${esc(m.libraryName || '主媒体库')}${folderOf(m) ? ` · ${esc(folderOf(m))}` : ''}</span>
      </div>
    </div>`;
  // 文件夹总览
  if (!kw && pickFolder === null) {
    const groups = new Map();
    for (const m of items) {
      const f = folderOf(m);
      groups.set(f, (groups.get(f) || 0) + 1);
    }
    if (groups.size > 1 || !groups.has('')) {
      $('#progPickList').innerHTML = Array.from(groups.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
        .map(([f]) => {
          // 该文件夹下的素材（含子目录），数量与勾选范围保持一致
          const allIn = items.filter((m) => inFolder(m, f));
          const selCount = allIn.filter((m) => picked.has(m.id) || used.has(m.id)).length;
          const allPicked = allIn.length > 0 && selCount === allIn.length;
          return `
      <div class="pick-card folder ${allPicked ? 'picked' : ''}" data-folder="${esc(f)}" title="${esc(f || '（本地媒体）')}">
        <span class="check" data-folder-check="${esc(f)}" title="勾选此文件夹全部素材（含子目录）">✓</span>
        <div class="fico">📁</div>
        <div class="fname">${esc(folderLabel(f))}</div>
        <div class="fcount">${allIn.length} 个素材${selCount ? ` · 已选 ${selCount}` : ''}</div>
        <div class="fenter muted" data-folder-enter="${esc(f)}">进入 ›</div>
      </div>`;
        }).join('');
      return;
    }
  }
  // 文件夹内部 / 搜索结果：平铺渲染，但限制数量防止卡顿
  // pickFolder 为 null 表示未进入文件夹（如只有本地媒体、没有可分组目录），此时展示全部素材
  let view = kw || pickFolder === null ? items : items.filter((m) => folderOf(m) === pickFolder);
  // 排序：默认文件名自然排序（第01集、第02集…第10集 正确排序）
  if (pickSort === 'time') view = view.slice().sort((a, b) => b.id - a.id);
  else if (pickSort === 'folder') view = view.slice().sort((a, b) => naturalCompare(folderOf(a) + '/' + a.orig_name, folderOf(b) + '/' + b.orig_name));
  else view = view.slice().sort((a, b) => naturalCompare(a.orig_name, b.orig_name));
  pickView = view;
  const slice = view.slice(0, PICK_RENDER_MAX);
  const backBar = (!kw && pickFolder !== null)
    ? `<div class="pick-crumb"><button class="btn sub" data-back="1">‹ 返回文件夹</button><span class="muted">${esc(pickFolder || folderLabel(pickFolder))} · 共 ${view.length} 个</span></div>`
    : '';
  const moreTip = view.length > slice.length
    ? `<div class="pick-crumb muted">只显示前 ${PICK_RENDER_MAX} 个，请用搜索或文件夹缩小范围</div>`
    : '';
  if (!view.length && pickFolder !== null) {
    $('#progPickList').innerHTML = backBar + '<div class="pick-crumb muted">这个文件夹没有匹配素材</div>';
    return;
  }
  $('#progPickList').innerHTML = backBar + slice.map(cardOf).join('') + moreTip;
}
$('#progLib').onchange = () => { pickFolder = null; renderPicker(); };
$('#progSort').onchange = () => { pickSort = $('#progSort').value; renderPicker(); };
$('#progSearch').oninput = renderPicker;
$('#progKind').onclick = (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  progKind = btn.dataset.kind;
  renderPicker();
};
$('#progPickList').onclick = (e) => {
  if (e.target.closest('[data-back]')) { pickFolder = null; renderPicker(); return; }
  // 勾选框：直接选中/取消该文件夹（含子目录）全部素材，不进入文件夹
  const fchk = e.target.closest('[data-folder-check]');
  if (fchk) {
    const f = fchk.dataset.folderCheck;
    // 与文件夹卡片渲染时相同的筛选口径（媒体库 + 类型），避免误选其他媒体库的素材
    const only = $('#progLib').value;
    const base = media.filter((m) =>
      (!only || (m.libraryName || '主媒体库') === only) && (!progKind || m.kind === progKind));
    const allIn = base.filter((m) => inFolder(m, f));
    const usedIds = new Set(program.map((it) => it.mediaId));
    const allDone = allIn.length > 0 && allIn.every((m) => picked.has(m.id) || usedIds.has(m.id));
    let n = 0;
    for (const m of allIn) {
      if (usedIds.has(m.id)) continue;
      if (allDone) picked.delete(m.id);
      else if (!picked.has(m.id)) { picked.add(m.id); n++; }
    }
    renderPicker();
    toast(allDone ? '已取消该文件夹勾选' : `已勾选 ${n} 个素材`);
    return;
  }
  // 「进入」按钮：进入文件夹浏览
  const fenter = e.target.closest('[data-folder-enter]');
  if (fenter) { pickFolder = fenter.dataset.folderEnter; renderPicker(); return; }
  const card = e.target.closest('.pick-card');
  if (!card) return;
  // 文件夹卡片其余区域：进入文件夹
  if (card.dataset.folder !== undefined) { pickFolder = card.dataset.folder; renderPicker(); return; }
  const id = +card.dataset.id;
  if (program.some((it) => it.mediaId === id)) return toast('该素材已在节目单里');
  if (picked.has(id)) { picked.delete(id); card.classList.remove('picked'); }
  else { picked.add(id); card.classList.add('picked'); }
  updatePickBar();
};
// 全选当前视图（含未渲染的素材，不限于前 300 个）
$('#pickSelectAll').onclick = () => {
  let n = 0;
  for (const m of pickView) {
    if (program.some((it) => it.mediaId === m.id)) continue;
    if (!picked.has(m.id)) { picked.add(m.id); n++; }
  }
  renderPicker();
  toast(`已勾选 ${n} 项`);
};
// 反选当前视图
$('#pickInvert').onclick = () => {
  for (const m of pickView) {
    if (program.some((it) => it.mediaId === m.id)) continue;
    if (picked.has(m.id)) picked.delete(m.id); else picked.add(m.id);
  }
  renderPicker();
};
$('#pickClearSel').onclick = () => {
  picked.clear();
  renderPicker();
};
$('#pickAddSelected').onclick = () => {
  if (!picked.size) return toast('请先勾选素材');
  const dur = +$('#progDur').value || null;
  let added = 0;
  for (const id of picked) {
    if (program.some((it) => it.mediaId === id)) continue;
    const m = media.find((x) => x.id === id);
    if (!m) continue;
    program.push({
      mediaId: id,
      durationSec: m.kind === 'IMAGE' ? dur : null,
      name: m.orig_name,
      kind: m.kind,
      libraryName: m.libraryName,
      libraryIsMain: m.libraryIsMain,
    });
    added++;
  }
  picked.clear();
  renderProgram();
  renderPicker();
  toast(`已添加 ${added} 项，点「保存」生效`);
};
$('#progPickToggle').onclick = async () => {
  const p = $('#progPicker');
  p.classList.toggle('hidden');
  if (p.classList.contains('hidden')) { picked.clear(); return; }
  await ensureMedia(); // 素材可能还没拉回来，等一次再渲染
  renderPicker();
};
$('#progSave').onclick = async () => {
  await api('PUT', '/api/program', { items: program.map(it => ({ mediaId: it.mediaId, durationSec: it.durationSec })) });
  toast('节目单已保存，电视端将在 30 秒内自动生效'); loadProgram();
};

// ----- 时段计划 -----
const minuteOpts = () => {
  let h = '';
  for (let m = 0; m < 1440; m += 30)
    h += `<option value="${m}">${String(m/60|0).padStart(2,'0')}:${String(m%60).padStart(2,'0')}</option>`;
  return h;
};
$('#schStart').innerHTML = minuteOpts(); $('#schEnd').innerHTML = minuteOpts();
$('#schStart').value = 480; $('#schEnd').value = 1080;
let schedules = [];
let schTimeEditing = -1;
const fmtMin = (m) => `${String(m/60|0).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

async function loadSchedules() {
  await ensureMedia();
  await loadLive();
  schedules = await api('GET', '/api/schedules');
  schTimeEditing = -1;
  renderSchedules();
}
function renderSchedules() {
  $('#schList').innerHTML = schedules.map((s, si) => {
    const rows = s.items.map((it, i) => `<tr class="drag-row" draggable="true" data-sch="${si}" data-index="${i}">
      <td class="drag-handle">☰ ${i+1}</td>
      <td title="${esc(itemNameOf(it))}">${esc(itemNameOf(it))}</td>
      <td>${it.durationSec ? it.durationSec+' 秒' : '<span class="muted">默认</span>'}</td>
      <td><button class="btn warn" onclick="schRmItem(${si},${i})">移除</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">暂无内容</td></tr>';
    const timeEdit = schTimeEditing === si
      ? `<div class="row" style="margin-top:8px">
          <select id="editStart">${minuteOpts()}</select><span>至</span><select id="editEnd">${minuteOpts()}</select>
          <button class="btn" onclick="schSaveTime(${si})">确定</button>
          <button class="btn sub" onclick="schCancelTime()">取消</button>
        </div>` : '';
    return `<div class="card" style="background:#f8f9fa;margin-top:12px">
      <div class="row">
        <strong>${fmtMin(s.startMinute)} - ${fmtMin(s.endMinute)}${s.endMinute < s.startMinute ? '（跨午夜）' : ''}</strong>
        <span class="tag">${s.enabled ? '启用' : '停用'}</span>
        <span class="muted">${s.items.length ? esc(itemNameOf(s.items[0])) : '无内容'}</span>
        <span class="grow"></span>
        <button class="btn sub" onclick="schStartEditTime(${si})">修改时间</button>
        <button class="btn sub" onclick="toggleSch(${si})">${s.enabled ? '停用' : '启用'}</button>
        <button class="btn warn" onclick="delSch(${si})">删除</button>
        <button class="btn" onclick="saveSch(${si})">保存</button>
      </div>
      ${timeEdit}
      <table style="margin-top:8px"><thead><tr>
        <th style="width:60px">拖动</th><th>文件</th><th style="width:80px">时长</th><th style="width:80px">操作</th>
      </tr></thead><tbody>${rows}</tbody></table>
      ${s.items.length
        ? `<div class="row" style="margin-top:8px">
             <span class="muted grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(itemNameOf(s.items[0]))}">当前：${esc(itemNameOf(s.items[0]))}</span>
             <input type="number" id="schItemDur${si}" min="1" placeholder="图片秒数" style="width:100px">
             <button class="btn sub" onclick="pickForSchedule(${si},'replace')">更换素材</button>
           </div>`
        : `<div class="row" style="margin-top:8px">
             <button class="btn sub" onclick="pickForSchedule(${si},'add')">选择素材</button>
             <input type="number" id="schItemDur${si}" min="1" placeholder="图片秒数" style="width:100px">
           </div>`}
    </div>`;
  }).join('') || '<p class="muted" style="margin-top:12px">暂无时段</p>';
  if (schTimeEditing >= 0 && schedules[schTimeEditing]) {
    $('#editStart').value = schedules[schTimeEditing].startMinute;
    $('#editEnd').value = schedules[schTimeEditing].endMinute;
  }
  // 图片已设时长时回填输入框，方便看出当前配置
  schedules.forEach((s, si) => {
    const el = $(`#schItemDur${si}`);
    if (el && s.items[0] && s.items[0].durationSec) el.value = s.items[0].durationSec;
  });
}

// 时段内的拖动排序（仅同一时段内）
let schDragFrom = null;
const schList = $('#schList');
const clearSchDragMarks = () => {
  schList.querySelectorAll('tr').forEach(el => el.classList.remove('dragging', 'drop-target'));
};
schList.addEventListener('dragstart', (e) => {
  const tr = e.target.closest('tr[data-sch]');
  if (!tr) return;
  schDragFrom = { sch: +tr.dataset.sch, index: +tr.dataset.index };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', ''); } catch {}
  tr.classList.add('dragging');
});
schList.addEventListener('dragend', () => { schDragFrom = null; clearSchDragMarks(); });
schList.addEventListener('dragover', (e) => {
  const tr = e.target.closest('tr[data-sch]');
  if (!tr || !schDragFrom || +tr.dataset.sch !== schDragFrom.sch) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearSchDragMarks();
  tr.classList.add('drop-target');
});
schList.addEventListener('drop', (e) => {
  if (!schDragFrom) return;
  const tr = e.target.closest('tr[data-sch]');
  if (!tr || +tr.dataset.sch !== schDragFrom.sch) return;
  e.preventDefault();
  const items = schedules[schDragFrom.sch].items;
  const to = +tr.dataset.index;
  if (to !== schDragFrom.index) {
    const [moved] = items.splice(schDragFrom.index, 1);
    items.splice(to, 0, moved);
  }
  schDragFrom = null;
  renderSchedules();
});

window.schStartEditTime = (si) => { schTimeEditing = si; renderSchedules(); };
window.schCancelTime = () => { schTimeEditing = -1; renderSchedules(); };
window.schSaveTime = async (si) => {
  const st = +$('#editStart').value, en = +$('#editEnd').value;
  if (st === en) return toast('开始与结束时间不能相同');
  const s = schedules[si];
  try {
    await api('PUT', '/api/schedules/' + s.id, {
      startMinute: st, endMinute: en, enabled: s.enabled, items: s.items,
    });
    schTimeEditing = -1;
    toast('时间已保存');
    loadSchedules();
  } catch {}
};
// ----- 通用内容选择弹窗：文件夹分层 + 搜索，选中即回调 -----
const pmState = { lib: '', kw: '', kind: '', folder: null, onPick: null };
const pmLabelOf = (val) => val.startsWith('live:') ? liveNameOf(+val.slice(5)) : mediaNameOf(+val);
async function openMediaPicker(title, onPick) {
  await ensureMedia();
  if (!lives.length) { try { await loadLive(); } catch {} }
  pmState.lib = ''; pmState.kw = ''; pmState.kind = ''; pmState.folder = null; pmState.onPick = onPick;
  $('#pickModalTitle').textContent = title;
  $('#pmSearch').value = ''; $('#pmKind').value = '';
  $('#pickModal').classList.remove('hidden');
  renderPm();
}
function closeMediaPicker() {
  $('#pickModal').classList.add('hidden');
  pmState.onPick = null;
}
function renderPm() {
  // 媒体库下拉
  const names = Array.from(new Set(media.map((m) => m.libraryName || '主媒体库')));
  const libSel = $('#pmLib');
  libSel.innerHTML = '<option value="">全部媒体库</option>' +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  libSel.value = names.includes(pmState.lib) ? pmState.lib : '';
  const list = media.filter((m) => {
    if (pmState.lib && (m.libraryName || '主媒体库') !== pmState.lib) return false;
    if (pmState.kind && m.kind !== pmState.kind) return false;
    return !pmState.kw || `${m.orig_name} ${m.remote_path || ''}`.toLowerCase().includes(pmState.kw);
  });
  const parts = [];
  const cardOf = (m) => `
    <div class="pick-card" data-id="${m.id}" title="${esc(m.orig_name)}">
      ${m.kind === 'IMAGE'
        ? `<img class="thumb" loading="lazy" src="/media/${encodeURIComponent(m.filename)}" alt="">`
        : '<div class="thumb vid">视频</div>'}
      <div class="nm">${esc(m.orig_name)}</div>
      <div class="ft">
        <span class="tag ${m.kind === 'IMAGE' ? 'img' : 'vid'}">${m.kind === 'IMAGE' ? '图片' : '视频'}</span>
        <span class="lib" title="${esc(folderOf(m) || '本地媒体')}">${esc(folderLabel(folderOf(m)))}</span>
      </div>
    </div>`;
  // 顶层（未搜索、未进文件夹）时，直播源直接平铺在最前，数量少无需分类
  const atRoot = !pmState.kw && pmState.folder === null;
  if (atRoot && lives.length) {
    parts.push('<div class="pick-crumb muted">直播源</div>');
    parts.push(...lives.map((s) => `
      <div class="pick-card" data-live="${s.id}" title="${esc(s.name)}">
        <div class="thumb vid">直播</div>
        <div class="nm">${esc(s.name)}</div>
        <div class="ft"><span class="tag vid">HLS</span><span class="lib">${s.enabled ? '启用' : '停用'}</span></div>
      </div>`));
  }
  // 顶层先给文件夹总览，点进去再看素材，避免几千个卡片一次性渲染
  if (atRoot) {
    const groups = new Map();
    for (const m of list) { const f = folderOf(m); groups.set(f, (groups.get(f) || 0) + 1); }
    if (groups.size > 1 || !groups.has('')) {
      parts.push(...Array.from(groups.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
        .map(([f, n]) => `
        <div class="pick-card folder" data-folder="${esc(f)}" title="${esc(f || '（本地媒体）')}">
          <div class="fico">📁</div>
          <div class="fname">${esc(folderLabel(f))}</div>
          <div class="fcount">${n} 个素材</div>
        </div>`));
      $('#pmList').innerHTML = parts.join('');
      return;
    }
  }
  if (!pmState.kw && pmState.folder !== null) {
    const inside = list.filter((m) => folderOf(m) === pmState.folder);
    parts.push(`<div class="pick-crumb"><button class="btn sub" data-back="1" type="button">‹ 返回文件夹</button>
      <span class="muted">${esc(folderLabel(pmState.folder))} · 共 ${inside.length} 个</span></div>`);
  }
  const view = pmState.kw || pmState.folder === null ? list : list.filter((m) => folderOf(m) === pmState.folder);
  parts.push(...view.slice(0, PICK_RENDER_MAX).map(cardOf));
  if (view.length > PICK_RENDER_MAX) {
    parts.push(`<div class="pick-crumb muted">只显示前 ${PICK_RENDER_MAX} 个，请用搜索或文件夹缩小范围</div>`);
  }
  $('#pmList').innerHTML = parts.length ? parts.join('') : '<p class="muted">没有匹配的素材</p>';
}
$('#pmList').onclick = (e) => {
  if (e.target.closest('[data-back]')) { pmState.folder = null; renderPm(); return; }
  const card = e.target.closest('.pick-card');
  if (!card) return;
  if (card.dataset.folder !== undefined) { pmState.folder = card.dataset.folder; renderPm(); return; }
  const val = card.dataset.live != null ? `live:${card.dataset.live}` : String(card.dataset.id);
  const cb = pmState.onPick;
  closeMediaPicker();
  if (cb) cb(val);
};
$('#pmSearch').oninput = () => { pmState.kw = $('#pmSearch').value.trim().toLowerCase(); renderPm(); };
$('#pmKind').onchange = () => { pmState.kind = $('#pmKind').value; renderPm(); };
$('#pmLib').onchange = () => { pmState.lib = $('#pmLib').value; pmState.folder = null; renderPm(); };
$('#pickModalClose').onclick = closeMediaPicker;
$('#pickModal').onclick = (e) => { if (e.target === $('#pickModal')) closeMediaPicker(); };

// 时段选内容：弹窗选中后直接添加/替换
window.pickForSchedule = (si, mode) => openMediaPicker(
  mode === 'replace' ? '更换时段内容' : '选择时段内容',
  (val) => {
    let item;
    if (val.startsWith('live:')) {
      item = { liveId: +val.slice(5) };
    } else {
      const m = media.find((x) => x.id === +val);
      if (!m) return toast('媒体不存在');
      const dur = +($(`#schItemDur${si}`)?.value || 0) || null;
      item = { mediaId: m.id, durationSec: m.kind === 'IMAGE' ? dur : null };
    }
    const s = schedules[si];
    if (mode === 'replace') {
      s.items = [item];
      toast('已替换，点「保存」生效');
    } else {
      if (s.items.length) return toast('一个时段只能有一个内容，请用「更换素材」');
      s.items.push(item);
    }
    renderSchedules();
  });
window.schRmItem = (si, i) => { schedules[si].items.splice(i, 1); renderSchedules(); };
// 启用/停用立即生效（与「修改时间」一致），避免切页签后状态丢失
window.toggleSch = async (si) => {
  const s = schedules[si];
  const next = !s.enabled;
  try {
    await api('PUT', '/api/schedules/' + s.id, {
      startMinute: s.startMinute, endMinute: s.endMinute, enabled: next, items: s.items,
    });
    toast(next ? '时段已启用' : '时段已停用');
    loadSchedules();
  } catch {}
};
window.saveSch = async (si) => {
  const s = schedules[si];
  if (!s.items.length) return toast('时段节目单不能为空');
  try {
    await api('PUT', '/api/schedules/' + s.id, {
      startMinute: s.startMinute, endMinute: s.endMinute, enabled: s.enabled, items: s.items,
    });
    toast('时段已保存');
    loadSchedules();
  } catch {}
};
window.delSch = async (si) => {
  if (confirm('删除该时段？')) {
    await api('DELETE', '/api/schedules/' + schedules[si].id);
    toast('已删除'); loadSchedules();
  }
};
$('#schPickMedia').onclick = () => openMediaPicker('选择时段内容', (val) => {
  $('#schMedia').value = val;
  $('#schMediaName').textContent = pmLabelOf(val);
});
$('#schAdd').onclick = async () => {
  const v = $('#schMedia').value; if (!v) return toast('请先选择时段内容');
  let item;
  if (v.startsWith('live:')) {
    item = { liveId: +v.slice(5) };
  } else {
    const mediaId = +v;
    const m = media.find(x => x.id === mediaId);
    if (!m) return toast('媒体不存在');
    item = { mediaId, durationSec: m.kind === 'IMAGE' ? (+$('#schDur').value || null) : null };
  }
  try {
    await api('POST', '/api/schedules', {
      startMinute: +$('#schStart').value, endMinute: +$('#schEnd').value,
      items: [item],
    });
    toast('时段已添加，修改内容后点「保存」');
    $('#schMedia').value = ''; $('#schMediaName').textContent = '未选择';
    loadSchedules();
  } catch {}
};

function load() {
  const tab = document.querySelector('nav button.on').dataset.tab;
  if (tab === 'media') loadMedia();
  else if (tab === 'program') loadProgram();
  else if (tab === 'live') loadLive();
  else if (tab === 'schedules') loadSchedules();
}

// ---------- 认证 ----------
async function checkAuth() {
  try {
    const me = await fetch('/api/me').then(r => r.ok ? r.json() : null);
    if (me && me.username) {
      $('#whoLabel').textContent = me.username;
      $('#userPanel').classList.remove('hidden');
      $('#loginForm').classList.add('hidden');
      return true;
    }
  } catch {}
  showLogin(); return false;
}
function showLogin() {
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
  document.querySelector('nav').classList.add('hidden');
  $('#userPanel').classList.add('hidden');
  $('#loginForm').classList.remove('hidden');
}
function showMain() {
  document.querySelector('nav').classList.remove('hidden');
  // 恢复媒体库为初始 tab，且只显示当前页签的内容
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'media'));
  document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-media'));
}
$('#loginBtn').onclick = async () => {
  try {
    await api('POST', '/api/login', { username: $('#loginUser').value, password: $('#loginPass').value });
    $('#loginPass').value = '';
    await checkAuth();
    showMain();
    load();
  } catch {}
};
$('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
$('#logoutBtn').onclick = async () => {
  await api('POST', '/api/logout');
  showLogin();
};
$('#openPwd').onclick = () => { $('#pwdModal').classList.add('show'); };
$('#cancelPwd').onclick = () => { $('#pwdModal').classList.remove('show'); ['oldPwd','newPwd','newPwd2'].forEach(id=>$('#'+id).value=''); };
$('#pwdModal').onclick = (e) => { if (e.target.id === 'pwdModal') $('#cancelPwd').click(); };
$('#savePwd').onclick = async () => {
  const oldP = $('#oldPwd').value, n1 = $('#newPwd').value, n2 = $('#newPwd2').value;
  if (!n1 || n1.length < 4) return toast('新密码至少 4 位');
  if (n1 !== n2) return toast('两次输入不一致');
  try { await api('PUT', '/api/password', { oldPassword: oldP, newPassword: n1 }); toast('密码已更新'); $('#cancelPwd').click(); } catch {}
};

checkAuth().then(ok => { if (ok) { showMain(); load(); } });
