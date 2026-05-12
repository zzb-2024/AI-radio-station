import { VISUALS_COLORS, VISUALS_CONFIG } from './visuals.config.js';

const TAU = Math.PI * 2;
const V = VISUALS_CONFIG;
const HAZE = VISUALS_COLORS.haze;
const SILVER = VISUALS_COLORS.silver;
const WHITE = VISUALS_COLORS.white;
const GRAPHITE = VISUALS_COLORS.graphite;
const CHARCOAL = VISUALS_COLORS.charcoal;
const GRID = VISUALS_COLORS.grid;

console.info('[visuals] config version:', V.meta.version);

export const analyserRef = { current: null };

export function startParticles(canvas) {
  const ctx = canvas.getContext('2d');
  let scene = fitCanvas(canvas, ctx);
  const nodes = createBackgroundNodes(V.background.nodeCount);

  function resize() {
    scene = fitCanvas(canvas, ctx);
  }

  resize();
  addEventListener('resize', resize);

  (function tick(frameTime = 0) {
    requestAnimationFrame(tick);

    const t = frameTime * 0.001;
    const { width: W, height: H } = scene;
    const focal = getStageFocalPoint(W, H);

    ctx.clearRect(0, 0, W, H);
    drawBackgroundMist(ctx, W, H, focal);
    updateBackgroundNodes(nodes);
    drawBackgroundNetwork(ctx, W, H, focal, nodes, t);
  })();
}

export function startStage(canvas) {
  const ctx = canvas.getContext('2d');
  let scene = fitCanvas(canvas, ctx, innerWidth, innerHeight);
  let freqData = new Uint8Array(0);
  let timeData = new Uint8Array(0);
  let pulse = 0;

  function resize() {
    scene = fitCanvas(canvas, ctx, innerWidth, innerHeight);
  }

  resize();
  addEventListener('resize', resize);

  (function tick(frameTime = 0) {
    requestAnimationFrame(tick);

    const t = frameTime * 0.001;
    const { width: W, height: H } = scene;
    const frame = readAudioFrame(t);
    const focal = getStageFocalPoint(W, H);
    const orbR = clamp(
      Math.min(W, H) * V.stage.orbRadiusScale,
      V.stage.orbRadiusMin,
      V.stage.orbRadiusMax
    );
    const waveWidth = Math.min(focal.chatWidth * V.stage.waveWidthScale, V.stage.waveWidthMax);
    const floorWidth = Math.min(focal.chatWidth * V.stage.floorWidthScale, W * 0.92);

    pulse = pulse * V.stage.pulseDecay + frame.low * V.stage.pulseGain;

    ctx.clearRect(0, 0, W, H);
    drawFloorGrid(ctx, W, H, focal.cx, focal.cy + orbR * 1.14, floorWidth);
    drawAmbientBeam(ctx, focal.cx, focal.cy, waveWidth, orbR, frame);
    drawWaveSet(ctx, focal.cx, focal.cy, waveWidth, frame, t, 'back');
    drawOrb(ctx, focal.cx, focal.cy, orbR, frame, t, pulse);
    drawWaveSet(ctx, focal.cx, focal.cy, waveWidth, frame, t, 'front');
    drawMeters(ctx, W, focal.cx, focal.cy, orbR, frame);
  })();

  function readAudioFrame(time) {
    const analyser = analyserRef.current;
    if (!analyser) return createIdleFrame(time);

    ensureBuffers(analyser);
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);

    const low = averageFreq(...V.audio.lowRange);
    const mid = averageFreq(...V.audio.midRange);
    const high = averageFreq(...V.audio.highRange);

    return {
      live: true,
      time,
      freqData,
      timeData,
      low,
      mid,
      high,
      all: (low + mid + high) / 3,
    };
  }

  function ensureBuffers(analyser) {
    if (freqData.length !== analyser.frequencyBinCount) {
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    if (timeData.length !== analyser.fftSize) {
      timeData = new Uint8Array(analyser.fftSize);
    }
  }

  function averageFreq(startRatio, endRatio) {
    if (!freqData.length) return 0;
    const start = Math.max(0, Math.floor(startRatio * freqData.length));
    const end = Math.max(start + 1, Math.floor(endRatio * freqData.length));
    let sum = 0;
    for (let i = start; i < end; i++) sum += freqData[i];
    return sum / (end - start) / 255;
  }
}

