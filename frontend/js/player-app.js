/**
 * 独立播放器窗口：当前播放、节目队列、DJ 对话输入。
 */
import { api, connectWs } from './api.js';
import { Chat } from './chat.js';
import { QueueView } from './queue.js';
import { Player } from './player.js';
import { syncLyrics } from './lyrics.js';

const $ = id => document.getElementById(id);
const audioEl = $('audio');
const inputEl = $('input');
const modeSongBtn = $('mode-song');
const modeChatBtn = $('mode-chat');
const lyricEl = $('lyric-ticker');
const miniMessages = $('mini-messages');
const seenChatIds = new Set();
const PLAYER_WINDOW_HEARTBEAT_KEY = 'gpt-neural-radio-player-heartbeat';
let inputMode = 'song';

const player = new Player(audioEl, {
  btnPlay: $('btn-play'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  progress: $('progress-wrap'),
  progressBar: $('progress-bar'),
  nameEl: $('player-song'),
  artistEl: $('player-artist'),
  coverEl: $('player-cover'),
  stateEl: $('player-state'),
  sourceEl: $('player-source'),
  timeEl: $('player-time'),
});

const queueView = new QueueView($('queue-items'), idx => player.requestPlayIdx(idx), { limit: 11 });
queueView.attachStatus($('queue-status'));
const miniChat = new MiniChat(miniMessages);
const visualizer = new Visualizer(audioEl, $('wave-canvas'));
let stopLyrics = () => {};

player.on('song-change', song => {
  queueView.setActive(player.idx);
  setInputMode(song ? 'chat' : 'song', { auto: true });
  stopLyrics();
  stopLyrics = syncLyrics(audioEl, song?.lyric || '', text => {
    lyricEl.textContent = text;
  });
});
player.on('queue-change', queue => queueView.setQueue(queue));
player.on('dj-preview', preview => {
  if (preview.say) miniChat.add('ai', preview.say);
  if (preview.ttsUrl) {
    void player.playTTS(preview.ttsUrl).then(started => {
      if (started) api.markDjPreview(preview.nextSongId).catch(() => {});
    });
  }
});

modeSongBtn.addEventListener('click', () => {
  setInputMode('song');
  inputEl.focus();
});
modeChatBtn.addEventListener('click', () => {
  setInputMode('chat');
  inputEl.focus();
});
$('send-btn').addEventListener('click', submit);
inputEl.addEventListener('keydown', event => {
  if (event.key === 'Enter') submit();
});
$('focus-main').addEventListener('click', () => $('now-panel').scrollIntoView({ block: 'start', behavior: 'smooth' }));

connectWs(data => {
  if (data.type === 'chat') {
    handlePayload(data);
  } else if (data.type === 'dj') {
    if (data.say) miniChat.add('ai', data.say);
    if (data.ttsUrl) player.playTTS(data.ttsUrl);
  } else if (data.type === 'connected' || data.type === 'schedule' || data.type === 'now-playing') {
    player.syncState(data, { autoplay: true });
    if (data.say) miniChat.add('ai', data.say);
    if (data.ttsUrl) player.playTTS(data.ttsUrl);
  }
});

api.now()
  .then(data => {
    player.syncState(data, { autoplay: true });
    setInputMode(data?.nowPlaying?.url ? 'chat' : 'song', { auto: true });
  })
  .catch(error => console.warn('[player:init]', error.message));

notifyOpener('radio-player-ready');
writeHeartbeat();
setInterval(writeHeartbeat, 1500);
window.addEventListener('beforeunload', () => {
  localStorage.removeItem(PLAYER_WINDOW_HEARTBEAT_KEY);
  notifyOpener('radio-player-closed');
});
window.addEventListener('pointerdown', () => visualizer.resume(), { passive: true });
window.addEventListener('keydown', () => visualizer.resume());
visualizer.start();

function submit() {
  const value = inputEl.value.trim();
  if (!value) return;
  inputEl.value = '';
  send(value);
}

async function send(message) {
  const requestId = createRequestId();
  miniChat.add('user', message);
  miniChat.showTyping();
  try {
    const data = await api.chat(message, requestId, inputMode);
    miniChat.hideTyping();
    handlePayload(data);
  } catch (error) {
    miniChat.hideTyping();
    miniChat.add('ai', '信号断了一下，稍后再试。');
    console.error(error);
  }
}

function handlePayload(data) {
  if (shouldSkipChatPayload(data?.requestId)) return;
  if (!data?.chatOnly) player.syncState(data, { autoplay: true });
  if (data.say) miniChat.add('ai', data.say);
  if (data.ttsUrl) player.playTTS(data.ttsUrl);
}

function setInputMode(mode, { auto = false } = {}) {
  const next = mode === 'chat' ? 'chat' : 'song';
  if (!auto || inputMode !== next) inputMode = next;
  modeSongBtn.classList.toggle('active', inputMode === 'song');
  modeChatBtn.classList.toggle('active', inputMode === 'chat');
  modeSongBtn.setAttribute('aria-pressed', inputMode === 'song' ? 'true' : 'false');
  modeChatBtn.setAttribute('aria-pressed', inputMode === 'chat' ? 'true' : 'false');
  inputEl.placeholder = inputMode === 'song'
    ? '说你想听什么_'
    : '和 anjiu 聊聊当前这首歌_';
}

function shouldSkipChatPayload(requestId) {
  if (!requestId) return false;
  if (seenChatIds.has(requestId)) return true;
  seenChatIds.add(requestId);
  setTimeout(() => seenChatIds.delete(requestId), 60000);
  return false;
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `player_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function notifyOpener(type) {
  if (!window.opener || window.opener.closed) return;
  window.opener.postMessage({ type }, window.location.origin);
}

function writeHeartbeat() {
  localStorage.setItem(PLAYER_WINDOW_HEARTBEAT_KEY, String(Date.now()));
}

class MiniChat extends Chat {
  add(role, text) {
    const node = document.createElement('div');
    node.className = `mini-msg ${role}`;
    node.textContent = text;
    this.listEl.appendChild(node);
    while (this.listEl.children.length > 3) this.listEl.firstElementChild.remove();
    this._scrollToBottom();
    return node;
  }

  showTyping() {
    if (this.listEl.querySelector('[data-typing]')) return;
    const node = document.createElement('div');
    node.className = 'mini-msg ai';
    node.dataset.typing = '1';
    node.textContent = 'anjiu 正在听你说';
    this.listEl.appendChild(node);
    this._scrollToBottom();
  }

  hideTyping() {
    this.listEl.querySelector('[data-typing]')?.remove();
  }
}

class Visualizer {
  constructor(audio, canvas) {
    this.audio = audio;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audioCtx = null;
    this.analyser = null;
    this.data = new Uint8Array(96);
    this.running = false;
    this.fakeLevel = 0.08;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  start() {
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(() => this.draw());
    }
    void this.resume();
  }

  async resume() {
    await this.initAudioGraph().catch(() => {});
    if (this.audioCtx?.state !== 'running') {
      await this.audioCtx.resume().catch(() => {});
    }
  }

  async initAudioGraph() {
    if (this.audioCtx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    this.audioCtx = new Ctor();
    this.audio.crossOrigin = 'anonymous';
    const source = this.audioCtx.createMediaElementSource(this.audio);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    await this.audioCtx.resume();
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(320, Math.floor(rect.width * ratio));
    this.canvas.height = Math.max(100, Math.floor(rect.height * ratio));
  }

  draw() {
    if (!this.running) return;
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.020)';
    ctx.fillRect(0, Math.floor(height / 2), width, 1);

    const bars = 72;
    const gap = 3;
    const barW = Math.max(2, Math.floor((width - gap * (bars - 1)) / bars));
    if (this.analyser && this.audioCtx?.state === 'running') {
      this.analyser.getByteFrequencyData(this.data);
    }

    for (let i = 0; i < bars; i += 1) {
      const datum = this.analyser ? this.data[Math.floor(i / bars * this.data.length)] / 255 : this.nextFakeLevel();
      const level = Math.max(0.06, datum);
      const h = Math.max(6, level * height * 0.72);
      const x = i * (barW + gap);
      const y = (height - h) / 2;
      ctx.fillStyle = `rgba(209,215,221,${0.18 + level * 0.55})`;
      ctx.fillRect(x, y, barW, h);
    }

    requestAnimationFrame(() => this.draw());
  }

  nextFakeLevel() {
    const target = this.audio.paused ? 0.08 + Math.random() * 0.05 : 0.24 + Math.random() * 0.44;
    this.fakeLevel += (target - this.fakeLevel) * 0.12;
    return this.fakeLevel;
  }
}
