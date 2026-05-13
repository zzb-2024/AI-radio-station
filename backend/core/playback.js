/**
 * 播放状态（内存态）+ 广播中心。server 和 routes 共用。
 */
import { config } from '../config.js';

export class Playback {
  constructor() {
    this.nowPlaying = null;
    this.queue = [];
    this.currentIndex = -1;
    this.currentStartedAt = 0;
    this._clients = new Set();
    this._resetDjState();
  }

  snapshot() {
    return {
      nowPlaying: this.nowPlaying,
      queue: this.queue,
      currentIndex: this.currentIndex,
      currentStartedAt: this.currentStartedAt,
    };
  }

  addClient(ws) {
    this._clients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', ...this.snapshot() }));
    ws.on('close', () => this._clients.delete(ws));
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of this._clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  setQueue(queue) {
    this.queue = Array.isArray(queue) ? queue : [];
    this.currentIndex = -1;
    this.nowPlaying = null;
    this.currentStartedAt = 0;
    this._resetDjState();
    this.clearDjPreview();
  }

  playIndex(index, { broadcast = true, countDjProgress = true } = {}) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.queue.length) return null;

    const prevSongId = this.nowPlaying?.id || null;
    const song = this.queue[i];
    if (!song?.url) return null;

    this.currentIndex = i;
    this.nowPlaying = song;
    this.currentStartedAt = Date.now();
    this._noteSongChange(song, prevSongId, countDjProgress);
    if (broadcast) this.broadcast({ type: 'now-playing', ...this.snapshot() });
    return song;
  }

  playNext(opts) {
    const start = this.currentIndex < 0 ? 0 : this.currentIndex + 1;
    return this._playFrom(start, 1, opts);
  }

  playPrev(opts) {
    return this._playFrom(this.currentIndex - 1, -1, opts);
  }

  _playFrom(start, step, opts) {
    for (let i = start; i >= 0 && i < this.queue.length; i += step) {
      if (this.queue[i]?.url) return this.playIndex(i, opts);
    }
    return null;
  }

  shouldSpeakDj({ force = false } = {}) {
    if (!config.dj.enabled || !this.nowPlaying?.id) return false;
    if (force) return true;
    return true;
  }

  markDjSpoken() {
    if (!this.nowPlaying?.id) return;
    this._dj.hasOpenedQueue = true;
    this._dj.lastSongId = this.nowPlaying.id;
    this._dj.songsSinceLastSpeak = 0;
    this._dj.nextGap = this._pickDjGap();
  }

  markDjPreview(songId) {
    if (!songId) return;
    this._dj.previewSongId = songId;
  }

  consumeDjPreview(songId) {
    if (!songId) return false;
    if (this._dj.previewSongId === songId) {
      this._dj.previewSongId = null;
      return true;
    }
    if (this._dj.previewSongId && this._dj.previewSongId !== songId) {
      this._dj.previewSongId = null;
    }
    return false;
  }

  clearDjPreview() {
    this._dj.previewSongId = null;
  }

  _noteSongChange(song, prevSongId, countDjProgress) {
    if (!song?.id || song.id === prevSongId) return;
    this._dj.lastSongId = song.id;
    if (this._dj.hasOpenedQueue && countDjProgress) {
      this._dj.songsSinceLastSpeak += 1;
    }
  }

  _resetDjState() {
    this._dj = {
      hasOpenedQueue: false,
      songsSinceLastSpeak: 0,
      nextGap: this._pickDjGap(),
      lastSongId: null,
      previewSongId: null,
    };
  }

  _pickDjGap() {
    const min = Math.max(1, config.dj.gapMin);
    const max = Math.max(min, config.dj.gapMax);
    return min + Math.floor(Math.random() * (max - min + 1));
  }
}