function createBackgroundNodes(count) {
  return Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * V.background.driftX,
    vy: (Math.random() - 0.5) * V.background.driftY,
    r: V.background.radiusMin + Math.random() * V.background.radiusRange,
  }));
}

function updateBackgroundNodes(nodes) {
  for (const node of nodes) {
    node.x = (node.x + node.vx + 1) % 1;
    node.y = (node.y + node.vy + 1) % 1;
  }
}

function drawBackgroundMist(ctx, W, H, focal) {
  const mist = ctx.createRadialGradient(
    focal.cx,
    H * V.background.mistYRatio,
    H * V.background.mistInnerRadiusScale,
    focal.cx,
    H * V.background.mistYRatio,
    H * V.background.mistOuterRadiusScale
  );
  mist.addColorStop(0, rgba([...HAZE, V.background.mistAlpha], 1));
  mist.addColorStop(V.background.silverStop, rgba([...SILVER, V.background.silverAlpha], 1));
  mist.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, 0, W, H);

  const beam = ctx.createLinearGradient(
    focal.cx - focal.chatWidth * 0.58,
    H * V.background.beamYRatio,
    focal.cx + focal.chatWidth * 0.58,
    H * V.background.beamYRatio
  );
  beam.addColorStop(0, 'rgba(255,255,255,0)');
  beam.addColorStop(0.5, rgba([...SILVER, V.background.beamAlpha], 1));
  beam.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = beam;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(focal.cx - focal.chatWidth * 0.58, H * V.background.beamYRatio);
  ctx.lineTo(focal.cx + focal.chatWidth * 0.58, H * V.background.beamYRatio);
  ctx.stroke();
}

function drawBackgroundNetwork(ctx, W, H, focal, nodes, time) {
  const width = Math.min(focal.chatWidth * V.background.areaWidthScale, W * 0.9);
  const left = focal.cx - width * 0.5;
  const top = H * V.background.areaTopRatio;
  const height = H * V.background.areaHeightRatio;

  ctx.save();
  ctx.translate(0, Math.sin(time * 0.22) * 1.5);

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const ax = left + a.x * width;
    const ay = top + a.y * height;

    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const bx = left + b.x * width;
      const by = top + b.y * height;
      const dist = Math.hypot(ax - bx, ay - by);
      if (dist > V.background.linkDistance) continue;

      const alpha = (1 - dist / V.background.linkDistance) * V.background.linkAlpha;
      ctx.strokeStyle = rgba([...CHARCOAL, alpha], 1);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  for (const node of nodes) {
    const x = left + node.x * width;
    const y = top + node.y * height;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, node.r * V.background.glowRadiusScale);
    glow.addColorStop(0, rgba([...WHITE, 0.54], 1));
    glow.addColorStop(0.55, rgba([...SILVER, 0.10], 1));
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, node.r * V.background.glowRadiusScale, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

function drawAmbientBeam(ctx, cx, cy, width, orbR, frame) {
  const halo = ctx.createRadialGradient(cx, cy, orbR * 0.12, cx, cy, orbR * V.orb.auraScale);
  halo.addColorStop(0, rgba([...WHITE, V.orb.auraAlpha + frame.low * 0.02], 1));
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, orbR * V.orb.auraScale, 0, TAU);
  ctx.fill();

  const beam = ctx.createLinearGradient(cx - width * 0.5, cy, cx + width * 0.5, cy);
  beam.addColorStop(0, 'rgba(255,255,255,0)');
  beam.addColorStop(0.5, rgba([...SILVER, 0.14 + frame.low * 0.08], 1));
  beam.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = beam;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(cx - width * 0.5, cy);
  ctx.lineTo(cx + width * 0.5, cy);
  ctx.stroke();
}

