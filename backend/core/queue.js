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

export async function resolveQueue(playList) {
  const tasks = (playList || []).map(async raw => {
    try {
      const songs = await search(raw, config.queue.searchLimitPerItem);
      if (!songs.length) return null;
      const base = songs[0];
      const [cdnUrl, detail, lyric] = await Promise.all([
        getUrl(base.id).catch(() => null),
        getDetail(base.id).catch(() => null),
        getLyric(base.id).catch(() => ''),
      ]);
      return {
        ...base,
        artist: detail?.artist || base.artist,
        album: detail?.album || '',
        cover: detail?.cover || base.cover || null,
        duration: detail?.duration || null,
        publishTime: detail?.publishTime || null,
        lyric: lyric || '',
        url: cdnUrl ? `/api/song/stream?id=${base.id}` : null,
        raw,
      };
    } catch {
      return null;
    }
  });

  const settled = await Promise.allSettled(tasks);
  return settled
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);
}
