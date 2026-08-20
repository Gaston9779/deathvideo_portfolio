const FRAME_COUNT = 484;
const SCROLL_DISTANCE = 8000;
const FRAME_PATH = './public/frames/frame-';
const FRAME_EXTENSION = '.jpg';

const SMOOTHING_PER_SECOND = 18;
const DPR_CAP = 2;
const PRELOAD_RADIUS = 12;
const LOOK_AHEAD = 8;
const MAX_DECODED_FRAMES = 36;
const MAX_CONCURRENT_LOADS = 4;

const canvas = document.querySelector('#film-canvas');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
const debugPanel = document.querySelector('#debug-panel');
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(window.location.search);
const debugEnabled = params.get('debug') === '1';

window.__ready = false;

const cache = new Map();
const pending = new Set();
const queue = [];
let activeLoads = 0;
let playhead = 0;
let targetFrame = 0;
let renderedFrame = -1;
let lastValidFrame = -1;
let lastScrollY = window.scrollY;
let scrollDirection = 1;
let rafId = 0;
let lastRafTime = 0;
let measuredFps = 0;
let fpsSampleStart = performance.now();
let fpsSampleFrames = 0;
let hasDrawnFirstFrame = false;
let canvasWidth = 0;
let canvasHeight = 0;
let devicePixelRatio = 1;
let idlePreloadCursor = 13;

function frameUrl(index) {
  return `${FRAME_PATH}${String(index + 1).padStart(4, '0')}${FRAME_EXTENSION}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function maxScroll() {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

function updateTargetFromScroll() {
  const scrollY = window.scrollY;
  scrollDirection = scrollY === lastScrollY ? scrollDirection : Math.sign(scrollY - lastScrollY);
  lastScrollY = scrollY;
  const progress = clamp(scrollY / maxScroll(), 0, 1);
  targetFrame = progress * (FRAME_COUNT - 1);
  queueAround(targetFrame);
  requestTick();
}

function resizeCanvas() {
  devicePixelRatio = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  canvasWidth = Math.max(1, Math.round(window.innerWidth * devicePixelRatio));
  canvasHeight = Math.max(1, Math.round(window.innerHeight * devicePixelRatio));
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }
  drawBestAvailableFrame(Math.round(playhead));
  requestTick();
}

function enqueue(index, priority = false) {
  if (index < 0 || index >= FRAME_COUNT || cache.has(index) || pending.has(index)) return;
  pending.add(index);
  if (priority) queue.unshift(index);
  else queue.push(index);
  pumpQueue();
}

function queueAround(frame) {
  const center = clamp(Math.round(frame), 0, FRAME_COUNT - 1);
  enqueue(center, true);
  for (let offset = 1; offset <= PRELOAD_RADIUS; offset += 1) {
    enqueue(center + offset * scrollDirection, true);
    enqueue(center - offset * scrollDirection);
  }
  for (let offset = PRELOAD_RADIUS + 1; offset <= PRELOAD_RADIUS + LOOK_AHEAD; offset += 1) {
    enqueue(center + offset * scrollDirection, true);
  }
}

function pumpQueue() {
  while (activeLoads < MAX_CONCURRENT_LOADS && queue.length > 0) {
    const index = queue.shift();
    if (!pending.has(index) || cache.has(index)) continue;
    activeLoads += 1;
    loadFrame(index)
      .catch(() => {
        // A missing frame must never clear the last valid canvas image.
      })
      .finally(() => {
        pending.delete(index);
        activeLoads -= 1;
        pumpQueue();
      });
  }
}

async function loadFrame(index) {
  let asset;
  if ('createImageBitmap' in window) {
    const response = await fetch(frameUrl(index), { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Frame ${index + 1} unavailable`);
    asset = await createImageBitmap(await response.blob());
  } else {
    asset = await new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = async () => {
        try {
          if (image.decode) await image.decode();
          resolve(image);
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = reject;
      image.src = frameUrl(index);
    });
  }

  cache.set(index, { asset, lastUsed: performance.now() });
  trimCache();
  if (index === 0 || Math.abs(index - Math.round(playhead)) <= 1) requestTick();
}

function trimCache() {
  if (cache.size <= MAX_DECODED_FRAMES) return;
  const protectedStart = clamp(Math.round(playhead) - PRELOAD_RADIUS, 0, FRAME_COUNT - 1);
  const protectedEnd = clamp(Math.round(playhead) + PRELOAD_RADIUS, 0, FRAME_COUNT - 1);
  const removable = [...cache.entries()]
    .filter(([index]) => index < protectedStart || index > protectedEnd)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

  while (cache.size > MAX_DECODED_FRAMES && removable.length) {
    const [index, entry] = removable.shift();
    cache.delete(index);
    if (typeof ImageBitmap !== 'undefined' && entry.asset instanceof ImageBitmap) entry.asset.close();
  }
}