function drawFloorGrid(ctx, W, H, cx, horizonY, width) {
  const topY = horizonY + V.grid.topOffset;
  const bottomY = H + V.grid.bottomOffset;
  const left = Math.max(0, cx - width * 0.5);
  const right = Math.min(W, cx + width * 0.5);
  const scale = clamp(width / 860, 0.8, 1.18);

  ctx.save();
  ctx.strokeStyle = rgba([...GRID, 0.12], 1);
  ctx.lineWidth = V.grid.lineWidth;

  for (let i = -V.grid.columns; i <= V.grid.columns; i++) {
    const x = cx + i * V.grid.columnSpacing * scale;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(cx + i * V.grid.depthSpacing * scale, bottomY);
    ctx.stroke();
  }

  for (let i = 0; i < V.grid.rows; i++) {
    const ratio = i / (V.grid.rows - 1 || 1);
    const y = topY + Math.pow(ratio, V.grid.rowCurvePower) * (bottomY - topY);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  const fill = ctx.createLinearGradient(0, topY, 0, bottomY);
  fill.addColorStop(0, rgba([...WHITE, V.grid.fillAlpha], 1));
  fill.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(left, topY);
  ctx.lineTo(right, topY);
  ctx.lineTo(right, bottomY);
  ctx.lineTo(left, bottomY);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = rgba([...SILVER, 0.14], 1);
  ctx.lineWidth = V.grid.axisWidth;
  ctx.beginPath();
  ctx.moveTo(cx, topY);
  ctx.lineTo(cx, bottomY);
  ctx.stroke();
  ctx.restore();
}

function drawWaveSet(ctx, cx, cy, width, frame, time, layer) {
  const front = layer === 'front';

  ctx.save();
  if (front) ctx.globalCompositeOperation = 'screen';

  for (const line of V.waves.lines) {
    const points = [];
    const startX = cx - width * 0.5;

    for (let i = 0; i <= V.waves.segments; i++) {
      const ratio = i / V.waves.segments;
      const x = startX + ratio * width;
      const nx = (x - cx) / (width * 0.5);
      const envelope = V.waves.envelopeBase + (1 - Math.abs(nx)) * V.waves.envelopePeak;
      const band = frame.live
        ? sampleWave(frame, ratio)
        : idleWave(time, ratio, line.idleAmplitude);
      const carrier = Math.sin(nx * line.frequency + time * line.speed + line.phase)
        * (line.baseAmplitude + frame.mid * line.midGain);
      const detail = Math.sin(nx * line.detailFrequency - time * line.speed * 0.84 + line.phase * 0.8)
        * (line.detailAmplitude + frame.high * line.highGain);
      const audio = band * (line.audioBase + frame.low * line.audioGain);
      const lens = Math.exp(-(nx * nx) / V.waves.lensFalloff)
        * Math.sin(nx * V.waves.lensFrequency - time * V.waves.lensSpeed + line.phase)
        * (front ? line.frontLens : line.backLens);
      const y = cy + line.offsetY + (carrier + detail + audio) * envelope * line.envelopeScale + lens;
      points.push({ x, y });
    }

    const color = colorByName(line.color);
    const alpha = front ? line.frontAlpha : line.backAlpha;
    ctx.strokeStyle = rgba([...color, alpha], 1);
    ctx.lineWidth = front ? line.frontWidth : line.backWidth;
    ctx.shadowColor = rgba([...color, front ? line.frontShadowAlpha : line.backShadowAlpha], 1);
    ctx.shadowBlur = (front ? line.frontShadowBlur : line.backShadowBlur) + frame.low * (front ? 4 : 2);
    strokeSmoothPath(ctx, points);
    ctx.shadowBlur = 0;
  }

  ctx.strokeStyle = rgba([...WHITE, front ? V.waves.centerLineFrontAlpha : V.waves.centerLineBackAlpha], 1);
  ctx.lineWidth = front ? V.waves.centerLineFrontWidth : V.waves.centerLineBackWidth;
  ctx.beginPath();
  ctx.moveTo(cx - width * 0.5, cy);
  ctx.lineTo(cx + width * 0.5, cy);
  ctx.stroke();
  ctx.restore();
}

function drawOrb(ctx, cx, cy, orbR, frame, time, pulse) {
  const r = orbR * (1 + frame.low * V.orb.pulseScale);

  const shell = ctx.createRadialGradient(cx - r * 0.24, cy - r * 0.28, r * 0.12, cx, cy, r);
  shell.addColorStop(0, rgba([...WHITE, V.orb.shellInnerAlpha], 1));
  shell.addColorStop(0.35, rgba([...SILVER, V.orb.shellMidAlpha], 1));
  shell.addColorStop(1, rgba([...WHITE, V.orb.shellOuterAlpha], 1));
  ctx.fillStyle = shell;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = rgba([...SILVER, V.orb.shellStrokeAlpha + frame.low * 0.06], 1);
  ctx.lineWidth = V.orb.shellStrokeWidth;
  ctx.shadowColor = rgba([...WHITE, V.orb.shellShadowAlpha], 1);
  ctx.shadowBlur = V.orb.shellShadowBlur + frame.low * 6;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = rgba([...WHITE, V.orb.highlightAlpha + frame.high * 0.08], 1);
  ctx.lineWidth = V.orb.highlightWidth;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.94, Math.PI * 1.06, Math.PI * 1.42);
  ctx.stroke();

  ctx.strokeStyle = rgba([...SILVER, V.orb.contourAlpha], 1);
  ctx.lineWidth = V.orb.contourWidth;
  for (let i = 0; i < V.orb.contourCount; i++) {
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy + (i - 0.5) * r * 0.05,
      r * (0.44 + i * 0.12),
      r * (0.10 + i * 0.04),
      time * 0.12 + i * 0.34,
      0,
      TAU
    );
    ctx.stroke();
  }

  const coreR = r * V.orb.coreScale + pulse * 8;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  core.addColorStop(0, rgba([...WHITE, V.orb.coreAlpha + frame.low * 0.10], 1));
  core.addColorStop(0.55, rgba([...SILVER, 0.12 + frame.mid * 0.06], 1));
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, TAU);
  ctx.fill();

  drawOrbFlare(ctx, cx, cy, r, frame);
}

