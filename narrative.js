const narrative = document.querySelector('#narrative');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const elements = {
  opening: narrative.querySelector('[data-copy="opening"]'),
  scrollCue: narrative.querySelector('[data-copy="scroll-cue"]'),
  restoration: narrative.querySelector('[data-copy="restoration"]'),
  restorationLabel: narrative.querySelector('[data-restoration-label]'),
  restorationValue: narrative.querySelector('[data-restoration-value]'),
  restorationLine: narrative.querySelector('[data-restoration-line]'),
  archive: narrative.querySelector('[data-copy="archive"]'),
  archiveDetail: narrative.querySelector('[data-copy="archive-detail"]'),
  portrait: narrative.querySelector('[data-copy="portrait"]'),
  question: narrative.querySelector('[data-copy="question"]'),
  grave: narrative.querySelector('[data-copy="grave"]'),
  graveDetail: narrative.querySelector('[data-copy="grave-detail"]'),
  replaced: narrative.querySelector('[data-copy="replaced"]'),
  final: narrative.querySelector('[data-copy="final"]'),
  finalLine1: narrative.querySelector('[data-copy="final-line-1"]'),
  finalLine2: narrative.querySelector('[data-copy="final-line-2"]'),
  finalLine3: narrative.querySelector('[data-copy="final-line-3"]'),
  finalDetail: narrative.querySelector('[data-copy="final-detail"]'),
  warmWash: document.querySelector('.film-wash--warm'),
  coldWash: document.querySelector('.film-wash--cold'),
};

let animationFrame = 0;
let filmIsReady = window.__ready === true;

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function ease(value) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function range(progress, start, end) {
  return ease((progress - start) / (end - start));
}

function visibility(progress, enterStart, enterEnd, leaveStart, leaveEnd) {
  return range(progress, enterStart, enterEnd) * (1 - range(progress, leaveStart, leaveEnd));
}

function setCopy(element, opacity, parallax = 0) {
  const safeOpacity = clamp(opacity);
  const translateY = reducedMotion.matches ? 0 : (1 - safeOpacity) * 13 + parallax;
  element.style.opacity = safeOpacity.toFixed(3);
  element.style.transform = `translate3d(0, ${translateY.toFixed(2)}px, 0)`;
}

function getProgress() {
  return clamp(window.__visualProgress || 0);
}

function beatFor(progress) {
  if (progress < 0.13) return ['OPENING', 'THIS IS ALL I HAVE LEFT.'];
  if (progress < 0.38) return ['ARCHIVE', 'I ASKED IT TO REMEMBER YOU.'];
  if (progress < 0.62) return ['PERFECTION', progress < 0.53 ? 'NOW YOU LOOK PERFECT.' : 'BUT WHO ARE YOU?'];
  if (progress < 0.82) return ['REVEAL', progress < 0.72 ? '—' : 'OR REPLACED?'];
  return ['CEMETERY', progress < 0.89 ? '—' : 'WHEN DOES A MEMORY BECOME A LIE?'];
}

function restorationState(progress) {
  if (progress < 0.08) return '0%';
  if (progress <= 0.55) return `${Math.round(range(progress, 0.08, 0.55) * 100)}%`;
  if (progress < 0.61) return '100%';
  return '—';
}

function renderNarrative() {
  animationFrame = 0;
  const progress = getProgress();
  const parallax = (progress - 0.5) * -18;

  const openingOpacity = filmIsReady ? 1 - range(progress, 0.105, 0.15) : 0;
  setCopy(elements.opening, openingOpacity, parallax * 0.25);
  setCopy(elements.scrollCue, filmIsReady ? 1 - range(progress, 0.008, 0.045) : 0);

  const restorationVisible = visibility(progress, 0.075, 0.1, 0.575, 0.62);
  const restorationPercent = clamp((progress - 0.08) / 0.47) * 100;
  setCopy(elements.restoration, restorationVisible);
  elements.restorationLabel.textContent = progress < 0.55 ? 'RESTORING MEMORY' : 'RESTORATION COMPLETE';
  elements.restorationValue.textContent = `${Math.round(restorationPercent)}%`;
  elements.restorationLine.style.width = `${restorationPercent.toFixed(1)}%`;

  setCopy(elements.archive, visibility(progress, 0.18, 0.215, 0.335, 0.38), parallax * 0.45);
  setCopy(elements.archiveDetail, visibility(progress, 0.265, 0.29, 0.34, 0.375));
  setCopy(elements.portrait, visibility(progress, 0.39, 0.425, 0.5, 0.535), parallax * 0.35);
  setCopy(elements.question, visibility(progress, 0.535, 0.565, 0.615, 0.65), parallax * 0.2);

  setCopy(elements.grave, visibility(progress, 0.7, 0.725, 0.81, 0.84), parallax * 0.1);
  setCopy(elements.graveDetail, visibility(progress, 0.7, 0.725, 0.75, 0.77));
  setCopy(elements.replaced, visibility(progress, 0.765, 0.79, 0.81, 0.835));

  setCopy(elements.final, range(progress, 0.885, 0.91));
  setCopy(elements.finalLine1, range(progress, 0.885, 0.915));
  setCopy(elements.finalLine2, range(progress, 0.915, 0.947));
  setCopy(elements.finalLine3, range(progress, 0.947, 0.978));
  setCopy(elements.finalDetail, range(progress, 0.978, 1));

  const warm = visibility(progress, 0, 0.02, 0.11, 0.2) * 0.72;
  const clinical = visibility(progress, 0.31, 0.4, 0.56, 0.67) * 0.58;
  const cemetery = range(progress, 0.68, 0.9) * 0.32;
  elements.warmWash.style.opacity = warm.toFixed(3);
  elements.coldWash.style.opacity = (clinical + cemetery).toFixed(3);

  const [currentBeat, currentCopy] = beatFor(progress);
  window.__narrativeDebug = {
    currentBeat,
    currentCopy,
    restorationPercent: restorationState(progress),
  };
}

function requestRender() {
  if (!animationFrame) animationFrame = requestAnimationFrame(renderNarrative);
}

window.addEventListener('scroll', requestRender, { passive: true });
window.addEventListener('filmprogress', requestRender);
window.addEventListener('resize', requestRender);
window.addEventListener('scrollfilmready', () => {
  filmIsReady = true;
  requestRender();
});
reducedMotion.addEventListener?.('change', requestRender);
requestRender();
