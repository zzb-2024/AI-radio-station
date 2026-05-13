/**
 * 本地持久化状态：播放历史、对话消息、偏好、日程。
 * 基于 lowdb。所有写操作都先 read 再 mutate 再 write，避免并发覆盖。
 */
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { config } from '../config.js';

const adapter = new JSONFile(config.paths.stateFile);
const db = new Low(adapter, { plays: [], messages: [], skips: [], prefs: {}, plan: {} });
await db.read();
let writeQueue = Promise.resolve();

function today() {
  return new Date().toISOString().slice(0, 10);
}

function queueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

async function readLatest() {
  await writeQueue;
  await db.read();
}

export const state = {
  async addPlay(song, artist = '', meta = {}) {
    await queueWrite(async () => {
      await db.read();
      db.data.plays.unshift({
        song,
        artist,
        album: String(meta.album || ''),
        raw: String(meta.raw || ''),
        ts: Date.now(),
      });
      if (db.data.plays.length > config.state.maxPlays) {
        db.data.plays = db.data.plays.slice(0, config.state.maxPlays);
      }
      await db.write();
    });
  },

  async addSkip(song, meta = {}) {
    return queueWrite(async () => {
      await db.read();
      db.data.skips ||= [];
      const event = normalizeSkipEvent(song, meta);
      if (!event) return null;
      db.data.skips.unshift(event);
      if (db.data.skips.length > config.state.maxSkips) {
        db.data.skips = db.data.skips.slice(0, config.state.maxSkips);
      }
      await db.write();
      return event;
    });
  },

  async recentSkips(n = 20) {
    await readLatest();
    return (db.data.skips || []).slice(0, n);
  },

  async latestSkip(maxAgeMs = 3 * 60 * 1000) {
    await readLatest();
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
    return (db.data.skips || []).find(item => Number(item?.ts || 0) >= cutoff) || null;
  },

  async annotateLatestSkip(patch = {}, maxAgeMs = 3 * 60 * 1000) {
    return queueWrite(async () => {
      await db.read();
      db.data.skips ||= [];
      const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
      const target = db.data.skips.find(item => Number(item?.ts || 0) >= cutoff);
      if (!target) return null;
      const next = normalizeSkipAnnotation(patch);
      Object.assign(target, next, {
        updatedAt: new Date().toISOString(),
      });
      await db.write();
      return target;
    });
  },

  async recentPlays(n = 20) {
    await readLatest();
    return db.data.plays.slice(0, n);
  },

  async addMessage(role, content) {
    await queueWrite(async () => {
      await db.read();
      db.data.messages.push({ role, content, ts: Date.now() });
      if (db.data.messages.length > config.state.maxMessages) {
        db.data.messages = db.data.messages.slice(-config.state.maxMessages);
      }
      await db.write();
    });
  },

  async addConversationTurn(userContent, assistantContent) {
    await queueWrite(async () => {
      await db.read();
      const now = Date.now();
      db.data.messages.push(
        { role: 'user', content: userContent, ts: now },
        { role: 'assistant', content: assistantContent, ts: now }
      );
      if (db.data.messages.length > config.state.maxMessages) {
        db.data.messages = db.data.messages.slice(-config.state.maxMessages);
      }
      await db.write();
    });
  },

  async getMessages(n = 10) {
    await readLatest();
    return db.data.messages.slice(-n);
  },

  async setPref(key, value) {
    await queueWrite(async () => {
      await db.read();
      db.data.prefs[key] = value;
      await db.write();
    });
  },

  async getPref(key, def = null) {
    await readLatest();
    return db.data.prefs[key] ?? def;
  },

  async setTodayPlan(content) {
    await queueWrite(async () => {
      await db.read();
      db.data.plan[today()] = content;
      await db.write();
    });
  },

  async getTodayPlan() {
    await readLatest();
    return db.data.plan[today()] || null;
  },
};

function normalizeSkipEvent(song, meta = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const name = String(song?.name || song?.song || '').trim();
  const artist = String(song?.artist || '').trim();
  if (!name && !artist) return null;
  const context = source.context && typeof source.context === 'object' ? source.context : {};
  return {
    id: makeSkipId(),
    song: name,
    artist,
    album: String(song?.album || source.album || '').trim(),
    raw: String(song?.raw || source.raw || `${name}${artist ? ` - ${artist}` : ''}`).trim(),
    playedMs: normalizeNumber(source.playedMs, 0),
    durationMs: normalizeNumber(source.durationMs, 0),
    skipStrength: normalizeNumber(source.skipStrength, 0),
    action: String(source.action || '').trim(),
    source: String(source.source || '').trim(),
    requestText: String(source.requestText || '').trim(),
    reasonText: String(source.reasonText || '').trim(),
    reasonLabels: Array.isArray(source.reasonLabels) ? source.reasonLabels.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : [],
    context: {
      weather: String(context.weather || source.weather || '').trim(),
      timePart: String(context.timePart || source.timePart || '').trim(),
      lastSong: String(context.lastSong || source.lastSong || '').trim(),
      queueReason: String(context.queueReason || source.queueReason || '').trim(),
      toplist: source.toplist && typeof source.toplist === 'object'
        ? {
            id: String(source.toplist.id || '').trim(),
            name: String(source.toplist.name || '').trim(),
            category: String(source.toplist.category || '').trim(),
          }
        : null,
    },
    ts: Date.now(),
  };
}

function normalizeSkipAnnotation(patch = {}) {
  const source = patch && typeof patch === 'object' ? patch : {};
  return {
    reasonText: String(source.reasonText || '').trim(),
    reasonLabels: Array.isArray(source.reasonLabels) ? source.reasonLabels.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : [],
    reasonSource: String(source.reasonSource || '').trim(),
  };
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function makeSkipId() {
  return `skip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
