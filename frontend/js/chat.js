/**
 * 聊天消息流。用户/AI 消息 + 打字指示器。
 */

const ROLES = { user: 'YOU', ai: 'anjiu' };

export class Chat {
  /**
   * @param {HTMLElement} listEl - 消息容器
   */
  constructor(listEl) {
    this.listEl = listEl;
  }

  /**
   * 追加一条消息（使用 textContent，自动转义）。
   */
  add(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;

    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = ROLES[role] || role;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;

    wrap.append(label, bubble);
    this.listEl.appendChild(wrap);
    this._scrollToBottom();
    return wrap;
  }

  /**
   * 显示打字指示器（已在则不重复添加）。
   */
  showTyping() {
    if (this.listEl.querySelector('[data-typing]')) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.dataset.typing = '1';
    wrap.innerHTML = `
      <div class="msg-label">anjiu</div>
      <div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>
    `;
    this.listEl.appendChild(wrap);
    this._scrollToBottom();
  }

  hideTyping() {
    this.listEl.querySelector('[data-typing]')?.remove();
  }

  _scrollToBottom() {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}