function drawOrbFlare(ctx, cx, cy, r, frame) {
  const horizontal = ctx.createLinearGradient(cx - r * V.orb.flareHScale, cy, cx + r * V.orb.flareHScale, cy);
  horizontal.addColorStop(0, 'rgba(255,255,255,0)');
  horizontal.addColorStop(0.5, rgba([...WHITE, V.orb.flareAlpha + frame.low * 0.06], 1));
  horizontal.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = horizontal;
  ctx.lineWidth = V.orb.flareWidth;
  ctx.beginPath();
  ctx.moveTo(cx - r * V.orb.flareHScale, cy);
  ctx.lineTo(cx + r * V.orb.flareHScale, cy);
  ctx.stroke();

  const vertical = ctx.createLinearGradient(cx, cy - r * V.orb.flareVScale, cx, cy + r * V.orb.flareVScale);
  vertical.addColorStop(0, 'rgba(255,255,255,0)');
  vertical.addColorStop(0.5, rgba([...WHITE, V.orb.flareAlpha * 0.66 + frame.low * 0.04], 1));
  vertical.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = vertical;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * V.orb.flareVScale);
  ctx.lineTo(cx, cy + r * V.orb.flareVScale);
  ctx.stroke();
}

function drawMeters(ctx, W, cx, cy, orbR, frame) {
  const anchors = [
    {
      x: Math.min(cx + orbR * V.meters.primaryXFactor, W - 46),
      y: cy + orbR * V.meters.primaryYOffsetFactor,
      descending: false,
    },
    {
      x: Math.min(cx + orbR * V.meters.secondaryXFactor, W - 56),
      y: cy + orbR * V.meters.secondaryYOffsetFactor,
      descending: true,
    },
  ];

  for (const anchor of anchors) {
    drawMeterCluster(ctx, anchor.x, anchor.y, frame, anchor.descending);
  }
}

