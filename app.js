const FRAME_COUNT = 484;
const SCROLL_DISTANCE = 8000;
const FRAME_PATH = './public/frames/frame-';
const FRAME_EXTENSION = '.jpg';

const NETWORK_CONCURRENCY = 8;
const NETWORK_RETRIES = 2;
const INITIAL_DECODE_COUNT = 36;
const SMOOTHING_PER_SECOND = 18;
const DPR_CAP = 2;
const PRELOAD_RADIUS = 16;
const LOOK_AHEAD = 8;
const MAX_DECODED_FRAMES = 48;
const MAX_CONCURRENT_DECODES = 4;

const canvas = document.querySelector('#film-canvas');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
const debugPanel = document.querySelector('#debug-panel');
const loader = document.querySelector('#film-loader');
const loaderProgress = document.querySelector('[data-loader-progress]');
const loaderLine = document.querySelector('[data-loader-line]');
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(window.location.search);
const debugEnabled = params.get('debug') === '1';

window.__ready = false;
window.__visualProgress = 0;

const cache = new Map();
const decodePending = new Map();
const decodeQueue = [];
const networkLoaded = new Set();
let activeDecodes = 0;
let loadedFrames = 0;
let loaderState = 'LOADING';
let isReady = false;
let playhead = 0;
let targetFrame = 0;
let renderedFrame = -1;
let lastScrollY = 0;
let scrollDirection = 1;
let rafId = 0;
let lastRafTime = 0;
let measuredFps = 0;
let fpsSampleStart = performance.now();
let fpsSampleFrames = 0;
let canvasWidth = 0;
let canvasHeight = 0;

const blockedScrollKeys = new Set([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

function blockInteraction(event) {
  if (event.type !== 'keydown' || blockedScrollKeys.has(event.key)) event.preventDefault();
}

function frameUrl(index) {
  return `${FRAME_PATH}${String(index + 1).padStart(4, '0')}${FRAME_EXTENSION}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function maxScroll() {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

function updateLoader() {
  const percent = Math.round((loadedFrames / FRAME_COUNT) * 100);
  loaderProgress.textContent = `${percent}%`;
  loaderLine.style.width = `${percent}%`;
}

async function downloadFrame(index) {
  let lastError;
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt += 1) {
    try {
      const response = await fetch(frameUrl(index), { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Frame ${index + 1} unavailable (${response.status})`);
      await response.blob();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < NETWORK_RETRIES) {
        await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function preloadNetwork() {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < FRAME_COUNT) {
      const index = nextIndex;
      nextIndex += 1;
      await downloadFrame(index);
      networkLoaded.add(index);
      loadedFrames = networkLoaded.size;
      updateLoader();
    }
  }
  await Promise.all(Array.from({ length: NETWORK_CONCURRENCY }, worker));
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  canvasWidth = Math.max(1, Math.round(window.innerWidth * dpr));
  canvasHeight = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }
  if (renderedFrame >= 0) drawBestAvailableFrame(Math.round(playhead));
}

