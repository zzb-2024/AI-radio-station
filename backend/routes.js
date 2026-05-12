/**
 * REST 路由。server.js 挂载这些路由并注入依赖。
 */
import { config } from './config.js';
import { search, getToplistTracks, getToplists, getUrl } from './services/ncm.js';
import { composeDjCommentary } from './services/dj.js';
import { askRadioChat, askRadioPlan } from './services/llm.js';
import { synthesize } from './services/tts.js';
import { fetchWeather } from './services/weather.js';
import { searchWeb } from './services/web-search.js';
import { state } from './core/state.js';
import { route as routeIntent, extractDirectKeyword } from './core/intent.js';
import { resolveQueue } from './core/queue.js';
import { buildProfileSuggestion, getProfile, saveProfile } from './core/profile.js';
import { proxyStream } from './lib/http.js';

/**
 * @param {import('express').Express} app
 * @param {import('./core/playback.js').Playback} playback
 */
export function registerRoutes(app, playback) {
  app.post('/api/chat', async (req, res) => {
    const message = req.body?.message || '';
    const requestId = req.body?.requestId || null;
    const mode = normalizeChatMode(req.body?.mode);
    try {
      const result = await planFromInput(message, playback, mode);
      if (result.reason === 'chat') {
        return await sendChatOnlyResponse({ res, playback, requestId, result });
      }

      const queue = await resolveQueue(result.play || []);
      playback.setQueue(queue);
      const song = playback.playNext({ broadcast: false });
      if (song) await state.addPlay(song.name, song.artist, song);

      const ttsUrl = result.say ? await synthesize(result.say) : null;

      const response = {
        ...result,
        requestId,
        ttsUrl,
        ...playback.snapshot(),
      };
      playback.broadcast({ type: 'chat', ...response });
      res.json(response);
    } catch (e) {
      console.error('[chat] ', e.message);
      if (mode === 'chat' || (mode !== 'song' && routeIntent(message) === 'chat')) {
        return await sendChatOnlyResponse({
          res,
          playback,
          requestId,
          result: fallbackChatResult(e),
        });
      }
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/now', (_req, res) => {
    res.json(playback.snapshot());
  });

  app.get('/api/next', async (_req, res) => {
    const previousSong = playback.nowPlaying;
    const song = playback.playNext({ broadcast: false });
    if (song) {
      await state.addPlay(song.name, song.artist, song);
      const snapshot = playback.snapshot();
      playback.broadcast({ type: 'now-playing', ...snapshot });
      queueDjBroadcast(playback, snapshot, previousSong, '自动切到下一首');
      return res.json(snapshot);
    }
    res.json(playback.snapshot());
  });

  app.post('/api/play', async (req, res) => {
    const action = req.body?.action;
    const index = req.body?.index;

    const previousSong = playback.nowPlaying;
    let song = null;
    if (action === 'index') {
      song = playback.playIndex(index, { broadcast: false });
    } else if (action === 'next') {
      song = playback.playNext({ broadcast: false });
    } else if (action === 'prev') {
      song = playback.playPrev({ broadcast: false, countDjProgress: false });
    } else {
      return res.status(400).json({ error: 'invalid action' });
    }

    if (song) {
      await state.addPlay(song.name, song.artist, song);
      const snapshot = playback.snapshot();
      playback.broadcast({ type: 'now-playing', ...snapshot });
      if (action !== 'prev') {
        queueDjBroadcast(playback, snapshot, previousSong, describePlayAction(action, index));
      }
      return res.json(snapshot);
    }
    res.json(playback.snapshot());
  });

  app.get('/api/search', async (req, res) => {
    try {
      const q = req.query.q || '';
      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 10));
      res.json({ songs: await search(q, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/toplists', async (req, res) => {
    try {
      const category = String(req.query.category || '').trim().toUpperCase();
      const q = String(req.query.q || '').trim().toLowerCase();
      const result = await getToplists();
      const records = result.records.filter(item => {
        if (category && item.category !== category) return false;
        if (q && !`${item.name} ${item.describe} ${item.tags.join(' ')}`.toLowerCase().includes(q)) return false;
        return true;
      });
      res.json({
        source: result.source,
        code: result.code || 200,
        subCode: result.subCode || '200',
        count: records.length,
        records,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/toplists/:id/tracks', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || config.ncm.toplistTrackLimit));
      res.json(await getToplistTracks(req.params.id, limit));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/dj/preview', async (_req, res) => {
    try {
      const currentSong = playback.nowPlaying;
      const nextSong = getNextPlayableSong(playback);
      if (!currentSong?.id || !nextSong?.id) {
        return res.json({ preview: false, say: '', ttsUrl: null });
      }

      const say = await composeDjCommentary({
        currentSong,
        upcomingSong: nextSong,
        trigger: '上一首尾段预告',
      });
      if (!say) {
        return res.json({ preview: false, say: '', ttsUrl: null });
      }

      res.json({
        preview: true,
        currentSongId: currentSong.id,
        nextSongId: nextSong.id,
        say,
        ttsUrl: await synthesize(say),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/dj/preview/mark', (req, res) => {
    const nextSong = getNextPlayableSong(playback);
    const nextSongId = Number(req.body?.nextSongId || 0);
    if (nextSong?.id && Number(nextSong.id) === nextSongId) {
      playback.markDjPreview(nextSong.id);
    }
    res.json({ ok: true });
  });

  app.get('/api/song/url', async (req, res) => {
    try { res.json({ url: await getUrl(req.query.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  /**
   * 音频代理：把网易云 CDN 的 mp3 透传给浏览器。
   * 作用：网易云 CDN 不返回 CORS 头，<audio> 直连时 Web Audio API 因跨域限制输出静音，
   *       同源代理后 AnalyserNode 就能拿到真实频谱。支持 Range，所以进度条 seek 正常。
   */
  app.get('/api/song/stream', async (req, res) => {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'missing id' });
      const url = await getUrl(id);
      if (!url) return res.status(404).json({ error: 'no url (VIP not unlocked?)' });
      await proxyStream({ url, req, res });
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: e.message });
    }
  });

  app.get('/api/taste', async (_req, res) => {
    const recent = await state.recentPlays(50);
    const prefs = await state.getPref('taste', {});
    res.json({ recent, prefs });
  });

  app.get('/api/plan/today', async (_req, res) => {
    res.json({ plan: await state.getTodayPlan() });
  });

  app.post('/api/plan/today', async (req, res) => {
    await state.setTodayPlan(req.body?.content || '');
    res.json({ ok: true });
  });

  app.get('/api/profile', async (_req, res) => {
    res.json({ profile: await getProfile() });
  });

  app.post('/api/profile', async (req, res) => {
    try {
      res.json({ profile: await saveProfile(req.body?.profile || req.body || {}) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/profile/suggestion', async (_req, res) => {
    const profile = await getProfile();
    const recent = await state.recentPlays(80);
    res.json({ suggestion: buildProfileSuggestion(profile, recent) });
  });
}

async function sendChatOnlyResponse({ res, playback, requestId, result }) {
  const response = {
    ...result,
    requestId,
    ttsUrl: result.say ? await synthesize(result.say) : null,
    ...playback.snapshot(),
    chatOnly: true,
  };
  playback.broadcast({ type: 'chat', ...response });
  return res.json(response);
}

/**
 * 根据用户输入，决定走直接搜歌还是调 AI 规划。
 */
async function planFromInput(message, playback, mode = 'auto') {
  if (mode === 'chat') {
    return await planFromChatInput(message, playback);
  }

  if (mode === 'song') {
    return await planFromSongInput(message);
  }

  const intent = routeIntent(message);
  if (isToplistRequest(message)) {
    const toplistPlan = await planFromToplistInput(message);
    if (toplistPlan) return toplistPlan;
  }

  if (intent === 'direct') {
    const keyword = extractDirectKeyword(message);
    const songs = await search(keyword, config.queue.directSearchLimit);
    return {
      say: `好的，为你播放 ${keyword}`,
      play: songs,
      reason: 'direct',
      segue: '',
    };
  }

  if (intent === 'chat') {
    return await planFromChatInput(message, playback);
  }

  const weather = await fetchWeather();
  const currentSong = playback?.nowPlaying || null;
  const webSearch = await maybeSearchWeb({ message, currentSong, mode: 'auto' });
  const env = { weather, currentSong, webSearch };
  return await askRadioPlan(message, env);
}

async function planFromSongInput(message) {
  if (isToplistRequest(message)) {
    const toplistPlan = await planFromToplistInput(message);
    if (toplistPlan) return toplistPlan;
  }

  const keyword = extractSongSearchKeyword(message);
  const songs = await search(keyword, config.queue.directSearchLimit);
  if (songs.length) {
    return {
      say: `好的，为你播放 ${keyword}`,
      play: songs,
      reason: 'direct',
      segue: '',
    };
  }

  return {
    say: `没搜到 ${keyword}，你可以换个歌名、歌手或者直接说“电音榜”。`,
    play: [],
    reason: 'chat',
    segue: '',
  };
}

async function planFromChatInput(message, playback) {
  const weather = await fetchWeather();
  const currentSong = playback?.nowPlaying || null;
  const webSearch = await maybeSearchWeb({ message, currentSong, mode: 'chat' });
  const env = { weather, currentSong, webSearch };
  return await askRadioChat(message, env, { allowPlanFallback: false });
}

async function planFromToplistInput(message) {
  const toplists = await getToplists();
  const selected = selectToplistRecord(message, toplists.records || []);
  if (!selected?.id) return null;

  const detail = await getToplistTracks(selected.id, config.ncm.toplistTrackLimit).catch(() => null);
  const tracks = Array.isArray(detail?.tracks) && detail.tracks.length
    ? detail.tracks
    : Array.isArray(selected.tracks) && selected.tracks.length
      ? selected.tracks.map(track => `${track.name} - ${track.artist}`).filter(Boolean)
      : [];
  if (!tracks.length) return null;

  return {
    say: `从${selected.name}里挑几首，直接让榜单带路。`,
    play: tracks,
    reason: 'toplist',
    segue: `${selected.name}${selected.updateFrequency ? `，${selected.updateFrequency}` : ''}。`,
    toplist: {
      id: selected.id,
      name: selected.name,
      category: selected.category,
      source: toplists.source || 'public',
    },
  };
}

function normalizeChatMode(mode) {
  if (mode === 'song') return 'song';
  if (mode === 'chat') return 'chat';
  return 'auto';
}

function extractSongSearchKeyword(message) {
  const text = String(message || '').trim();
  if (!text) return '';

  return text
    .replace(/^(播放|来一首|放一首|来点|来些|来首|放点|放些|推荐点|推荐一些|给我来点|给我来些|帮我找点|帮我播放|换几首歌|换几首|换几首的|换几首些|换几首首|换几首曲|换点|换些|点歌|搜歌|搜索|听点|想听点|想听|想听些|想听一些)\s*/i, '')
    .replace(/(吧|呗|一下|一些|一点|点)$/i, '')
    .trim() || text;
}

function isToplistRequest(text) {
  return /(榜单|榜上|上榜|榜里|榜中的|榜上歌|热歌榜|新歌榜|飙升榜|电音榜|国风榜|古风榜|说唱榜|民谣榜|摇滚榜|欧美热歌榜|实时热度榜|黑胶VIP|KTV唛榜|Beatport|Oricon|Billboard|UK排行榜)/i.test(String(text || ''));
}

function selectToplistRecord(message, records) {
  const text = String(message || '').trim().toLowerCase();
  if (!records.length) return null;

  const scored = records
    .map((record, index) => ({ record, score: scoreToplistRecord(record, text, index) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) return pickDefaultToplist(records);
  return best.record;
}

function scoreToplistRecord(record, text, index) {
  const name = String(record?.name || '').toLowerCase();
  const describe = String(record?.describe || '').toLowerCase();
  const tags = Array.isArray(record?.tags) ? record.tags.join(' ').toLowerCase() : '';
  const blob = `${name} ${describe} ${tags}`;
  let score = 0;

  if (!text) return score;
  if (text.includes(name) || name.includes(text)) score += 100;

  const keywordMap = [
    [/电音|电子|edm|house|techno|舞曲/, ['电音', '电子', 'edm', 'house', 'techno', '舞曲']],
    [/热歌|热曲|热门|热度|实时/, ['热歌', '热曲', '热门', '热度', '实时']],
    [/新歌|新鲜/, ['新歌', '新鲜']],
    [/飙升|上升|冲榜/, ['飙升', '上升', '冲榜']],
    [/国风|古风|中文/, ['国风', '古风', '中文']],
    [/说唱|rap|hip hop/, ['说唱', 'rap', 'hip hop']],
    [/民谣/, ['民谣']],
    [/摇滚/, ['摇滚']],
    [/欧美|billboard|uk|oricon|beatport/, ['欧美', 'billboard', 'uk', 'oricon', 'beatport']],
    [/韩语|日语|俄语|泰语|越南语/, ['韩语', '日语', '俄语', '泰语', '越南语']],
  ];

  for (const [regex, keywords] of keywordMap) {
    if (regex.test(text) && keywords.some(keyword => blob.includes(keyword))) score += 25;
  }

  if (/电音榜/.test(text) && name.includes('电音榜')) score += 60;
  if (/热歌榜/.test(text) && name.includes('热歌榜')) score += 60;
  if (/新歌榜/.test(text) && name.includes('新歌榜')) score += 60;
  if (/飙升榜/.test(text) && name.includes('飙升榜')) score += 60;
  if (/榜/.test(text) && /榜/.test(name)) score += 15;
  if (text.includes('榜单') && /榜/.test(name)) score += 10;
  if (index === 0) score += 1;
  return score;
}

function pickDefaultToplist(records) {
  const preferredNames = ['热歌榜', '飙升榜', '新歌榜'];
  for (const name of preferredNames) {
    const found = records.find(record => String(record?.name || '').includes(name));
    if (found) return found;
  }
  return records[0] || null;
}

function fallbackChatResult(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const providerUnavailable = /503|没有可用提供商|timeout|request/i.test(message);
  return {
    say: providerUnavailable
      ? '我在，刚才信号有点卡。你可以继续跟我说，我会先保持当前播放，不会突然换歌。'
      : '我在听。你继续说，我先不动现在的歌。',
    play: [],
    reason: 'chat',
    segue: '',
  };
}

async function maybeSearchWeb({ message, currentSong, mode = 'auto' }) {
  const search = buildWebSearchRequest({ message, currentSong, mode });
  if (!search) return null;

  try {
    return await searchWeb(search.query, {
      count: search.count,
      recency: search.recency,
      contentSize: search.contentSize,
    });
  } catch (error) {
    console.warn(`[web-search] ${error.message}`);
    return null;
  }
}

function buildWebSearchRequest({ message, currentSong, mode }) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (mode === 'chat' && isSongBackgroundQuestion(text)) {
    const base = currentSong?.name
      ? `${currentSong.name} ${currentSong.artist || ''}`
      : text;
    return {
      query: `${base} 创作背景 采访 歌曲`,
      count: 5,
      recency: 'noLimit',
      contentSize: 'high',
    };
  }

  if (mode === 'chat' && isRealtimeMusicRequest(text)) {
    return {
      query: `${text} 音乐 歌曲 榜单`,
      count: 6,
      recency: 'oneYear',
      contentSize: 'medium',
    };
  }

  if (mode !== 'chat' && currentSong?.name && isSongBackgroundQuestion(text)) {
    return {
      query: `${currentSong.name} ${currentSong.artist || ''} 创作背景 采访 歌曲`,
      count: 5,
      recency: 'noLimit',
      contentSize: 'high',
    };
  }

  if (mode !== 'chat' && isRealtimeMusicRequest(text)) {
    return {
      query: `${text} 音乐 歌曲 榜单`,
      count: 6,
      recency: 'oneYear',
      contentSize: 'medium',
    };
  }

  return null;
}

function isRealtimeMusicRequest(text) {
  return /(最新|最近|今天|现在|今年|2026|26年|榜单|排行|排名|热门|热歌|热曲|新歌|实时|热度|年度|新闻|动态|top|hit|电音|电子|edm|house|techno|舞曲)/i.test(text);
}

function isSongBackgroundQuestion(text) {
  return /(这首歌|这首|歌曲|背景|故事|创作|写的|写作|灵感|状态|采访|专辑|歌词|含义|表达|作者|作词|作曲|制作人|什么时候|为什么|介绍|讲讲|说说)/i.test(text);
}

function queueDjBroadcast(playback, snapshot, previousSong, trigger, { force = false } = {}) {
  if (!snapshot?.nowPlaying?.name) return;
  const isTransitionPreview = /尾段|预告|过渡|切换|结尾/.test(String(trigger || ''));
  if (!previousSong && !isTransitionPreview) return;
  if (playback.consumeDjPreview(snapshot.nowPlaying.id)) return;
  if (!playback.shouldSpeakDj({ force })) return;

  playback.markDjSpoken();

  void (async () => {
    const say = await composeDjCommentary({
      currentSong: snapshot.nowPlaying,
      previousSong,
      trigger,
    });
    const latest = playback.snapshot();
    if (!say) return;
    if (latest.currentIndex !== snapshot.currentIndex) return;
    if (latest.nowPlaying?.id !== snapshot.nowPlaying?.id) return;

    playback.broadcast({
      type: 'dj',
      nowPlayingId: snapshot.nowPlaying.id,
      say,
      ttsUrl: await synthesize(say),
    });
  })();
}

function getNextPlayableSong(playback) {
  const start = playback.currentIndex < 0 ? 0 : playback.currentIndex + 1;
  return playback.queue.slice(start).find(song => song?.url) || null;
}

function describePlayAction(action, index) {
  if (action === 'index') return `切到队列第 ${Number(index) + 1} 首`;
  if (action === 'prev') return '回到上一首';
  return '切到下一首';
}
