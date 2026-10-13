/**
 * Software rendering when the GPU fails.
 *
 * The desktop draws with WebGL2. When the GPU process cannot start (a
 * graphics driver updated without a reboot, a blocklisted GPU, a broken EGL
 * stack), Chromium gives up on it after three crashes and turns WebGL off for
 * the whole session, and the desktop can never appear. Software WebGL
 * (SwiftShader) works there, but it has to be chosen before Chromium starts,
 * so the app relaunches itself once with it and tells the page why
 * (client/render-notice.ts shows the person).
 *
 * A failure at startup relaunches without asking: nothing is running yet and
 * nothing could be drawn. A GPU lost mid-session asks first, since relaunching
 * restarts the backend and every agent with it.
 *
 * `ABJECTS_SOFTWARE_GL=1` starts in software rendering on purpose.
 */

import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

/** The argument a software-rendering relaunch carries, with its reason. */
const SOFTWARE_GL_ARG = '--abject-software-gl';
/** Chromium disables the GPU after this many GPU-process crashes. */
const GPU_CRASHES_BEFORE_FALLBACK = 3;
/** Within this long of the window opening, a GPU failure still counts as startup. */
const STARTUP_GRACE_MS = 20_000;

/** Why this launch renders in software, or undefined when it uses the GPU. */
function softwareReason(): string | undefined {
  const arg = process.argv.find(a => a === SOFTWARE_GL_ARG || a.startsWith(`${SOFTWARE_GL_ARG}=`));
  if (arg) {
    const encoded = arg.slice(SOFTWARE_GL_ARG.length + 1);
    try { return decodeURIComponent(encoded) || 'requested'; } catch { return 'requested'; }
  }
  return process.env.ABJECTS_SOFTWARE_GL && process.env.ABJECTS_SOFTWARE_GL !== '0' ? 'ABJECTS_SOFTWARE_GL is set' : undefined;
}

export interface GpuFallback {
  /** Why rendering is in software this launch, for the page; undefined on the GPU. */
  readonly softwareReason?: string;
  /** Call when the desktop window opens (startup failures relaunch without asking until a grace period after). */
  windowOpened(): void;
}

/**
 * Apply software rendering when this launch asked for it, else watch the GPU
 * and fall back if it fails. Must run before the app is ready (command-line
 * switches only take effect then).
 */
export function setupGpuFallback(): GpuFallback {
  const reason = softwareReason();
  if (reason) {
    // Tested on a broken NVIDIA/EGL stack: no hardware GPU at all, software
    // compositing, and WebGL2 through SwiftShader.
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
    console.warn(`[Abject] rendering in software: ${reason}`);
    return { softwareReason: reason, windowOpened: () => {} };
  }

  let crashes = 0;
  let lastExit = '';
  let windowOpenedAt: number | undefined;
  let relaunching = false;

  const fallBack = async (why: string): Promise<void> => {
    if (relaunching) return;
    const midSession = windowOpenedAt !== undefined && Date.now() - windowOpenedAt > STARTUP_GRACE_MS;
    console.warn(`[Abject] the GPU cannot be used (${why}; last GPU exit: ${lastExit || 'none'}).`);
    if (midSession) {
      relaunching = true;
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Abject',
        buttons: ['Restart with software rendering', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: 'Graphics stopped working',
        detail: `The graphics card failed (${why}), so the desktop cannot draw. Abject can restart with software rendering: `
          + 'everything works, more slowly, and running agents pick up again after the restart. '
          + 'If you just updated your graphics driver, restarting the computer brings acceleration back.',
      });
      if (response !== 0) { relaunching = false; return; }
    }
    relaunching = true;
    console.warn('[Abject] relaunching with software rendering');
    relaunchAfterExit(why);
    app.quit();
  };

  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return;
    crashes++;
    lastExit = `${details.reason}, exit code ${details.exitCode}`;
    if (crashes >= GPU_CRASHES_BEFORE_FALLBACK) {
      void fallBack(`the graphics process crashed ${crashes} times`);
    }
  });

  // A GPU that starts but gives no WebGL (blocklisted, or acceleration off)
  // never crashes; its feature status says so once the GPU process reports.
  void app.whenReady().then(() => app.getGPUInfo('basic')).then(() => {
    const webgl = app.getGPUFeatureStatus().webgl;
    if (/^(disabled|unavailable)/.test(webgl)) {
      void fallBack(`WebGL is ${webgl.startsWith('unavailable') ? 'unavailable' : 'turned off'} for this graphics card`);
    }
  }).catch(() => { /* the crash handler covers a GPU process that never reports */ });

  return { windowOpened: () => { windowOpenedAt ??= Date.now(); } };
}

/**
 * The command that starts this install: the AppImage itself (the running
 * binary lives in its mount, which goes away with this process), else the
 * --no-sandbox wrapper electron/afterPack.cjs puts in front of `<name>.bin`,
 * else the Electron binary. The same choice AppUpdater makes when it
 * relaunches after an update.
 */
function launchTarget(): string {
  if (process.env.APPIMAGE) return process.env.APPIMAGE;
  const exe = process.execPath;
  if (exe.endsWith('.bin')) {
    const wrapper = exe.slice(0, -'.bin'.length);
    if (fs.existsSync(wrapper)) return wrapper;
  }
  return exe;
}

/**
 * Start this app again in software rendering once this process has exited,
 * from a detached shell that waits for our pid to go away (started earlier,
 * the new copy would find the single-instance lock held and quit). Output
 * stays on this process's stdout, so a log piped from a terminal continues.
 */
function relaunchAfterExit(why: string): void {
  const env = { ...process.env };
  // The old AppImage's mount variables would point the new one at a mount that is going away.
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[k];
  const args = process.argv.slice(1)
    .filter(a => a !== '--no-sandbox' && a !== SOFTWARE_GL_ARG && !a.startsWith(`${SOFTWARE_GL_ARG}=`));
  args.push(`${SOFTWARE_GL_ARG}=${encodeURIComponent(why)}`);
  // Elsewhere the running binary outlives this process, and Electron's own
  // relaunch waits for the exit.
  if (process.platform !== 'linux') {
    app.relaunch({ args: process.argv.slice(1).filter(a => !a.startsWith(SOFTWARE_GL_ARG)).concat(args.slice(-1)) });
    return;
  }
  const script = 'pid="$1"; shift; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done; exec "$@"';
  const child = spawn('/bin/sh', ['-c', script, 'abject-relaunch', String(process.pid), launchTarget(), ...args], {
    detached: true, stdio: ['ignore', 'inherit', 'inherit'], env,
  });
  child.unref();
}
