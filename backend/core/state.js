/**
 * 本地持久化状态：播放历史、对话消息、偏好、日程。
 * 基于 lowdb。所有写操作都先 read 再 mutate 再 write，避免并发覆盖。
 */
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { config } from '../config.js';

const adapter = new JSONFile(config.paths.stateFile);
const db = new Low(adapter, { plays: [], messages: [], prefs: {}, plan: {} });
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
