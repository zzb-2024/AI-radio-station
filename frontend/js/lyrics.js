/**
 * LRC 歌词解析 + 同步跟随。
 */
import { CONFIG } from './config.js';

/**
 * 解析 LRC 文本为 [{t: seconds, text}] 时间递增数组。
 */
export function parseLrc(lrc) {
  if (!lrc) return [];
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    lines.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/**
 * 启动歌词同步。每 tick 找当前时间对应的歌词行写入 sink。
 * 返回一个停止函数。
 */
export function syncLyrics(audioEl, lrc, sink) {
  const lines = parseLrc(lrc);
  if (!lines.length) {
    sink('');
    return () => {};
  }
  let lastIdx = -1;
  const timer = setInterval(() => {
    const t = audioEl.currentTime;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= t) idx = i; else break;
    }
    if (idx !== lastIdx && idx >= 0) {
      sink(lines[idx].text);
      lastIdx = idx;
    }
  }, CONFIG.lyric.tickIntervalMs);
  return () => clearInterval(timer);
}
