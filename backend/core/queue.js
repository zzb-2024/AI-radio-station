/**
 * 解析 AI 返回的曲目列表：搜歌 + 拿播放地址 + 拿高清封面 + 拿歌词。
 * 所有子任务并行，单曲失败不影响整体。
 *
 * 注意：`url` 字段不是直连 CDN 地址，而是同源代理 `/api/song/stream?id={id}`。
 * 同源播放让前端能把 <audio> 接进 Web Audio 拿真实频谱（网易云 CDN 不返回 CORS 头，
 * 直连时 AnalyserNode 会被浏览器置零）。如果 getUrl 返回 null，说明无可播放资源
 * （版权 / 未登录 VIP），url 设为 null，前端按 "locked" 渲染并跳过。
 */
import { config } from '../config.js';
import { search, getUrl, getDetail, getLyric } from '../services/ncm.js';

export async function resolveQueue(playList, { eagerLyricCount = 1 } = {}) {
  const tasks = (playList || []).map(async (raw, index) => {
    try {
      return await hydrateQueueSong(raw, {
        includeLyric: index < Math.max(0, Number(eagerLyricCount) || 0),
      });
    } catch {
      return null;
    }
  });

  const settled = await Promise.allSettled(tasks);
  return settled
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);
}

export async function hydrateQueueSong(raw, { includeLyric = true } = {}) {
  const base = await resolveBaseSong(raw);
  if (!base?.id) return null;
  const needsDetail = !base.album || !base.duration || !base.cover || !base.artist;

  const [cdnUrl, detail, lyric] = await Promise.all([
    base.url ? Promise.resolve(base.url) : getUrl(base.id).catch(() => null),
    needsDetail ? getDetail(base.id).catch(() => null) : Promise.resolve(null),
    includeLyric ? getLyric(base.id).catch(() => '') : Promise.resolve(base.lyric || ''),
  ]);

  return {
    ...base,
    artist: detail?.artist || base.artist,
    album: detail?.album || base.album || '',
    cover: detail?.cover || base.cover || null,
    duration: detail?.duration || base.duration || null,
    publishTime: detail?.publishTime || base.publishTime || null,
    lyric: lyric || base.lyric || '',
    url: base.url || (cdnUrl ? `/api/song/stream?id=${base.id}` : null),
    raw: base.raw,
  };
}

async function resolveBaseSong(raw) {
  if (raw && typeof raw === 'object' && raw.id) {
    return {
      id: Number(raw.id),
      name: String(raw.name || ''),
      artist: String(raw.artist || ''),
      fee: Number(raw.fee || 0),
      album: String(raw.album || ''),
      cover: raw.cover || null,
      duration: Number(raw.duration || 0) || null,
      publishTime: Number(raw.publishTime || 0) || null,
      lyric: String(raw.lyric || ''),
      url: raw.url || null,
      requestText: String(raw.requestText || ''),
      requestReason: String(raw.requestReason || ''),
      segue: String(raw.segue || ''),
      reasonLabels: Array.isArray(raw.reasonLabels) ? raw.reasonLabels : [],
      toplist: raw.toplist || null,
      musicPlan: raw.musicPlan || null,
      weather: String(raw.weather || ''),
      timePart: String(raw.timePart || ''),
      raw: String(raw.raw || `${raw.name || ''} - ${raw.artist || ''}`).trim(),
    };
  }

  const keyword = String(raw || '').trim();
  if (!keyword) return null;
  const songs = await search(keyword, config.queue.searchLimitPerItem);
  if (!songs.length) return null;
  const base = songs[0];
  return {
    ...base,
    raw: keyword,
  };
}
