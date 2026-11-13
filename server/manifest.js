// 节目单 / 时段 -> manifest.json（终端消费契约）
// schemaVersion=1；contentVersion 为内容哈希（由 server.js 计算），结构镜像 App 端播放配置
const crypto = require('crypto');

const MINUTES_PER_DAY = 1440;
const STEP = 30;

// 与 ScheduleRule.java 相同的窗口语义：start 含、end 不含；end<start 表示跨午夜
function containsMinute(start, end, minute) {
  return start < end
    ? (minute >= start && minute < end)
    : (minute >= start || minute < end);
}

function overlaps(a, b) {
  for (let m = 0; m < MINUTES_PER_DAY; m++) {
    if (containsMinute(a.start, a.end, m) && containsMinute(b.start, b.end, m)) return true;
  }
  return false;
}

// 校验单条规则；rules 为已存在的其他规则（用于重叠检查）
function validateSchedule({ id, startMinute, endMinute, enabled }, others) {
  const errs = [];
  for (const [name, v] of [['开始', startMinute], ['结束', endMinute]]) {
    if (!Number.isInteger(v) || v < 0 || v >= MINUTES_PER_DAY) errs.push(`${name}时间须为 0-1439 的整数`);
    else if (v % STEP !== 0) errs.push(`${name}时间须为 30 分钟步进`);
  }
  if (errs.length) return errs;
  if (startMinute === endMinute) errs.push('开始与结束时间不能相同');
  if (enabled) {
    for (const o of others) {
      if (o.id !== id && o.enabled && overlaps({ start: startMinute, end: endMinute },
        { start: o.start_minute, end: o.end_minute })) {
        errs.push(`与时段 ${o.start_minute}-${o.end_minute} 重叠`);
      }
    }
  }
  return errs;
}

function mediaItem(mediaRow, durationSec) {
  const item = {
    url: `media/${mediaRow.filename}`,
    sha256: mediaRow.sha256,
    kind: mediaRow.kind,
  };
  if (Number.isInteger(durationSec) && durationSec > 0) item.durationSec = durationSec;
  if (mediaRow.subtitle_file) item.subtitleUrl = `media/${mediaRow.subtitle_file}`;
  return item;
}

// 由媒体 id 列表生成节目单项；条目为 {mediaId, durationSec} 或 {liveId}，跳过已删除/已停用引用
function resolveItems(db, items) {
  const mediaStmt = db.prepare('SELECT * FROM media WHERE id = ?');
  const liveStmt = db.prepare('SELECT * FROM live_streams WHERE id = ? AND enabled = 1');
  const out = [];
  for (const it of items || []) {
    if (it.liveId != null) {
      const s = liveStmt.get(it.liveId);
      if (s) out.push({ url: s.url, kind: 'LIVE', name: s.name });
      continue;
    }
    const row = mediaStmt.get(it.mediaId);
    if (row) out.push(mediaItem(row, it.durationSec));
  }
  return out;
}

function buildManifest(db, contentVersion) {
  const draft = db.prepare(
    'SELECT media_id, duration_sec FROM program_items ORDER BY position'
  ).all();
  const defaultItems = resolveItems(db,
    draft.map(r => ({ mediaId: r.media_id, durationSec: r.duration_sec })));

  const schedules = db.prepare('SELECT * FROM schedules').all().map(s => ({
    id: s.id,
    startMinute: s.start_minute,
    endMinute: s.end_minute,
    enabled: !!s.enabled,
    program: { items: resolveItems(db, JSON.parse(s.items_json)) },
  }));

  return {
    schemaVersion: 1,
    contentVersion,
    defaultProgram: { items: defaultItems },
    schedules,
  };
}

const newScheduleId = () => crypto.randomUUID();

module.exports = { buildManifest, validateSchedule, newScheduleId };
