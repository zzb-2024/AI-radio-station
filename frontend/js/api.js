/**
 * 与后端通信的薄封装。返回 JSON，统一处理错误。
 */
import { CONFIG, wsUrl } from './config.js';

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export const api = {
  chat(message, requestId, mode = 'auto') {
    return jsonFetch(CONFIG.api.chat, { method: 'POST', body: JSON.stringify({ message, requestId, mode }) });
  },
  now() {
    return jsonFetch(CONFIG.api.now);
  },
  getProfile() {
    return jsonFetch(CONFIG.api.profile);
  },
  saveProfile(profile) {
    return jsonFetch(CONFIG.api.profile, {
      method: 'POST',
      body: JSON.stringify({ profile }),
    });
  },
  getProfileSuggestion() {
    return jsonFetch(CONFIG.api.profileSuggestion);
  },
  djPreview() {
    return jsonFetch('/api/dj/preview', { method: 'POST' });
  },
  markDjPreview(nextSongId) {
    return jsonFetch('/api/dj/preview/mark', {
      method: 'POST',
      body: JSON.stringify({ nextSongId }),
    });
  },
  play(action, index) {
    return jsonFetch('/api/play', {
      method: 'POST',
      body: JSON.stringify({ action, index }),
    });
  },
  next() {
    return this.play('next');
  },
  prev() {
    return this.play('prev');
  },
};

/**
 * 创建一个带消息处理的 WebSocket。
 * @param {(data:object)=>void} onMessage
 * @returns {WebSocket}
 */
export function connectWs(onMessage) {
  const ws = new WebSocket(wsUrl());
  ws.onmessage = e => {
    try { onMessage(JSON.parse(e.data)); }
    catch (err) { console.warn('[ws] bad frame', err); }
  };
  return ws;
}
