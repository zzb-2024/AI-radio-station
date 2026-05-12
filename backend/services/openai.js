/**
 * OpenAI GPT-5.5 对话调用。
 */
import { config } from '../config.js';
import { request } from '../lib/http.js';

export function hasOpenAIConfig() {
  return Boolean(config.openai.apiKey);
}

export async function completeOpenAI({
  systemPrompt,
  messages,
  maxTokens = config.openai.maxTokens,
} = {}) {
  const body = {
    model: config.openai.model,
    instructions: systemPrompt || '',
    input: (messages || []).map(toResponseInputMessage),
    max_output_tokens: maxTokens,
    reasoning: {
      effort: config.openai.reasoningEffort,
    },
    store: false,
    stream: true,
  };

  const res = await request({
    url: buildOpenAIUrl('/responses'),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify(body),
    timeoutMs: config.openai.timeoutMs,
  });

  if ((res.status || 0) >= 400) {
    throw new Error(`HTTP ${res.status} from ${buildOpenAIUrl('/responses')}: ${extractErrorDetail(res.text)}`);
  }

  const text = parseOpenAIResponse(res.text);
  if (!text) {
    throw new Error('OpenAI returned empty content');
  }
  return text;
}

function toResponseInputMessage(message) {
  const role = ['user', 'assistant', 'developer', 'system'].includes(message?.role)
    ? message.role
    : 'user';
  return {
    role,
    content: [
      {
        type: 'input_text',
        text: String(message?.content || ''),
      },
    ],
  };
}

function extractResponseText(json) {
  if (typeof json?.output_text === 'string') {
    return json.output_text.trim();
  }

  const parts = [];
  for (const item of json?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (typeof content?.refusal === 'string' && content.refusal.trim()) {
        throw new Error(`OpenAI refusal: ${content.refusal.trim()}`);
      }
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }

  return parts.join('\n').trim();
}

function parseOpenAIResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  if (raw.startsWith('{')) {
    return extractResponseText(JSON.parse(raw));
  }

  return extractResponseStream(raw);
}

function extractResponseStream(text) {
  let deltaText = '';
  let finalText = '';

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data || data === '[DONE]') continue;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltaText += event.delta;
      continue;
    }

    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      finalText = event.text;
      continue;
    }

    if (event.type === 'response.refusal.delta' && typeof event.delta === 'string') {
      throw new Error(`OpenAI refusal: ${event.delta}`);
    }

    if (event.type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'OpenAI response failed');
    }

    if (event.type === 'error') {
      throw new Error(event.message || event.error?.message || 'OpenAI stream error');
    }
  }

  return (finalText || deltaText).trim();
}

function extractErrorDetail(text) {
  const raw = String(text || '').trim();
  try {
    const json = JSON.parse(raw);
    return json?.error?.message || json?.error || json?.message || raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

function buildOpenAIUrl(path) {
  const base = String(config.openai.apiUrl || 'https://api.openai.com')
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
  return `${base}/v1${path}`;
}
