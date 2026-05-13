/**
 * 前端声音面板。只保存到浏览器本地，调整后立即作用到播放器。
 */
import { CONFIG } from './config.js';

const STORAGE_KEY = 'gpt-neural-radio:sound-v1';

const DEFAULTS = {
  musicVolume: 1,
  ttsBoostGain: CONFIG.audio.ttsBoostGain,
  ttsDuckVolume: CONFIG.audio.ttsDuckVolume,
  musicFadeMs: CONFIG.audio.musicFadeMs,
  ttsFadeMs: CONFIG.audio.ttsFadeMs,
  ttsRestoreDelayMs: CONFIG.audio.ttsRestoreDelayMs,
};

const CONTROLS = [
  {
    key: 'musicVolume',
    label: '音乐音量',
    min: 0,
    max: 1,
    step: 0.01,
    format: value => `${Math.round(value * 100)}%`,
  },
  {
    key: 'ttsBoostGain',
    label: 'TTS 音量',
    min: 0.5,
    max: 4,
    step: 0.05,
    format: value => `${Math.round(value * 100)}%`,
  },
  {
    key: 'ttsDuckVolume',
    label: '口播时音乐',
    min: 0,
    max: 1,
    step: 0.01,
    format: value => `${Math.round(value * 100)}%`,
  },
];

export function mountSoundPanel(root, trigger, player) {
  if (!root || !player) return;

  let state = normalizeSettings({
    ...DEFAULTS,
    ...loadSettings(),
  });

  player.setAudioSettings(state);

  root.innerHTML = `
    <div id="sound-dialog" role="dialog" aria-modal="true" aria-labelledby="sound-title">
      <div id="sound-head">
        <div>
          <div id="sound-title">SOUND MIXER</div>
          <div id="sound-status">LOCAL</div>
        </div>
        <button id="sound-close" type="button" aria-label="close">CLOSE</button>
      </div>
      <form id="sound-form"></form>
    </div>
  `;

  const form = root.querySelector('#sound-form');
  const status = root.querySelector('#sound-status');
  const close = root.querySelector('#sound-close');
  const inputs = new Map();
  const outputs = new Map();

  for (const control of CONTROLS) {
    const field = document.createElement('label');
    field.className = 'sound-field';
    field.innerHTML = `
      <div class="sound-field-head">
        <span>${control.label}</span>
        <output data-sound-output="${control.key}"></output>
      </div>
      <input type="range"
             data-sound-key="${control.key}"
             min="${control.min}"
             max="${control.max}"
             step="${control.step}">
    `;
    form.appendChild(field);
    inputs.set(control.key, field.querySelector('input'));
    outputs.set(control.key, field.querySelector('output'));
  }

  const actions = document.createElement('div');
  actions.id = 'sound-actions';
  actions.innerHTML = `
    <button type="button" id="sound-reset">RESET</button>
    <button type="button" id="sound-done">CLOSE</button>
  `;
  form.appendChild(actions);

  const openModal = () => {
    syncFields();
    root.hidden = false;
    trigger?.setAttribute('aria-expanded', 'true');
    form.querySelector('input')?.focus();
  };
  const closeModal = () => {
    root.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.focus();
  };

  trigger?.setAttribute('aria-expanded', 'false');
  trigger?.addEventListener('click', openModal);
  close.addEventListener('click', closeModal);
  form.querySelector('#sound-done').addEventListener('click', closeModal);
  form.querySelector('#sound-reset').addEventListener('click', () => {
    state = normalizeSettings(DEFAULTS);
    saveSettings(state);
    player.setAudioSettings(state);
    syncFields();
    status.textContent = 'RESET';
  });
  root.addEventListener('click', event => {
    if (event.target === root) closeModal();
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
  });
  form.addEventListener('input', event => {
    const key = event.target?.dataset?.soundKey;
    if (!key) return;
    state = normalizeSettings({
      ...state,
      [key]: Number(event.target.value),
    });
    player.setAudioSettings(state);
    saveSettings(state);
    syncFields();
    status.textContent = 'SAVED';
  });

  syncFields();

  function syncFields() {
    for (const control of CONTROLS) {
      const value = state[control.key];
      const input = inputs.get(control.key);
      const output = outputs.get(control.key);
      if (input) input.value = String(value);
      if (output) output.textContent = control.format(value);
    }
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 浏览器禁止 localStorage 时也允许当前会话继续使用。
  }
}

function normalizeSettings(input = {}) {
  return {
    musicVolume: clamp(numberOr(input.musicVolume, DEFAULTS.musicVolume), 0, 1),
    ttsBoostGain: clamp(numberOr(input.ttsBoostGain, DEFAULTS.ttsBoostGain), 0.5, 4),
    ttsDuckVolume: clamp(numberOr(input.ttsDuckVolume, DEFAULTS.ttsDuckVolume), 0, 1),
    musicFadeMs: clamp(numberOr(input.musicFadeMs, DEFAULTS.musicFadeMs), 0, 2000),
    ttsFadeMs: clamp(numberOr(input.ttsFadeMs, DEFAULTS.ttsFadeMs), 0, 2000),
    ttsRestoreDelayMs: clamp(numberOr(input.ttsRestoreDelayMs, DEFAULTS.ttsRestoreDelayMs), 0, 2000),
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
