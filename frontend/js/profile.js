/**
 * 用户画像编辑面板。把长期偏好保存到后端 user/profile.json。
 */
import { api } from './api.js';

const FIELDS = [
  ['taste.favoriteArtists', '喜欢歌手', '陶喆, 陈奕迅, Radiohead'],
  ['taste.favoriteGenres', '喜欢风格', 'R&B, City Pop, Indie Rock'],
  ['taste.favoriteLanguages', '偏好语种', '中文, 英文, 日文'],
  ['taste.preferredTempo', '节奏偏好', '中慢速, 不要太躁'],
  ['taste.avoid', '避免内容', '太吵的 EDM, 过甜情歌'],
  ['scenes.work', '工作时', '少人声, 节奏稳定'],
  ['scenes.lateNight', '深夜', '安静, 低频, 克制'],
  ['scenes.sleep', '睡前', '器乐, 轻声, 不要鼓点太重'],
  ['djStyle.tone', 'DJ 语气', '克制、成熟、像深夜电台主持人'],
  ['djStyle.songIntro', '歌曲介绍', '讲背景和听感, 不要太百科'],
  ['djStyle.transition', '过渡方式', '上一首和下一首自然衔接'],
  ['notes', '补充笔记', '任何你想让 anjiu 长期记住的偏好'],
];

export function mountProfilePanel(root, trigger) {
  if (!root) return;

  root.innerHTML = `
    <div id="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <div id="profile-head">
        <div>
          <div id="profile-title">USER PROFILE</div>
          <div id="profile-status">LOADING</div>
        </div>
        <button id="profile-close" type="button" aria-label="close">CLOSE</button>
      </div>
      <section id="profile-suggestion">
        <div id="profile-suggestion-text">根据最近播放生成候选画像，确认后再保存。</div>
        <div id="profile-suggestion-actions">
          <button type="button" id="profile-learn">LEARN</button>
          <button type="button" id="profile-apply" hidden>APPLY</button>
        </div>
      </section>
      <form id="profile-form"></form>
    </div>
  `;

  const form = root.querySelector('#profile-form');
  const status = root.querySelector('#profile-status');
  const close = root.querySelector('#profile-close');
  const suggestionText = root.querySelector('#profile-suggestion-text');
  const learn = root.querySelector('#profile-learn');
  const apply = root.querySelector('#profile-apply');
  const fields = new Map();
  let pendingSuggestion = null;

  for (const [path, label, placeholder] of FIELDS) {
    const field = document.createElement('label');
    field.className = 'profile-field';
    field.innerHTML = `
      <span>${label}</span>
      <textarea rows="2" data-profile-path="${path}" placeholder="${escapeAttr(placeholder)}"></textarea>
    `;
    form.appendChild(field);
    fields.set(path, field.querySelector('textarea'));
  }

  const actions = document.createElement('div');
  actions.id = 'profile-actions';
  actions.innerHTML = `
    <button type="submit">SAVE</button>
    <button type="button" id="profile-cancel">CLOSE</button>
  `;
  form.appendChild(actions);

  const openModal = () => {
    root.hidden = false;
    trigger?.setAttribute('aria-expanded', 'true');
    form.querySelector('textarea')?.focus();
  };
  const closeModal = () => {
    root.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.focus();
  };

  trigger?.setAttribute('aria-expanded', 'false');
  trigger?.addEventListener('click', openModal);
  close.addEventListener('click', closeModal);
  form.querySelector('#profile-cancel').addEventListener('click', closeModal);
  learn.addEventListener('click', async () => {
    status.textContent = 'LEARNING';
    learn.disabled = true;
    try {
      const data = await api.getProfileSuggestion();
      pendingSuggestion = data.suggestion || null;
      if (!pendingSuggestion?.available) {
        suggestionText.textContent = '最近播放还不够形成稳定建议。继续听一段时间再试。';
        apply.hidden = true;
      } else {
        suggestionText.textContent = pendingSuggestion.reasons.join('；');
        apply.hidden = false;
      }
      status.textContent = 'READY';
    } catch (error) {
      console.error(error);
      suggestionText.textContent = '学习建议生成失败。';
      status.textContent = 'LEARN FAILED';
    } finally {
      learn.disabled = false;
    }
  });
  apply.addEventListener('click', async () => {
    if (!pendingSuggestion?.patch) return;
    fillProfile(fields, pendingSuggestion.patch);
    status.textContent = 'SAVING';
    try {
      const data = await api.saveProfile(collectProfile(fields));
      fillProfile(fields, data.profile || {});
      status.textContent = 'SAVED';
      suggestionText.textContent = '建议已应用到长期画像。';
      apply.hidden = true;
      pendingSuggestion = null;
    } catch (error) {
      console.error(error);
      status.textContent = 'SAVE FAILED';
    }
  });
  root.addEventListener('click', event => {
    if (event.target === root) closeModal();
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    status.textContent = 'SAVING';
    try {
      const profile = collectProfile(fields);
      const data = await api.saveProfile(profile);
      fillProfile(fields, data.profile || {});
      status.textContent = 'SAVED';
    } catch (error) {
      console.error(error);
      status.textContent = 'SAVE FAILED';
    }
  });

  api.getProfile()
    .then(data => {
      fillProfile(fields, data.profile || {});
      status.textContent = 'READY';
    })
    .catch(error => {
      console.error(error);
      status.textContent = 'LOAD FAILED';
    });
}

function collectProfile(fields) {
  const profile = {};
  for (const [path, input] of fields) {
    setPath(profile, path, input.value.trim());
  }
  return profile;
}

function fillProfile(fields, profile) {
  for (const [path, input] of fields) {
    input.value = getPath(profile, path) || '';
  }
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]] ||= {};
  }
  current[parts.at(-1)] = value;
}

function getPath(source, path) {
  return path.split('.').reduce((value, key) => value?.[key], source);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
