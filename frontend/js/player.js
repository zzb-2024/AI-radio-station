/**
 * 音频播放器。封装 <audio>、TTS 播报、进度条、播放控制。
 * 提供 play/pause/next/prev + on('song-change') 事件。
 */
import { CONFIG } from './config.js';
import { api } from './api.js';

const DEFAULT_AUDIO_SETTINGS = {
  musicVolume: 1,
  ttsBoostGain: CONFIG.audio.ttsBoostGain,
  ttsDuckVolume: CONFIG.audio.ttsDuckVolume,
  musicFadeMs: CONFIG.audio.musicFadeMs,
  ttsFadeMs: CONFIG.audio.ttsFadeMs,
  ttsRestoreDelayMs: CONFIG.audio.ttsRestoreDelayMs,
};

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
    this._djPreview = null;
    this._djPreviewKey = '';
    this._djPreviewInFlight = null;
    this._djPreviewPlayedKey = '';
    this._djPreviewRetryAt = 0;
    this._audioContextUnlockBound = false;
    this._lifecycleBound = false;
    this._pendingAutoplay = false;
    this.audioSettings = normalizeAudioSettings(DEFAULT_AUDIO_SETTINGS);

    // UI events
    audioEl.addEventListener('play',  () => {
      this._pendingAutoplay = false;
      ui.btnPlay.textContent = '⏸';
    });
    audioEl.addEventListener('pause', () => ui.btnPlay.textContent = '▶');
    audioEl.addEventListener('ended', () => this._handleMainEnded());
    audioEl.addEventListener('timeupdate', () => {
      if (audioEl.duration) {
        ui.progressBar.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
      }
      this._maybePlayDjPreview();
    });

    ui.btnPlay.addEventListener('click', () => this.toggle());
    ui.btnPrev.addEventListener('click', () => this.requestPrev());
    ui.btnNext.addEventListener('click', () => this.requestNext());
    ui.progress.addEventListener('click', e => {
      if (!audioEl.duration) return;
      const r = e.currentTarget.getBoundingClientRect();
      audioEl.currentTime = (e.clientX - r.left) / r.width * audioEl.duration;
    });

    this.setAudioSettings(this.audioSettings);
    this._bindAudioContextUnlock();
    this._bindLifecycleEvents();
  }

  on(event, fn) { (this._listeners[event] ||= []).push(fn); }
  _emit(event, arg) { (this._listeners[event] || []).forEach(fn => fn(arg)); }

  setAudioSettings(settings = {}) {
    const next = normalizeAudioSettings({
      ...this.audioSettings,
      ...settings,
    });
    this.audioSettings = next;
    this._cancelFade('main');
    this._cancelFade('tts');

    if (this.tts) {
      if (this._preDuckVolume != null) {
        this._preDuckVolume = next.musicVolume;
        this._fadeValue({
          slot: 'main',
          read: () => this.audio.volume,
          write: v => { this.audio.volume = v; },
          target: clamp(next.musicVolume * next.ttsDuckVolume, 0, 1),
          durationMs: next.musicFadeMs,
          min: 0,
          max: 1,
        });
      } else {
        this.audio.volume = next.musicVolume;
      }

      if (this._ttsBoost) {
        this._fadeValue({
          slot: 'tts',
          read: () => this._ttsBoost.gain.gain.value,
          write: v => { this._ttsBoost.gain.gain.value = v; },
          target: next.ttsBoostGain,
          durationMs: next.ttsFadeMs,
          min: 0,
          max: 4,
        });
      } else if (this.tts) {
        this.tts.volume = fallbackTtsElementVolume(next.ttsBoostGain);
      }
      return;
    }

    if (this._preDuckVolume != null) this._preDuckVolume = next.musicVolume;
    this.audio.volume = next.musicVolume;
  }

  getAudioSettings() {
    return { ...this.audioSettings };
  }

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
      this._resetDjPreview();
      if (!sameSrc) this.audio.src = nextSong.url;
      this._updateNowUI(nextSong);
      this._emit('song-change', nextSong);
      this._prefetchDjPreview();
    }

    if (autoplay && (!sameSrc || this.audio.paused)) {
      if (!sameSrc) this.audio.src = nextSong.url;
      if (selectionChanged) {
        this._cancelFade('main');
        this.audio.volume = 0;
      }
      this._pendingAutoplay = true;
      this.audio.play().catch(() => {});
      if (selectionChanged) {
        const targetVolume = this._getMainPlaybackTargetVolume();
        this._fadeValue({
          slot: 'main',
          read: () => this.audio.volume,
          write: v => { this.audio.volume = v; },
          target: targetVolume,
          durationMs: this.audioSettings.musicFadeMs,
          min: 0,
          max: 1,
        });
      }
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
    const state = await api.play('index', i, this._playMeta('manual')).catch(() => null);
    if (state) this.syncState(state, { autoplay: true });
  }

  async requestNext(source = 'manual') {
    const state = await api.next(this._playMeta(source)).catch(() => null);
    if (state) this.syncState(state, { autoplay: true });
  }

  async requestPrev() {
    const state = await api.prev(this._playMeta('manual')).catch(() => null);
    if (state?.nowPlaying?.url) {
      this.syncState(state, { autoplay: true });
      return;
    }
    this.audio.currentTime = 0;
  }

  playTTS(url) {
    return this._playTTS(url);
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
      this._ttsRestoreTimer = setTimeout(() => this._restoreMainAudio(), this.audioSettings.ttsRestoreDelayMs);
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
          target: this.audioSettings.ttsBoostGain,
          durationMs: this.audioSettings.ttsFadeMs,
          min: 0,
          max: 4,
        });
      } else {
        this._fadeValue({
          slot: 'tts',
          read: () => tts.volume,
          write: v => { tts.volume = v; },
          target: 1,
          durationMs: this.audioSettings.ttsFadeMs,
          min: 0,
          max: 1,
        });
      }
      return true;
    } catch {
      finish();
      return false;
    }
  }

  _prefetchDjPreview() {
    const key = this._djPreviewKeyForCurrent();
    if (!key || this._djPreviewInFlight) return;
    if (this._djPreviewKey === key && this._djPreview) return;
    if (this._djPreviewKey === key && Date.now() < this._djPreviewRetryAt) return;

    this._djPreviewKey = key;
    this._djPreview = null;
    const request = api.djPreview()
      .then(data => {
        if (this._djPreviewKey !== key) return;
        if (!data?.preview || !data.ttsUrl || data.currentSongId !== this.currentSong?.id) {
          this._djPreviewRetryAt = Date.now() + 5000;
          return;
        }
        this._djPreview = { ...data, key };
        this._djPreviewRetryAt = 0;
        this._maybePlayDjPreview();
      })
      .catch(error => {
        this._djPreviewRetryAt = Date.now() + 5000;
        console.warn('[dj-preview]', error.message);
      })
      .finally(() => {
        if (this._djPreviewInFlight === request) this._djPreviewInFlight = null;
      });

    this._djPreviewInFlight = request;
  }

  _maybePlayDjPreview() {
    if (!this.currentSong?.id || !this.audio.duration || this.audio.paused) return;
    if (this.tts) return;

    const remainingMs = (this.audio.duration - this.audio.currentTime) * 1000;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > CONFIG.audio.djLeadInMs) return;

    const key = this._djPreviewKeyForCurrent();
    if (!key || this._djPreviewPlayedKey === key) return;
    if (!this._djPreview && !this._djPreviewInFlight) this._prefetchDjPreview();
    if (!this._djPreview?.ttsUrl || this._djPreview.key !== key) return;

    this._djPreviewPlayedKey = key;
    this._emit('dj-preview', this._djPreview);
  }

  _handleMainEnded() {
    void this.requestNext('ended');
  }

  _getMainPlaybackTargetVolume() {
    const base = clamp(this._preDuckVolume ?? this.audioSettings.musicVolume, 0, 1);
    if (!this.tts) return base;
    if (this._preDuckVolume == null) this._preDuckVolume = base;
    return clamp(base * this.audioSettings.ttsDuckVolume, 0, 1);
  }

  _djPreviewKeyForCurrent() {
    const nextSong = this._nextPlayableSong();
    if (!this.currentSong?.id || !nextSong?.id) return '';
    return `${this.currentSong.id}->${nextSong.id}`;
  }

  _nextPlayableSong() {
    const start = this.idx < 0 ? 0 : this.idx + 1;
    for (let i = start; i < this.queue.length; i += 1) {
      if (this.queue[i]?.url) return this.queue[i];
    }
    return null;
  }

  _resetDjPreview() {
    this._djPreview = null;
    this._djPreviewKey = '';
    this._djPreviewInFlight = null;
    this._djPreviewPlayedKey = '';
    this._djPreviewRetryAt = 0;
  }

  _updateNowUI(s) {
    this.ui.nameEl.textContent   = s?.name   || '—';
    this.ui.artistEl.textContent = s?.artist || '';
    this.ui.coverEl.innerHTML    = s?.cover ? `<img src="${s.cover}" alt="">` : '♪';
  }

  _duckMainAudio() {
    if (!this.audio.src || this.audio.paused) return;
    if (this._preDuckVolume == null) {
      this._preDuckVolume = this.audioSettings.musicVolume;
    }
    this._fadeValue({
      slot: 'main',
      read: () => this.audio.volume,
      write: v => { this.audio.volume = v; },
      target: clamp(this._preDuckVolume * this.audioSettings.ttsDuckVolume, 0, 1),
      durationMs: this.audioSettings.musicFadeMs,
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
      durationMs: this.audioSettings.musicFadeMs,
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
    try {
      await this._ensureTtsAudioContext();
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

  _bindAudioContextUnlock() {
    if (this._audioContextUnlockBound || typeof window === 'undefined') return;
    this._audioContextUnlockBound = true;
    const unlock = () => { void this._ensureTtsAudioContext(); };
    window.addEventListener('pointerdown', unlock, { once: true, passive: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
    window.addEventListener('touchstart', unlock, { once: true, passive: true, capture: true });
  }

  _bindLifecycleEvents() {
    if (this._lifecycleBound || typeof document === 'undefined') return;
    this._lifecycleBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      this._flushFades();
      return;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (this._pendingAutoplay && this.currentSong?.url && this.audio.paused) {
        this.audio.play().catch(() => {});
      }
    });
  }

  async _ensureTtsAudioContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext unavailable');
    if (!this._ttsAudioContext) {
      this._ttsAudioContext = new Ctor();
    }
    if (this._ttsAudioContext.state !== 'running') {
      await this._ttsAudioContext.resume();
    }
    return this._ttsAudioContext;
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
    if (tween.type === 'timeout') clearTimeout(tween.frameId);
    else cancelAnimationFrame(tween.frameId);
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
    if (!duration || Math.abs(target - from) < 0.001 || this._shouldSkipAnimatedFade()) {
      write(clamp(target, min, max));
      return;
    }

    const start = performance.now();
    const tween = { frameId: 0, target, write, min, max, type: this._fadeSchedulerType() };
    this._volumeTweens[slot] = tween;

    const tick = now => {
      if (this._volumeTweens[slot] !== tween) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = easeInOutCubic(progress);
      const value = clamp(from + (target - from) * eased, min, max);
      write(value);
      if (progress < 1) tween.frameId = this._scheduleFadeTick(tween, tick);
      else this._volumeTweens[slot] = null;
    };

    tween.frameId = this._scheduleFadeTick(tween, tick);
  }

  _scheduleFadeTick(tween, tick) {
    if (tween.type === 'timeout') {
      return setTimeout(() => tick(performance.now()), 16);
    }
    return requestAnimationFrame(tick);
  }

  _fadeSchedulerType() {
    if (typeof document !== 'undefined' && document.hidden) return 'timeout';
    if (typeof requestAnimationFrame !== 'function') return 'timeout';
    return 'raf';
  }

  _shouldSkipAnimatedFade() {
    return typeof document !== 'undefined' && document.hidden;
  }

  _flushFades() {
    for (const slot of Object.keys(this._volumeTweens)) {
      const tween = this._volumeTweens[slot];
      if (!tween) continue;
      this._cancelFade(slot);
      tween.write(clamp(tween.target, tween.min, tween.max));
    }
  }

  _playMeta(source = 'manual') {
    const durationMs = Number.isFinite(this.audio.duration) && this.audio.duration > 0
      ? Math.round(this.audio.duration * 1000)
      : 0;
    const playedMs = Math.max(0, Math.round(this.audio.currentTime * 1000));
    return {
      source,
      playedMs,
      durationMs,
      requestText: this.currentSong?.requestText || '',
      reasonText: this.currentSong?.requestReason || '',
      reasonLabels: Array.isArray(this.currentSong?.reasonLabels) ? this.currentSong.reasonLabels : [],
      skipStrength: estimateSkipStrength({ playedMs, durationMs }),
    };
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAudioSettings(input = {}) {
  return {
    musicVolume: clamp(numberOr(input.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume), 0, 1),
    ttsBoostGain: clamp(numberOr(input.ttsBoostGain, DEFAULT_AUDIO_SETTINGS.ttsBoostGain), 0, 4),
    ttsDuckVolume: clamp(numberOr(input.ttsDuckVolume, DEFAULT_AUDIO_SETTINGS.ttsDuckVolume), 0, 1),
    musicFadeMs: clamp(numberOr(input.musicFadeMs, DEFAULT_AUDIO_SETTINGS.musicFadeMs), 0, 2000),
    ttsFadeMs: clamp(numberOr(input.ttsFadeMs, DEFAULT_AUDIO_SETTINGS.ttsFadeMs), 0, 2000),
    ttsRestoreDelayMs: clamp(numberOr(input.ttsRestoreDelayMs, DEFAULT_AUDIO_SETTINGS.ttsRestoreDelayMs), 0, 2000),
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fallbackTtsElementVolume(boostGain) {
  return clamp(numberOr(boostGain, DEFAULT_AUDIO_SETTINGS.ttsBoostGain), 0, 1);
}

function estimateSkipStrength({ playedMs = 0, durationMs = 0 } = {}) {
  const played = Number(playedMs);
  const duration = Number(durationMs);
  const progress = Number.isFinite(played) && Number.isFinite(duration) && duration > 0
    ? clamp(played / duration, 0, 1)
    : 0;

  if (progress <= 0.05 || played <= 15000) return 1;
  if (progress <= 0.15) return 0.82;
  if (progress <= 0.35) return 0.58;
  if (progress <= 0.65) return 0.35;
  if (progress <= 0.85) return 0.18;
  return 0.08;
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