function drawMeterCluster(ctx, x, y, frame, descending) {
  ctx.save();
  for (let i = 0; i < V.meters.bars; i++) {
    const ratio = i / (V.meters.bars - 1 || 1);
    const sample = frame.live
      ? sampleFreq(frame, V.meters.sampleStart + ratio * V.meters.sampleSpan, V.meters.sampleSpread)
      : V.meters.idleBase + Math.sin(frame.time * V.meters.idleSpeed + ratio * V.meters.idleFrequency) * V.meters.idleAmplitude;
    const h = V.meters.heightBase + Math.pow(sample, 1.3) * V.meters.heightScale;
    const px = x + i * V.meters.spacing;
    const py = descending ? y + ratio * V.meters.stepY : y - ratio * V.meters.stepY;

    ctx.strokeStyle = rgba([...SILVER, V.meters.opacity * 0.6 + sample * V.meters.opacity], 1);
    ctx.lineWidth = V.meters.lineWidth;
    ctx.beginPath();
    ctx.moveTo(px, py - h * 0.5);
    ctx.lineTo(px, py + h * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function createIdleFrame(time) {
  const low = V.idle.lowBase + (Math.sin(time * V.idle.lowSpeed) + 1) * V.idle.lowWave;
  const mid = V.idle.midBase + (Math.sin(time * V.idle.midSpeed + V.idle.midPhase) + 1) * V.idle.midWave;
  const high = V.idle.highBase + (Math.sin(time * V.idle.highSpeed + V.idle.highPhase) + 1) * V.idle.highWave;

  return {
    live: false,
    time,
    freqData: null,
    timeData: null,
    low,
    mid,
    high,
    all: (low + mid + high) / 3,
  };
}

function sampleFreq(frame, ratio, spread = 2) {
  if (!frame.freqData?.length) {
    return frame.all + Math.sin(frame.time * 1.5 + ratio * 10) * 0.02;
  }

  const center = Math.floor(clamp(ratio, 0, 1) * (frame.freqData.length - 1));
  let sum = 0;
  let count = 0;

  for (let i = -spread; i <= spread; i++) {
    const index = clamp(center + i, 0, frame.freqData.length - 1);
    sum += frame.freqData[index];
    count++;
  }

  return sum / count / 255;
}

function sampleWave(frame, ratio) {
  if (!frame.timeData?.length) {
    return idleWave(frame.time, ratio, 1);
  }

  const index = Math.floor(clamp(ratio, 0, 1) * (frame.timeData.length - 1));
  return (frame.timeData[index] - 128) / 128;
}

function idleWave(time, ratio, scale) {
  return (
    Math.sin(time * V.idle.waveformA + ratio * V.idle.waveformAFrequency) * V.idle.waveformAAmplitude +
    Math.sin(time * V.idle.waveformB + ratio * V.idle.waveformBFrequency) * V.idle.waveformBAmplitude
  ) * scale;
}

function strokeSmoothPath(ctx, points) {
  if (points.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) * 0.5;
    const yc = (points[i].y + points[i + 1].y) * 0.5;
    ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
  }

  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function fitCanvas(canvas, ctx, fallbackWidth = innerWidth, fallbackHeight = innerHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth || canvas.offsetWidth || fallbackWidth;
  const height = canvas.clientHeight || canvas.offsetHeight || fallbackHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function getStageFocalPoint(width, height) {
  const chatWidth = document.getElementById('chat-col')?.getBoundingClientRect().width || width;
  return {
    cx: clamp(chatWidth * V.stage.centerXRatio, V.stage.centerXMin, width - V.stage.centerXRightPadding),
    cy: height * V.stage.centerYRatio,
    chatWidth,
  };
}

function colorByName(name) {
  switch (name) {
    case 'white':
      return WHITE;
    case 'silver':
      return SILVER;
    case 'graphite':
      return GRAPHITE;
    case 'charcoal':
      return CHARCOAL;
    default:
      return SILVER;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rgba([r, g, b, a], alphaScale = 1) {
  return `rgba(${r}, ${g}, ${b}, ${a * alphaScale})`;
}

let audioContext = null;

export function initWebAudio(audioEl) {
  if (audioContext) {
    audioContext.resume();
    return;
  }

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaElementSource(audioEl);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = V.audio.analyser.fftSize;
    analyser.minDecibels = V.audio.analyser.minDecibels;
    analyser.maxDecibels = V.audio.analyser.maxDecibels;
    analyser.smoothingTimeConstant = V.audio.analyser.smoothingTimeConstant;
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    analyserRef.current = analyser;
  } catch (error) {
    console.warn('[audio]', error.message);
  }
}

export function startOrb() {}
export function startWaveform() {}