async function decodeFrame(index) {
  if ('createImageBitmap' in window) {
    const response = await fetch(frameUrl(index), { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Frame ${index + 1} unavailable`);
    return createImageBitmap(await response.blob());
  }

  return new Promise((resolve, reject) => {
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

function requestDecode(index, priority = false) {
  if (index < 0 || index >= FRAME_COUNT || cache.has(index)) return Promise.resolve();
  if (decodePending.has(index)) return decodePending.get(index).promise;

  let resolveJob;
  let rejectJob;
  const promise = new Promise((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });
  decodePending.set(index, { promise, resolve: resolveJob, reject: rejectJob });
  if (priority) decodeQueue.unshift(index);
  else decodeQueue.push(index);
  pumpDecodeQueue();
  return promise;
}

function pumpDecodeQueue() {
  while (activeDecodes < MAX_CONCURRENT_DECODES && decodeQueue.length) {
    const index = decodeQueue.shift();
    const pending = decodePending.get(index);
    if (!pending || cache.has(index)) continue;
    activeDecodes += 1;
    decodeFrame(index)
      .then((asset) => {
        cache.set(index, { asset, lastUsed: performance.now() });
        trimCache();
        pending.resolve();
        if (isReady) requestTick();
      })
      .catch((error) => pending.reject(error))
      .finally(() => {
        decodePending.delete(index);
        activeDecodes -= 1;
        pumpDecodeQueue();
      });
  }
}

function queueAround(frame) {
  const center = clamp(Math.round(frame), 0, FRAME_COUNT - 1);
  requestDecode(center, true);
  for (let offset = 1; offset <= PRELOAD_RADIUS; offset += 1) {
    requestDecode(center + offset * scrollDirection, true);
    requestDecode(center - offset * scrollDirection);
  }
  for (let offset = PRELOAD_RADIUS + 1; offset <= PRELOAD_RADIUS + LOOK_AHEAD; offset += 1) {
    requestDecode(center + offset * scrollDirection, true);
  }
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
  const scale = Math.max(canvasWidth / asset.width, canvasHeight / asset.height);
  const drawWidth = asset.width * scale;
  const drawHeight = asset.height * scale;
  context.drawImage(asset, (canvasWidth - drawWidth) / 2, (canvasHeight - drawHeight) / 2, drawWidth, drawHeight);
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
  window.__visualProgress = selectedIndex / (FRAME_COUNT - 1);
  window.dispatchEvent(new Event('filmprogress'));
  return true;
}

function updateTargetFromScroll() {
  if (!isReady) return;
  const scrollY = window.scrollY;
  scrollDirection = scrollY === lastScrollY ? scrollDirection : Math.sign(scrollY - lastScrollY);
  lastScrollY = scrollY;
  targetFrame = clamp(scrollY / maxScroll(), 0, 1) * (FRAME_COUNT - 1);
  queueAround(targetFrame);
  requestTick();
}

function updateDebug() {
  if (!debugEnabled) return;
  const narrativeDebug = window.__narrativeDebug;
  debugPanel.textContent = [
    `NETWORK_LOADED  ${loadedFrames} / ${FRAME_COUNT}`,
    `NETWORK_PERCENT ${Math.round((loadedFrames / FRAME_COUNT) * 100)}%`,
    `LOADER_STATE    ${loaderState}`,
    `TARGET_FRAME    ${targetFrame.toFixed(2)}`,
    `RENDERED_FRAME  ${renderedFrame + 1}`,
    `BITMAP_CACHE    ${cache.size} / ${MAX_DECODED_FRAMES}`,
    `render FPS      ${measuredFps.toFixed(1)}`,
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
  if (isReady && !rafId) rafId = requestAnimationFrame(tick);
}

function tick(now) {
  rafId = 0;
  const elapsed = lastRafTime ? Math.min((now - lastRafTime) / 1000, 0.1) : 1 / 60;
  lastRafTime = now;
  const alpha = reducedMotionQuery.matches ? 1 : 1 - Math.exp(-SMOOTHING_PER_SECOND * elapsed);
  playhead += (targetFrame - playhead) * alpha;
  if (Math.abs(targetFrame - playhead) < 0.01) playhead = targetFrame;

  drawBestAvailableFrame(Math.round(playhead));
  queueAround(playhead);
  fpsSampleFrames += 1;
  if (now - fpsSampleStart >= 500) {
    measuredFps = (fpsSampleFrames * 1000) / (now - fpsSampleStart);
    fpsSampleFrames = 0;
    fpsSampleStart = now;
  }
  updateDebug();
  if (Math.abs(targetFrame - playhead) >= 0.01 || !cache.has(Math.round(playhead)) || debugEnabled) requestTick();
}

function setupScrollSpace() {
  document.body.style.height = `${window.innerHeight + SCROLL_DISTANCE}px`;
}

function applyJumpParameter() {
  const requested = Number(params.get('jump'));
  if (!Number.isFinite(requested)) return;
  window.scrollTo({ top: clamp(requested, 0, SCROLL_DISTANCE), behavior: 'auto' });
  updateTargetFromScroll();
}

async function finishLoading() {
  resizeCanvas();
  await Promise.all(Array.from({ length: INITIAL_DECODE_COUNT }, (_, index) => requestDecode(index, true)));
  playhead = 0;
  targetFrame = 0;
  if (!drawBestAvailableFrame(0)) throw new Error('Initial frame could not be rendered');

  window.scrollTo({ top: 0, behavior: 'auto' });
  setupScrollSpace();
  lastScrollY = 0;
  loaderState = 'READY';
  isReady = true;
  canvas.classList.add('is-ready');
  window.__ready = true;
  window.dispatchEvent(new Event('scrollfilmready'));
  window.dispatchEvent(new Event('filmprogress'));
  document.body.classList.remove('film-is-loading');
  loader.classList.add('is-hidden');
  window.removeEventListener('wheel', blockInteraction, { capture: true });
  window.removeEventListener('touchmove', blockInteraction, { capture: true });
  window.removeEventListener('keydown', blockInteraction, { capture: true });
  applyJumpParameter();
  updateDebug();
}

async function initialize() {
  window.addEventListener('wheel', blockInteraction, { passive: false, capture: true });
  window.addEventListener('touchmove', blockInteraction, { passive: false, capture: true });
  window.addEventListener('keydown', blockInteraction, { capture: true });
  if (debugEnabled) debugPanel.hidden = false;
  window.addEventListener('scroll', updateTargetFromScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (!isReady) return resizeCanvas();
    setupScrollSpace();
    resizeCanvas();
    updateTargetFromScroll();
  });
  reducedMotionQuery.addEventListener?.('change', requestTick);

  try {
    await preloadNetwork();
    await finishLoading();
  } catch (error) {
    loaderProgress.textContent = 'RETRY';
    console.error('Unable to preload the MEMORY IS AN IMPERFECT IMAGE frame sequence.', error);
  }
}

initialize();
