/**
 * OpenWeather 天气查询。
 */
import { config } from '../config.js';
import { requestJson } from '../lib/http.js';

/**
 * 拿当前城市的简短天气描述。未配置 key 或失败时返回 null。
 */
export async function fetchWeather(city = config.weather.city) {
  if (!config.weather.apiKey) return null;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${config.weather.apiKey}&lang=zh_cn&units=metric`;
  try {
    const { json } = await requestJson({ url, timeoutMs: config.weather.timeoutMs });
    return `${json.weather[0].description}，${Math.round(json.main.temp)}°C`;
  } catch {
    return null;
  }
}
