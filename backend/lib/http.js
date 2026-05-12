/**
 * HTTP 通用请求 helper。统一超时、错误、JSON 解析。
 * 业务模块通过它发起所有外部 HTTP(S) 请求。
 */
import http from 'http';
import https from 'https';

/**
 * 发起 HTTP 请求。
 * @param {object} opts
 * @param {string} opts.url - 完整 URL（含协议）
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<{status:number, headers:object, text:string}>}
 */
export function request({ url, method = 'GET', headers = {}, body, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'http:' ? http : https;
    const h = { ...headers };
    if (body != null && h['Content-Length'] == null) {
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method,
      headers: h,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout: ${url}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 发起请求并解析 JSON 响应。
 * @throws Error 如果响应不是合法 JSON
 */
export async function requestJson(opts) {
  const res = await request(opts);
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error(`invalid json from ${opts.url}: ${res.text.slice(0, 200)}`);
  }
  if ((res.status || 0) >= 400) {
    const detail = json?.error?.message || json?.error || json?.message || res.text.slice(0, 200);
    throw new Error(`HTTP ${res.status} from ${opts.url}: ${detail}`);
  }
  return { ...res, json };
}

/**
 * 发起请求并返回原始二进制响应。用于需要自行判断 content-type 的接口。
 * @param {object} opts 同 request
 * @returns {Promise<{status:number, headers:object, buffer:Buffer}>}
 */
export function requestBuffer({ url, method = 'GET', headers = {}, body, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'http:' ? http : https;
    const h = { ...headers };
    if (body != null && h['Content-Length'] == null) {
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method,
      headers: h,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout: ${url}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 发起请求，把响应体流式写入文件。用于下载二进制资源（如 TTS mp3）。
 * @param {object} opts 同 request
 * @param {import('fs').WriteStream} fileStream
 */
export function requestStream({ url, method = 'GET', headers = {}, body, timeoutMs = 30000 }, fileStream) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'http:' ? http : https;
    const h = { ...headers };
    if (body != null && h['Content-Length'] == null) {
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method,
      headers: h,
    }, res => {
      if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
        res.resume();
        return reject(new Error(`stream HTTP ${res.statusCode}: ${url}`));
      }
      res.pipe(fileStream);
      fileStream.on('finish', () => resolve({ status: res.statusCode, headers: res.headers }));
      fileStream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`stream timeout: ${url}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 把上游流直接代理到 express 响应。透传 Range 请求 + 关键响应头，
 * 让浏览器能做 seek（HTTP 206 Partial Content）。
 *
 * @param {object} opts
 * @param {string} opts.url - 上游完整 URL
 * @param {import('express').Request} opts.req
 * @param {import('express').Response} opts.res
 * @param {number} [opts.timeoutMs=30000]
 */
export function proxyStream({ url, req, res, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'http:' ? http : https;

    const upstreamHeaders = {
      // 有的 CDN 会校验 UA/Referer，保守带上
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Referer': 'https://music.163.com/',
    };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const up = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: upstreamHeaders,
    }, upRes => {
      res.status(upRes.statusCode || 502);
      // 透传允许 seek 所需的响应头
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag']) {
        if (upRes.headers[h]) res.setHeader(h, upRes.headers[h]);
      }
      upRes.pipe(res);
      upRes.on('end', () => resolve());
      upRes.on('error', reject);
    });

    // 客户端提前断开（切歌、关页面）立刻释放上游
    res.on('close', () => up.destroy());

    up.on('error', reject);
    up.setTimeout(timeoutMs, () => up.destroy(new Error(`proxy timeout: ${url}`)));
    up.end();
  });
}
