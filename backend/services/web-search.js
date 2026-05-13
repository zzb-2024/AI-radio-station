/**
 * 国内联网搜索。当前接入智谱 Web Search API。
 */
import { config } from '../config.js';
import { requestJson } from '../lib/http.js';

const ZHIPU_WEB_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';

export function hasWebSearchConfig() {
  return config.webSearch.provider === 'zhipu' && Boolean(config.webSearch.apiKey);
}

export async function searchWeb(query, {
  count = config.webSearch.count,
  recency = config.webSearch.recency,
  contentSize = config.webSearch.contentSize,
  requestId = '',
} = {}) {
  if (!hasWebSearchConfig()) return null;

  const searchQuery = normalizeSearchQuery(query);
  if (!searchQuery) return null;

  const body = {
    search_query: searchQuery,
    search_engine: normalizeSearchEngine(config.webSearch.engine),
    search_intent: false,
    count: clamp(count, 1, 10),
    search_recency_filter: recency,
    content_size: contentSize,
    user_id: String(config.webSearch.userId || 'ai-radio-station').slice(0, 128),
  };
  if (requestId) body.request_id = String(requestId).slice(0, 64);
  if (config.webSearch.domainFilter) {
    body.search_domain_filter = config.webSearch.domainFilter
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  const { json } = await requestJson({
    url: ZHIPU_WEB_SEARCH_URL,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.webSearch.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeoutMs: config.webSearch.timeoutMs,
  });

  return normalizeZhipuSearchResponse(json, searchQuery, body.search_engine);
}

function normalizeZhipuSearchResponse(json, query, engine) {
  const searchIntent = Array.isArray(json?.search_intent)
    ? json.search_intent[0] || null
    : json?.search_intent || null;
  const rawResults = Array.isArray(json?.search_result)
    ? json.search_result
    : Array.isArray(json?.results)
      ? json.results
      : Array.isArray(json?.data)
        ? json.data
        : [];

  return {
    query,
    engine,
    intent: {
      keywords: String(searchIntent?.keywords || ''),
      query: String(searchIntent?.query || ''),
      intent: String(searchIntent?.intent || ''),
    },
    results: rawResults.map(normalizeResult).filter(result => result.title || result.content || result.link),
  };
}

function normalizeResult(item) {
  return {
    title: String(item?.title || '').trim(),
    content: String(item?.content || item?.summary || item?.snippet || '').replace(/\s+/g, ' ').trim(),
    link: String(item?.link || item?.url || '').trim(),
    media: String(item?.media || item?.source || item?.site_name || '').trim(),
    icon: String(item?.icon || '').trim(),
    publishDate: String(item?.publish_date || item?.publishDate || item?.date || '').trim(),
    refer: String(item?.refer || '').trim(),
  };
}

function normalizeSearchEngine(engine) {
  return String(engine || 'search_std').replace(/-/g, '_');
}

function normalizeSearchQuery(query) {
  return String(query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}
