/**
 * 音频播放器。封装 <audio>、TTS 播报、进度条、播放控制。
 * 提供 play/pause/next/prev + on('song-change') 事件。
 */
import { CONFIG } from './config.js';
import { api } from './api.js';

export class Player {
  /**
   * @param {HTMLAudioElement} audioEl
   * @param {{
   *   btnPlay: HTMLElement, btnPrev: HTMLElement, btnNext: HTMLElement,
   *   progress: HTMLElement, progressBar: HTMLElement,
   *   nameEl: HTMLElement, artistEl: HTMLElement, coverEl: HTMLElement,
   * }} ui
   */
  constructor(audioEl, ui) {
    this.audio = audioEl;
    this.ui = ui;
    this.queue = [];
    this.idx = -1;
    this.currentSong = null;
    this.tts = null;           // 独立的 TTS <audio>，不走主播放器
    this._listeners = {};
    this._preDuckVolume = null;
    this._volumeTweens = { main: null, tts: null };
    this._ttsRestoreTimer = null;
    this._ttsAudioContext = null;
    this._ttsBoost = null;

    // UI events
    audioEl.addEventListener('play',  () => ui.btnPlay.textContent = '⏸');
    audioEl.addEventListener('pause', () => ui.btnPlay.textContent = '▶');
    audioEl.addEventListener('ended', () => this.requestNext());
    audioEl.addEventListener('timeupdate', () => {
      if (audioEl.duration) {
        ui.progressBar.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
      }
    });

    ui.btnPlay.addEventListener('click', () => this.toggle());
    ui.btnPrev.addEventListener('click', () => this.requestPrev());
    ui.btnNext.addEventListener('click', () => this.requestNext());
    ui.progress.addEventListener('click', e => {
      if (!audioEl.duration) return;
      const r = e.currentTarget.getBoundingClientRect();
      audioEl.currentTime = (e.clientX - r.left) / r.width * audioEl.duration;
    });
  }

  on(event, fn) { (this._listeners[event] ||= []).push(fn); }
  _emit(event, arg) { (this._listeners[event] || []).forEach(fn => fn(arg)); }

  syncState(state, { autoplay = false } = {}) {
    const hasQueue = Array.isArray(state?.queue);
    const nextQueue = hasQueue ? state.queue : this.queue;
    const nextIndex = Number.isInteger(state?.currentIndex) ? state.currentIndex : this.idx;
    const nextSong = state?.nowPlaying || (nextIndex >= 0 ? nextQueue[nextIndex] || null : null);
    const prevSongId = this.currentSong?.id || null;
    const nextSongId = nextSong?.id || null;
    const selectionChanged = nextIndex !== this.idx || nextSongId !== prevSongId;

    if (hasQueue) {
      this.queue = nextQueue;
      this._emit('queue-change', this.queue);
    }

    this.idx = nextIndex;
    this.currentSong = nextSong;

    if (!nextSong?.url) {
      if (selectionChanged) {
        this._stopTTS();
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
        this.ui.progressBar.style.width = '0%';
        this._updateNowUI(null);
        this._emit('song-change', null);
      }
      return;
    }

    const currentSrc = this.audio.getAttribute('src') || '';
    const sameSrc = currentSrc === nextSong.url;

    if (selectionChanged) {
      this._stopTTS();
      if (!sameSrc) this.audio.src = nextSong.url;
      this._updateNowUI(nextSong);
      this._emit('song-change', nextSong);
    }

    if (autoplay && (!sameSrc || this.audio.paused)) {
      if (!sameSrc) this.audio.src = nextSong.url;
      this.audio.play().catch(() => {});
    }
  }

  toggle() {
    if (this.audio.paused) {
      if (!this.audio.src && this.currentSong?.url) {
        this.audio.src = this.currentSong.url;
      }
      if (!this.audio.src && this.queue.length) {
        this.requestNext();
        return;
      }
      this.audio.play().catch(() => {});
    } else {
      this.audio.pause();
    }
  }

  async requestPlayIdx(i) {
    const state = await api.play('index', i).catch(() => null);
    if (state) this.syncState(state, { autoplay: true });
  }

  async requestNext() {
    const state = await api.next().catch(() => null);
    if (state) this.syncState(state, { autoplay: true });
  }

  async requestPrev() {
    const state = await api.prev().catch(() => null);
    if (state?.nowPlaying?.url) {
      this.syncState(state, { autoplay: true });
      return;
    }
    this.audio.currentTime = 0;
  }

  playTTS(url) {
    void this._playTTS(url);
  }

