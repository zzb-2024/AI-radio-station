/**
 * 网易云音乐 - 移动端公开 API + weapi fallback。
 * 搜歌、拿播放地址（VIP 走 weapi）、拿歌词、拿专辑高清封面。
 */
import { createSign } from 'crypto';
import { config } from '../config.js';
import { requestJson } from '../lib/http.js';
import { buildWeapiBody } from './weapi.js';

const BASE = `https://${config.ncm.host}`;
const TOPLIST_OPENAPI_PATH = '/openapi/music/basic/toplist/get/v2';

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

/**
 * 获取云音乐榜单列表。优先走 IoT OpenAPI；未配置或失败时退到公开接口。
 */
export async function getToplists() {
  const openapi = await getToplistsOpenapi().catch(error => {
    if (hasNcmOpenapiConfig()) console.warn(`[ncm:toplists] openapi failed: ${error.message}`);
    return null;
  });
  if (openapi?.records?.length) {
    const publicRecords = await getToplistsPublic().catch(() => []);
    return {
      ...openapi,
      records: mergeToplistRecords(openapi.records, publicRecords),
    };
  }

  const fallback = await getToplistsPublic();
  return {
    source: 'public',
    records: fallback,
  };
}

/**
 * 获取某个榜单里的歌曲。公开榜单本质是歌单，所以用 playlist/detail 拿 tracks。
 */
export async function getToplistTracks(id, limit = config.ncm.toplistTrackLimit) {
  const playlist = await getPlaylistDetail(id);
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  return {
    id: String(playlist?.id || id || ''),
    name: String(playlist?.name || ''),
    coverImgUrl: playlist?.coverImgUrl || null,
    trackCount: Number(playlist?.trackCount || tracks.length || 0),
    updateFrequency: String(playlist?.updateFrequency || ''),
    tracks: tracks
      .map((track, index) => normalizeToplistTrack(track, index))
      .filter(track => track.id && track.name)
      .slice(0, Math.max(1, Math.min(Number(limit) || config.ncm.toplistTrackLimit, 50))),
  };
}

async function songUrlPublic(id, level) {
  const ids = encodeURIComponent(JSON.stringify([id]));
  const data = await call(
    `/api/song/enhance/player/url/v1?ids=${ids}&level=${encodeURIComponent(level)}&encodeType=mp3`,
    { method: 'POST' }
  );
  return data?.data?.[0] || null;
}

