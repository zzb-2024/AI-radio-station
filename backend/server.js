/**
 * GPT Neural Radio · AI 电台 服务端入口
 */
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { config, assertConfig } from './config.js';
import { Playback } from './core/playback.js';
import { state } from './core/state.js';
import { startScheduler } from './core/scheduler.js';
import { registerRoutes } from './routes.js';
import { learnProfileFromPlay } from './core/profile.js';

assertConfig();

const app = express();
app.use(express.json());
app.use(express.static(config.paths.frontend, {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));
app.use('/tts', express.static(config.paths.ttsCache));

const playback = new Playback();
registerRoutes(app, playback);

const httpServer = createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: '/stream' });
wss.on('connection', ws => playback.addClient(ws));

startScheduler(
  data => playback.broadcast(data),
  async payload => {
    if (!payload.queue) return;
    playback.setQueue(payload.queue);
    const song = playback.playNext({ broadcast: false });
    if (song) {
      await state.addPlay(song.name, song.artist, song);
      await learnProfileFromPlay(song, {
        source: 'scheduler',
        requestText: payload.label || payload.say || payload.reason || '',
        reason: payload.reason || '',
        toplist: payload.toplist || null,
        weather: payload.weather || '',
        time: new Date().toISOString(),
      }).catch(error => console.warn(`[profile] ${error.message}`));
    }
    Object.assign(payload, playback.snapshot());
  }
);

httpServer.listen(config.server.port, () => {
  console.log(`GPT Neural Radio running at http://localhost:${config.server.port}`);
});
