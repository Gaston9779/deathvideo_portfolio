# MEMORY / LIE

An interactive scroll-film about memory and AI-generated reconstruction.

Scroll forward to move through reconstruction and the loss of authenticity. Scroll backward to return toward the original memory.

## Technology

- HTML, CSS, and JavaScript
- Fullscreen Canvas rendering
- Native-rate JPEG frame sequence
- Scroll-driven playhead with `requestAnimationFrame` smoothing
- Sliding preload cache using `ImageBitmap` when available

## Run locally

```bash
npm start
```

The command starts a small local HTTP server at `http://127.0.0.1:4173`. A web server is required because the film loads its frame sequence with browser requests.

## Deployment

This is a static site with no build step. Netlify publishes the repository root, and caches `/public/frames/*` for one year. The 484 frame JPEGs are runtime assets and are intentionally versioned.