function drawCover(asset) {
  const sourceWidth = asset.width;
  const sourceHeight = asset.height;
  const scale = Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (canvasWidth - drawWidth) / 2;
  const drawY = (canvasHeight - drawHeight) / 2;
  context.drawImage(asset, drawX, drawY, drawWidth, drawHeight);
}

function drawBestAvailableFrame(preferredIndex) {
  const preferred = clamp(preferredIndex, 0, FRAME_COUNT - 1);
  let selectedIndex = cache.has(preferred) ? preferred : -1;
  if (selectedIndex === -1) {
    for (let offset = 1; offset <= PRELOAD_RADIUS + LOOK_AHEAD; offset += 1) {
      const before = preferred - offset;
      const after = preferred + offset;
      if (cache.has(before)) {
        selectedIndex = before;
        break;
      }
      if (cache.has(after)) {
        selectedIndex = after;
        break;
      }
    }
  }
  if (selectedIndex === -1) return false;

  const entry = cache.get(selectedIndex);
  entry.lastUsed = performance.now();
  drawCover(entry.asset);
  renderedFrame = selectedIndex;
  lastValidFrame = selectedIndex;
  return true;
}

function updateDebug() {
  if (!debugEnabled) return;
  const progress = clamp(window.scrollY / maxScroll(), 0, 1);
  const narrativeDebug = window.__narrativeDebug;
  debugPanel.textContent = [
    `scrollY       ${Math.round(window.scrollY)}`,
    `progress      ${progress.toFixed(4)}`,
    `targetFrame   ${targetFrame.toFixed(2)}`,
    `renderedFrame ${renderedFrame + 1}`,
    `render FPS    ${measuredFps.toFixed(1)}`,
    `cache size    ${cache.size}`,
    ...(narrativeDebug
      ? [
          `CURRENT_BEAT  ${narrativeDebug.currentBeat}`,
          `CURRENT_COPY  ${narrativeDebug.currentCopy}`,
          `RESTORATION_PERCENT ${narrativeDebug.restorationPercent}`,
        ]
      : []),
  ].join('\n');
}

function requestTick() {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick(now) {
  rafId = 0;
  const elapsed = lastRafTime ? Math.min((now - lastRafTime) / 1000, 0.1) : 1 / 60;
  lastRafTime = now;
  const target = targetFrame;
  const motionReduced = reducedMotionQuery.matches;
  const alpha = motionReduced ? 1 : 1 - Math.exp(-SMOOTHING_PER_SECOND * elapsed);
  playhead += (target - playhead) * alpha;
  if (Math.abs(target - playhead) < 0.01) playhead = target;

  const desiredIndex = clamp(Math.round(playhead), 0, FRAME_COUNT - 1);
  drawBestAvailableFrame(desiredIndex);
  queueAround(playhead);

  fpsSampleFrames += 1;
  if (now - fpsSampleStart >= 500) {
    measuredFps = (fpsSampleFrames * 1000) / (now - fpsSampleStart);
    fpsSampleFrames = 0;
    fpsSampleStart = now;
  }
  updateDebug();

  if (!hasDrawnFirstFrame && lastValidFrame === 0) {
    hasDrawnFirstFrame = true;
    canvas.classList.add('is-ready');
    window.__ready = true;
    window.dispatchEvent(new Event('scrollfilmready'));
    applyJumpParameter();
  }

  if (Math.abs(targetFrame - playhead) >= 0.01 || !cache.has(desiredIndex) || debugEnabled) {
    requestTick();
  }
}

function applyJumpParameter() {
  const requested = Number(params.get('jump'));
  if (!Number.isFinite(requested)) return;
  window.scrollTo({ top: clamp(requested, 0, SCROLL_DISTANCE), behavior: 'auto' });
  updateTargetFromScroll();
}

function setupScrollSpace() {
  document.body.style.height = `${window.innerHeight + SCROLL_DISTANCE}px`;
}

function scheduleIdlePreload() {
  if (idlePreloadCursor >= FRAME_COUNT) return;
  const schedule = window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (callback) => window.setTimeout(() => callback({ timeRemaining: () => 0 }), 750);

  schedule((deadline) => {
    let queued = 0;
    while (
      idlePreloadCursor < FRAME_COUNT &&
      queued < 2 &&
      (queued === 0 || deadline.timeRemaining() > 3)
    ) {
      enqueue(idlePreloadCursor);
      idlePreloadCursor += 1;
      queued += 1;
    }
    scheduleIdlePreload();
  });
}

function initialize() {
  setupScrollSpace();
  resizeCanvas();
  if (debugEnabled) debugPanel.hidden = false;
  window.addEventListener('scroll', updateTargetFromScroll, { passive: true });
  window.addEventListener('resize', () => {
    setupScrollSpace();
    resizeCanvas();
    updateTargetFromScroll();
  });
  reducedMotionQuery.addEventListener?.('change', requestTick);
  enqueue(0, true);
  for (let index = 1; index <= 12; index += 1) enqueue(index);
  scheduleIdlePreload();
  updateTargetFromScroll();
}

initialize();