async function songUrlWeapi(id, level) {
  const csrf = config.ncm.csrf || '';
  const body = buildWeapiBody({
    ids: [id],
    level,
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
  return data?.data?.[0] || null;
}

/**
 * 拿播放地址。先走公开接口，失败则走 weapi。
 * 未登录的 VIP 歌曲会返回 null，调用方需处理。
 */
export async function getUrl(id) {
  for (const level of resolveBitrateLevels()) {
    const publicItem = await songUrlPublic(id, level).catch(() => null);
    if (isUsableUrl(publicItem, level)) return publicItem.url;

    const weapiItem = await songUrlWeapi(id, level).catch(() => null);
    if (isUsableUrl(weapiItem, level)) return weapiItem.url;
  }
  return null;
}

async function getToplistsPublic() {
  const data = await call('/api/toplist/detail');
  const list = Array.isArray(data?.list) ? data.list : [];
  return list.map(item => normalizeToplistRecord(item));
}

async function getPlaylistDetail(id) {
  const data = await call(`/api/v6/playlist/detail?id=${encodeURIComponent(id)}`);
  return data?.playlist || null;
}

async function getToplistsOpenapi() {
  if (!hasNcmOpenapiConfig()) return null;

  const query = buildNcmOpenapiQuery(TOPLIST_OPENAPI_PATH, {});
  const { json } = await requestJson({
    url: `${normalizeOpenapiBaseUrl()}${TOPLIST_OPENAPI_PATH}?${query}`,
    headers: { 'User-Agent': config.ncm.userAgent },
    timeoutMs: config.ncm.timeoutMs,
  });

  if (Number(json?.code) !== 200) {
    throw new Error(`openapi code ${json?.code || 'unknown'}: ${json?.message || ''}`);
  }

  const records = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.data?.records)
      ? json.data.records
      : [];

  return {
    source: 'openapi',
    code: json.code,
    subCode: json.subCode,
    records: records.map(item => normalizeToplistRecord(item)),
  };
}

function hasNcmOpenapiConfig() {
  return Boolean(config.ncmOpenapi.appId && config.ncmOpenapi.accessToken);
}

function buildNcmOpenapiQuery(path, bizContent) {
  const params = {
    appId: config.ncmOpenapi.appId,
    accessToken: config.ncmOpenapi.accessToken,
    bizContent: JSON.stringify(bizContent || {}),
    device: config.ncmOpenapi.device,
    signType: config.ncmOpenapi.signType,
    timestamp: Date.now().toString(),
  };
  if (config.ncmOpenapi.appSecret) params.appSecret = config.ncmOpenapi.appSecret;
  if (config.ncmOpenapi.privateKey) params.sign = signNcmOpenapiParams(path, params);
  return new URLSearchParams(params).toString();
}

function signNcmOpenapiParams(path, params) {
  const canonical = Object.keys(params)
    .filter(key => key !== 'sign')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  return createSign('RSA-SHA256')
    .update(`${path}?${canonical}`)
    .sign(formatPrivateKey(config.ncmOpenapi.privateKey), 'base64');
}

function formatPrivateKey(value) {
  const raw = String(value || '').trim().replace(/\\n/g, '\n');
  if (raw.includes('BEGIN')) return raw;
  return [
    '-----BEGIN PRIVATE KEY-----',
    raw.match(/.{1,64}/g)?.join('\n') || raw,
    '-----END PRIVATE KEY-----',
  ].join('\n');
}

function normalizeOpenapiBaseUrl() {
  return String(config.ncmOpenapi.baseUrl || 'http://openapi.music.163.com').replace(/\/+$/, '');
}

function normalizeToplistRecord(item) {
  return {
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    coverImgUrl: item?.coverImgUrl || item?.coverImageUrl || null,
    describe: item?.describe ?? item?.description ?? '',
    creatorNickName: item?.creatorNickName || item?.creator?.nickname || '',
    playCount: Number(item?.playCount || 0),
    subscribedCount: Number(item?.subscribedCount || 0),
    tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
    createTime: Number(item?.createTime || 0),
    subed: Boolean(item?.subed ?? item?.subscribed),
    trackCount: Number(item?.trackCount || 0),
    specialType: Number(item?.specialType || 0),
    category: String(item?.category || inferToplistCategory(item) || ''),
    updateFrequency: String(item?.updateFrequency || ''),
    tracks: Array.isArray(item?.tracks)
      ? item.tracks.map(track => ({
        name: String(track?.first || track?.name || ''),
        artist: String(track?.second || track?.artist || ''),
      })).filter(track => track.name)
      : [],
  };
}

function normalizeToplistTrack(track, index) {
  return {
    id: Number(track?.id || 0),
    name: String(track?.name || ''),
    artist: Array.isArray(track?.ar)
      ? track.ar.map(artist => artist.name).filter(Boolean).join('/')
      : Array.isArray(track?.artists)
        ? track.artists.map(artist => artist.name).filter(Boolean).join('/')
        : '',
    fee: Number(track?.fee || 0),
    cover: track?.al?.picUrl || track?.album?.picUrl || null,
    album: track?.al?.name || track?.album?.name || '',
    duration: Number(track?.dt || track?.duration || 0),
    publishTime: Number(track?.publishTime || 0),
    rank: index + 1,
    raw: `${track?.name || ''} - ${Array.isArray(track?.ar) ? track.ar.map(artist => artist.name).filter(Boolean).join('/') : ''}`.trim(),
  };
}

function mergeToplistRecords(openapiRecords, publicRecords) {
  if (!Array.isArray(openapiRecords) || !openapiRecords.length) return [];
  const publicByName = new Map(
    (Array.isArray(publicRecords) ? publicRecords : [])
      .map(record => [normalizeToplistName(record?.name), record])
      .filter(([name]) => Boolean(name))
  );

  return openapiRecords.map(record => {
    const publicMatch = publicByName.get(normalizeToplistName(record?.name));
    if (!publicMatch) return record;
    return {
      ...record,
      id: publicMatch.id || record.id,
      publicId: publicMatch.id || null,
      tracks: Array.isArray(record.tracks) && record.tracks.length ? record.tracks : publicMatch.tracks,
      category: record.category || publicMatch.category || '',
      updateFrequency: record.updateFrequency || publicMatch.updateFrequency || '',
      trackCount: record.trackCount || publicMatch.trackCount || 0,
    };
  });
}

function normalizeToplistName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[【】\[\]（）()]/g, '');
}

function inferToplistCategory(item) {
  const name = String(item?.name || '');
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : '';
  const text = `${name} ${tags}`;
  if (/Billboard|UK|Oricon|Beatport|全球|美国|日本|法国|俄罗斯/i.test(text)) return 'GLOBAL';
  if (/韩语|日语|欧美|俄语|泰语|越南语|语榜/i.test(text)) return 'LANGUAGE';
  if (/电音|电子|摇滚|民谣|说唱|古典|国风|ACG|DJ|曲风/i.test(text)) return 'MUSIC_STYLE';
  if (/飙升|新歌|原创|热歌/i.test(text) || item?.ToplistType) return 'OFFICIAL';
  if (/黑胶|VIP|网络|编辑|实时|KTV|听歌识曲|潜力|LOOK|赏音/i.test(text)) return 'FEATURE';
  return 'MORE';
}

function resolveBitrateLevels() {
  const levels = [
    config.ncm.bitrate,
    ...String(config.ncm.bitrateFallbacks || '').split(','),
  ]
    .map(level => normalizeLevel(level))
    .filter(Boolean);
  return [...new Set(levels)];
}

function isUsableUrl(item, requestedLevel) {
  if (!item?.url) return false;
  const actualLevel = normalizeLevel(item.level);
  if (!actualLevel) return true;
  return qualityRank(actualLevel) >= qualityRank(requestedLevel);
}

function normalizeLevel(level) {
  return String(level || '').trim().toLowerCase();
}

function qualityRank(level) {
  return {
    none: 0,
    standard: 1,
    higher: 2,
    exhigh: 3,
    lossless: 4,
    hires: 5,
    jyeffect: 6,
    sky: 7,
    dolby: 8,
    jymaster: 9,
  }[normalizeLevel(level)] || 0;
}
