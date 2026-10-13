/**
 * Telling the person how the desktop is being drawn.
 *
 * The desktop draws with WebGL2. Two things can stand in its way, and both
 * used to look like a splash that never ends:
 *
 * - The graphics card cannot be used (a driver updated without a reboot, a
 *   blocklisted GPU, a browser with acceleration off). The desktop app then
 *   relaunches itself with software rendering (electron/gpu-fallback.ts) and
 *   says why in the page URL (`?render=software&why=...`); a browser may fall
 *   back to a software renderer on its own. Either way everything works, more
 *   slowly, and the person should know.
 * - No WebGL2 at all. Nothing can be drawn, and the splash says so.
 */

import { require as precondition } from '../src/core/contracts.js';

export interface RendererReport {
  webgl2: boolean;
  /** The renderer string, when the browser reveals it. */
  renderer?: string;
  /** True for a software rasterizer (SwiftShader, llvmpipe and the like). */
  software: boolean;
}

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software rasterizer|basic render driver|subzero/i;

/** Probe WebGL2 on a scratch canvas, then release the context. */
export function probeRenderer(): RendererReport {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = document.createElement('canvas').getContext('webgl2');
  } catch {
    gl = null;
  }
  if (!gl) return { webgl2: false, software: false };
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) ?? '');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { webgl2: true, renderer, software: SOFTWARE_RENDERERS.test(renderer) };
}

/** What the desktop app said about rendering, from the page URL. */
export function launchRendering(): { software: boolean; why?: string } {
  const params = new URLSearchParams(location.search);
  const why = params.get('why')?.trim();
  return { software: params.get('render') === 'software', ...(why ? { why: why.slice(0, 300) } : {}) };
}

/**
 * A dismissible notice that the desktop is drawn in software. `why` is the
 * desktop app's reason, when it relaunched itself into software rendering.
 */
export function showSoftwareNotice(why?: string): void {
  if (document.getElementById('render-notice')) return;
  const card = document.createElement('div');
  card.id = 'render-notice';
  card.setAttribute('role', 'status');
  const title = document.createElement('div');
  title.className = 'render-notice-title';
  title.textContent = 'Drawing in software';
  const body = document.createElement('p');
  body.textContent = why
    ? `The graphics card could not be used (${why}), so Abject switched to software rendering. Everything works, more slowly. `
      + 'If you just updated your graphics driver, restart the computer to bring acceleration back.'
    : 'No graphics acceleration is available here, so the desktop is drawn in software. Everything works, more slowly.';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'render-notice-close';
  close.textContent = 'Got it';
  close.addEventListener('click', () => card.remove());
  card.append(title, body, close);
  document.body.appendChild(card);
}

/**
 * Replace the splash's "Assembling the workspace" with what went wrong when
 * the desktop renderer cannot start. Without WebGL2 there is nothing to draw
 * with; any other failure is reported with its message.
 */
export function showRendererUnavailable(report: RendererReport, error?: unknown): void {
  const overlay = document.getElementById('connecting-overlay');
  precondition(overlay !== null, 'the splash overlay exists');
  overlay!.classList.remove('hidden');
  const status = overlay!.querySelector('.connecting-status');
  if (status) status.textContent = 'Graphics unavailable';
  let detail = document.getElementById('connecting-detail');
  if (!detail) {
    detail = document.createElement('p');
    detail.id = 'connecting-detail';
    overlay!.appendChild(detail);
  }
  detail.textContent = report.webgl2
    ? `The desktop could not start drawing: ${error instanceof Error ? error.message : String(error ?? 'unknown error')}.`
    : 'Abject draws its desktop with WebGL2, and this window cannot get it: the graphics card failed to start, '
      + 'or graphics acceleration is turned off. If you just updated your graphics driver, restart the computer '
      + 'and open Abject again. In a web browser, turn on hardware acceleration in its settings.';
}
