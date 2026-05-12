/**
 * 天气查询。默认使用彩云天气 v2.6，保留 OpenWeather 作为兼容 fallback。
 */
import { createHmac, randomBytes } from 'crypto';
import { config } from '../config.js';
import { requestJson } from '../lib/http.js';

/**
 * 拿当前城市的简短天气描述。未配置 key 或失败时返回 null。
 */
export async function fetchWeather(city = config.weather.city) {
  if (config.weather.provider !== 'openweather') {
    const caiyunWeather = await fetchCaiyunWeather(city);
    if (caiyunWeather) return caiyunWeather;
  }

  return fetchOpenWeather(city);
}

async function fetchCaiyunWeather(city) {
  const appKey = config.weather.caiyun.appKey || config.weather.caiyun.token;
  if (!appKey) return null;

  const path = `/v2.6/${encodeURIComponent(appKey)}/${config.weather.longitude},${config.weather.latitude}/weather`;
  const query = {
    alert: 'false',
    dailysteps: '1',
    hourlysteps: '24',
    lang: 'zh_CN',
    unit: 'metric',
  };
  const url = `https://api.caiyunapp.com${path}?${buildQuery(query)}`;
  const headers = buildCaiyunAuthHeaders({ appKey, path, query });

  try {
    const { json } = await requestJson({ url, headers, timeoutMs: config.weather.timeoutMs });
    if (json.status !== 'ok') return null;
    return formatCaiyunWeather(json, city);
  } catch (error) {
    console.warn(`[weather] caiyun failed: ${error.message}`);
    return null;
  }
}

async function fetchOpenWeather(city) {
  if (!config.weather.openWeatherKey) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${config.weather.openWeatherKey}&lang=zh_cn&units=metric`;
  try {
    const { json } = await requestJson({ url, timeoutMs: config.weather.timeoutMs });
    return `${json.weather[0].description}，${Math.round(json.main.temp)}°C`;
  } catch (error) {
    console.warn(`[weather] openweather failed: ${error.message}`);
    return null;
  }
}

function buildCaiyunAuthHeaders({ appKey, path, query }) {
  if (!config.weather.caiyun.appSecret) return {};

  const nonce = randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    'x-cy-nonce': nonce,
    'x-cy-timestamp': timestamp,
    'x-cy-signature': signCaiyunRequest({
      appKey,
      appSecret: config.weather.caiyun.appSecret,
      method: 'GET',
      path,
      query,
      nonce,
      timestamp,
    }),
  };
}

function signCaiyunRequest({ appKey, appSecret, method, path, query, nonce, timestamp }) {
  const stringToSign = [
    method,
    path,
    buildQuery(query),
    appKey,
    nonce,
    timestamp,
  ].join(':');

  return createHmac('sha256', appSecret)
    .update(stringToSign)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function buildQuery(query) {
  return Object.keys(query)
    .sort()
    .map(key => `${encodeQueryComponent(key)}=${encodeQueryComponent(query[key])}`)
    .join('&');
}

function encodeQueryComponent(input) {
  return encodeURIComponent(String(input))
    .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

function formatCaiyunWeather(json, city) {
  const result = json.result || {};
  const realtime = result.realtime || {};
  const hourly = result.hourly || {};
  const daily = result.daily || {};
  const parts = [
    city,
    skyconText(realtime.skycon),
    formatNumber(realtime.temperature, '°C'),
  ].filter(Boolean);

  const apparent = formatNumber(realtime.apparent_temperature, '°C');
  if (apparent) parts.push(`体感${apparent}`);

  const humidity = Number(realtime.humidity);
  if (Number.isFinite(humidity)) parts.push(`湿度${Math.round(humidity * 100)}%`);

  const wind = formatWind(realtime.wind);
  if (wind) parts.push(wind);

  const aqi = realtime.air_quality?.aqi?.chn;
  const aqiDesc = realtime.air_quality?.description?.chn;
  if (Number.isFinite(Number(aqi))) {
    parts.push(`AQI ${Math.round(Number(aqi))}${aqiDesc ? ` ${aqiDesc}` : ''}`);
  }

  const dailyTemp = formatDailyTemperature(daily.temperature?.[0]);
  if (dailyTemp) parts.push(`今日${dailyTemp}`);

  const description = hourly.description || result.forecast_keypoint;
  if (description) parts.push(description);

  return parts.join('，');
}

function formatNumber(value, suffix) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}${suffix}` : '';
}

function formatDailyTemperature(day) {
  const min = Number(day?.min);
  const max = Number(day?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
  return `${Math.round(min)}-${Math.round(max)}°C`;
}

function formatWind(wind) {
  const speed = Number(wind?.speed);
  if (!Number.isFinite(speed)) return '';
  return `${windDirectionText(wind.direction)}风${speed.toFixed(1)}km/h`;
}

function windDirectionText(direction) {
  const number = Number(direction);
  if (!Number.isFinite(number)) return '';
  const labels = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return labels[Math.round(number / 45) % labels.length];
}

function skyconText(code) {
  return {
    CLEAR_DAY: '晴',
    CLEAR_NIGHT: '晴',
    PARTLY_CLOUDY_DAY: '多云',
    PARTLY_CLOUDY_NIGHT: '多云',
    CLOUDY: '阴',
    LIGHT_HAZE: '轻度雾霾',
    MODERATE_HAZE: '中度雾霾',
    HEAVY_HAZE: '重度雾霾',
    LIGHT_RAIN: '小雨',
    MODERATE_RAIN: '中雨',
    HEAVY_RAIN: '大雨',
    STORM_RAIN: '暴雨',
    FOG: '雾',
    LIGHT_SNOW: '小雪',
    MODERATE_SNOW: '中雪',
    HEAVY_SNOW: '大雪',
    STORM_SNOW: '暴雪',
    DUST: '浮尘',
    SAND: '沙尘',
    WIND: '大风',
  }[code] || '';
}