  async _playTTS(url) {
    if (!url) return;
    this._clearTtsRestoreTimer();
    this._stopTTS({ restoreMain: false });
    this._duckMainAudio();

    const tts = new Audio(url);
    tts.preload = 'auto';
    tts.volume = 0;
    this.tts = tts;
    const boost = await this._attachTtsBoost(tts);
    if (boost) tts.volume = 1;

    const finish = () => {
      if (this.tts !== tts) return;
      this.tts = null;
      this._detachTtsBoost();
      this._ttsRestoreTimer = setTimeout(() => this._restoreMainAudio(), CONFIG.audio.ttsRestoreDelayMs);
    };

    tts.addEventListener('ended', finish, { once: true });
    tts.addEventListener('error', finish, { once: true });

    try {
      await tts.play();
      if (boost) {
        this._fadeValue({
          slot: 'tts',
          read: () => boost.gain.gain.value,
          write: v => { boost.gain.gain.value = v; },
          target: CONFIG.audio.ttsBoostGain,
          durationMs: CONFIG.audio.ttsFadeMs,
          min: 0,
          max: 2,
        });
      } else {
        this._fadeValue({
          slot: 'tts',
          read: () => tts.volume,
          write: v => { tts.volume = v; },
          target: 1,
          durationMs: CONFIG.audio.ttsFadeMs,
          min: 0,
          max: 1,
        });
      }
    } catch {
      finish();
    }
  }

  _updateNowUI(s) {
    this.ui.nameEl.textContent   = s?.name   || '—';
    this.ui.artistEl.textContent = s?.artist || '';
    this.ui.coverEl.innerHTML    = s?.cover ? `<img src="${s.cover}" alt="">` : '♪';
  }

  _duckMainAudio() {
    if (!this.audio.src || this.audio.paused) return;
    if (this._preDuckVolume == null) {
      const activeFadeTarget = this._volumeTweens.main?.target;
      this._preDuckVolume = activeFadeTarget > this.audio.volume
        ? activeFadeTarget
        : this.audio.volume;
    }
    this._fadeValue({
      slot: 'main',
      read: () => this.audio.volume,
      write: v => { this.audio.volume = v; },
      target: Math.min(this._preDuckVolume, CONFIG.audio.ttsDuckVolume),
      durationMs: CONFIG.audio.musicFadeMs,
      min: 0,
      max: 1,
    });
  }

  _restoreMainAudio() {
    if (this._preDuckVolume == null) return;
    const target = this._preDuckVolume;
    this._preDuckVolume = null;
    this._fadeValue({
      slot: 'main',
      read: () => this.audio.volume,
      write: v => { this.audio.volume = v; },
      target,
      durationMs: CONFIG.audio.musicFadeMs,
      min: 0,
      max: 1,
    });
  }

  _stopTTS({ restoreMain = true } = {}) {
    this._clearTtsRestoreTimer();
    if (!this.tts) {
      if (restoreMain) this._restoreMainAudio();
      return;
    }
    const active = this.tts;
    this.tts = null;
    this._detachTtsBoost();
    this._cancelFade('tts');
    active.pause();
    active.removeAttribute('src');
    if (restoreMain) this._restoreMainAudio();
  }

  async _attachTtsBoost(tts) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;

    try {
      if (!this._ttsAudioContext) {
        this._ttsAudioContext = new Ctor();
      }
      if (this._ttsAudioContext.state !== 'running') {
        await this._ttsAudioContext.resume();
      }
      if (this._ttsAudioContext.state !== 'running') return null;

      const source = this._ttsAudioContext.createMediaElementSource(tts);
      const gain = this._ttsAudioContext.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this._ttsAudioContext.destination);
      this._ttsBoost = { source, gain };
      return this._ttsBoost;
    } catch (error) {
      console.warn('[tts]', error.message);
      this._ttsBoost = null;
      return null;
    }
  }

  _detachTtsBoost() {
    if (!this._ttsBoost) return;
    try { this._ttsBoost.source.disconnect(); } catch {}
    try { this._ttsBoost.gain.disconnect(); } catch {}
    this._ttsBoost = null;
  }

  _clearTtsRestoreTimer() {
    if (!this._ttsRestoreTimer) return;
    clearTimeout(this._ttsRestoreTimer);
    this._ttsRestoreTimer = null;
  }

  _cancelFade(slot) {
    const tween = this._volumeTweens[slot];
    if (!tween) return;
    cancelAnimationFrame(tween.frameId);
    this._volumeTweens[slot] = null;
  }

  _fadeValue({ slot, read, write, target, durationMs, min = 0, max = 1 }) {
    this._cancelFade(slot);
    const from = Number(read());
    if (!Number.isFinite(from)) {
      write(clamp(target, min, max));
      return;
    }

    const duration = Math.max(0, durationMs || 0);
    if (!duration || Math.abs(target - from) < 0.001) {
      write(clamp(target, min, max));
      return;
    }

    const start = performance.now();
    const tween = { frameId: 0, target };
    this._volumeTweens[slot] = tween;

    const tick = now => {
      if (this._volumeTweens[slot] !== tween) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = easeInOutCubic(progress);
      const value = clamp(from + (target - from) * eased, min, max);
      write(value);
      if (progress < 1) tween.frameId = requestAnimationFrame(tick);
      else this._volumeTweens[slot] = null;
    };

    tween.frameId = requestAnimationFrame(tick);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
