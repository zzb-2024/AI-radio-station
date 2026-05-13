/**
 * 定时触发。按配置的 cron 表拉起 AI 规划并广播给客户端。
 */
import cron from 'node-cron';
import { config } from '../config.js';
import { askRadioPlan } from '../services/llm.js';
import { fetchWeather } from '../services/weather.js';
import { resolveQueue } from './queue.js';

/**
 * @param {(msg:object)=>void} broadcast
 * @param {(data:object)=>void} [onPlan] - 可选，拿到 plan 后让 caller 更新队列
 */
export function startScheduler(broadcast, onPlan) {
  if (!config.scheduler.enabled) {
    console.log('[scheduler] disabled');
    return;
  }

  async function trigger(label) {
    try {
      const weather = await fetchWeather();
      const result = await askRadioPlan(`现在是${label}，请规划接下来的音乐`, { weather });
      const queue = await resolveQueue(result.play || []);
      const payload = { type: 'schedule', label, weather, ...result, queue };
      if (onPlan) await onPlan(payload);
      broadcast(payload);
    } catch (e) {
      console.error(`[scheduler] ${label}: ${e.message}`);
    }
  }

  for (const [expr, label] of Object.entries(config.scheduler.triggers)) {
    cron.schedule(expr, () => trigger(label));
  }

  if (config.scheduler.hourlyEnabled) {
    cron.schedule('0 * * * *', () => {
      const hour = new Date().getHours();
      if (config.scheduler.hourlyBlacklist.includes(hour)) return;
      trigger(`${hour}点整点`);
    });
  }

  console.log('[scheduler] started');
}
