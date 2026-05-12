/**
 * REST 路由。server.js 挂载这些路由并注入依赖。
 */
import { config } from './config.js';
import { search, getUrl } from './services/ncm.js';
import { composeDjCommentary } from './services/dj.js';
import { askRadioPlan } from './services/llm.js';
import { synthesize } from './services/tts.js';
import { fetchWeather } from './services/weather.js';
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
    try {
      const result = await planFromInput(message);
      const queue = await resolveQueue(result.play || []);
      playback.setQueue(queue);
      const song = playback.playNext({ broadcast: false });
      if (song) await state.addPlay(song.name, song.artist, song);

      const openingTrigger = '新一轮节目开场';
      const shouldQueueOpeningDj = playback.shouldSpeakDj({ force: true });
      const ttsUrl = (!shouldQueueOpeningDj && result.say) ? await synthesize(result.say) : null;

      const response = {
        ...result,
        requestId,
        ttsUrl,
        ...playback.snapshot(),
      };
      playback.broadcast({ type: 'chat', ...response });
      queueDjBroadcast(playback, playback.snapshot(), null, openingTrigger, { force: true });
      res.json(response);
    } catch (e) {
      console.error('[chat] ', e.message);
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

/**
 * 根据用户输入，决定走直接搜歌还是调 AI 规划。
 */
async function planFromInput(message) {
  const intent = routeIntent(message);
  if (intent === 'direct') {
    const keyword = extractDirectKeyword(message);
    const songs = await search(keyword, config.queue.directSearchLimit);
    return {
      say: `好的，为你播放 ${keyword}`,
      play: songs.map(s => `${s.name} - ${s.artist}`),
      reason: 'direct',
      segue: '',
    };
  }
  const weather = await fetchWeather();
  return await askRadioPlan(message, { weather });
}

function queueDjBroadcast(playback, snapshot, previousSong, trigger, { force = false } = {}) {
  if (!snapshot?.nowPlaying?.name) return;
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

function describePlayAction(action, index) {
  if (action === 'index') return `切到队列第 ${Number(index) + 1} 首`;
  if (action === 'prev') return '回到上一首';
  return '切到下一首';
}
