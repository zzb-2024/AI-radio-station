/**
 * 网易云音乐 - 移动端公开 API + weapi fallback。
 * 搜歌、拿播放地址（VIP 走 weapi）、拿歌词、拿专辑高清封面。
 */
import { config } from '../config.js';
import { requestJson } from '../lib/http.js';
import { buildWeapiBody } from './weapi.js';

const BASE = `https://${config.ncm.host}`;

function buildCookie() {
  const parts = ['os=pc', 'appver=8.10.05'];
  if (config.ncm.musicU) parts.unshift(`MUSIC_U=${config.ncm.musicU}`);
  if (config.ncm.csrf) parts.unshift(`__csrf=${config.ncm.csrf}`);
  return parts.join('; ');
}

function commonHeaders() {
  return {
    'User-Agent': config.ncm.userAgent,
    'Referer': `${BASE}/`,
    'Cookie': buildCookie(),
  };
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const { json } = await requestJson({
    url: `${BASE}${path}`,
    method,
    headers: { ...commonHeaders(), ...headers },
    body,
    timeoutMs: config.ncm.timeoutMs,
  });
  return json;
}

/**
 * 关键词搜歌。返回 [{ id, name, artist, fee, cover }]
 */
export async function search(keyword, limit = 5) {
  const data = await call(
    `/api/search/get?type=1&s=${encodeURIComponent(keyword)}&limit=${limit}`
  );
  return (data?.result?.songs || []).map(s => ({
    id: s.id,
    name: s.name,
    artist: (s.artists || []).map(a => a.name).join('/'),
    fee: s.fee,
    cover: s.album?.picUrl || null,
  }));
}

/**
 * 拿高清专辑封面 + 准确艺人信息。搜索接口的 picUrl 经常缺失。
 */
export async function getDetail(id) {
  const q = encodeURIComponent(JSON.stringify([{ id }]));
  const data = await call(`/api/v3/song/detail?c=${q}`);
  const s = data?.songs?.[0];
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    artist: (s.ar || []).map(a => a.name).join('/'),
    album: s.al?.name || '',
    cover: s.al?.picUrl || null,
    duration: s.dt,
    publishTime: s.publishTime || null,
  };
}

/**
 * 拿歌词（LRC 格式）。
 */
export async function getLyric(id) {
  const data = await call(`/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);
  return data?.lrc?.lyric || '';
}

async function songUrlPublic(id) {
  const ids = encodeURIComponent(JSON.stringify([id]));
  const data = await call(
    `/api/song/enhance/player/url/v1?ids=${ids}&level=${config.ncm.bitrate}&encodeType=mp3`,
    { method: 'POST' }
  );
  return data?.data?.[0]?.url || null;
}

async function songUrlWeapi(id) {
  const csrf = config.ncm.csrf || '';
  const body = buildWeapiBody({
    ids: [id],
    level: config.ncm.bitrate,
    encodeType: 'mp3',
    csrf_token: csrf,
  });
  const data = await call(
    `/weapi/song/enhance/player/url/v1?csrf_token=${csrf}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );
  return data?.data?.[0]?.url || null;
}

/**
 * 拿播放地址。先走公开接口，失败则走 weapi。
 * 未登录的 VIP 歌曲会返回 null，调用方需处理。
 */
export async function getUrl(id) {
  const url = await songUrlPublic(id).catch(() => null);
  if (url) return url;
  return await songUrlWeapi(id).catch(() => null);
}
