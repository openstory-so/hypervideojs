import { isFunction, isObject } from '@videojs/utils/predicate';

/**
 * Canonical hyperframes runtime fps. State and timeline messages report frames
 * (not seconds) so consumers can stay frame-aligned across runtime → render
 * parity boundaries; we convert to seconds at the videojs boundary.
 */
const HYPERFRAMES_FPS = 30;

/** Inbound: composition signals the runtime is ready and reports duration (seconds). */
export interface ReadyMessage {
  type: 'ready';
  duration: number;
}

/** Inbound: composition state tick (seconds-domain). */
export interface StateMessage {
  type: 'state';
  time: number;
  playing: boolean;
  ended: boolean;
}

/** Inbound: autoplay was blocked by the browser policy. */
export interface AutoplayBlockedMessage {
  type: 'media-autoplay-blocked';
  message?: string;
}

/** Inbound: composition reports its native render dimensions. */
export interface StageSizeMessage {
  type: 'stage-size';
  width: number;
  height: number;
}

export type InboundMessage = ReadyMessage | StateMessage | AutoplayBlockedMessage | StageSizeMessage;

/**
 * Surface of the hyperframes runtime exposed on `iframe.contentWindow.__player`
 * (`@hyperframes/core` runtime). The bridge calls the same-origin path when
 * available — it's faster than postMessage and lands sub-frame precise — and
 * falls back to the `hf-parent` postMessage envelope otherwise.
 */
export interface HyperframesPlayer {
  play?: () => void;
  pause?: () => void;
  /** Upstream signature is seconds. */
  seek?: (timeSeconds: number) => void;
  /** Optional — upstream `__player` does not expose this directly. */
  setPlaybackRate?: (rate: number) => void;
  /** Optional — upstream `__player` does not expose this directly. */
  setVolume?: (volume: number) => void;
  /** Optional — upstream `__player` does not expose this directly. */
  setMuted?: (muted: boolean) => void;
}

export interface IframeBridgeOptions {
  iframe: HTMLIFrameElement;
  /**
   * URL to inject into the iframe when the composition loads but the
   * runtime hasn't booted (no `__player`). Supports a getter so the host
   * can pass a live reference — the value is read on every load event,
   * which matters because custom-element attributes propagate after the
   * constructor (so a value captured at bridge creation may be stale).
   */
  runtimeSrc?: string | (() => string | undefined);
  onReady: (message: ReadyMessage) => void;
  onState: (message: StateMessage) => void;
  onAutoplayBlocked: (message: AutoplayBlockedMessage) => void;
  /** Optional — receive composition native dimensions for scale-to-fit. */
  onStageSize?: (message: StageSizeMessage) => void;
}

export interface IframeBridge {
  play(): void;
  pause(): void;
  setCurrentTime(time: number): void;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

interface ExposedWindow extends Window {
  __player?: HyperframesPlayer;
  __timelines?: unknown;
}

/**
 * Wire a sandboxed iframe to videojs.
 *
 * - Probes `iframe.contentWindow.__player` on `load`; auto-injects the
 *   runtime when missing.
 * - Translates inbound `{source: "hf-preview", ...}` envelopes (the
 *   `@hyperframes/core` protocol — frame-domain) into seconds-domain
 *   `{type: "ready" | "state" | "media-autoplay-blocked"}` callbacks.
 * - Sends outbound control as `{source: "hf-parent", type: "control",
 *   action, ...}` envelopes when same-origin `__player` access isn't
 *   available.
 */
export function createIframeBridge(options: IframeBridgeOptions): IframeBridge {
  const { iframe, runtimeSrc, onReady, onState, onAutoplayBlocked, onStageSize } = options;
  const controller = new AbortController();
  const { signal } = controller;

  let lastDuration = 0;
  let lastPlaying = false;

  const handleMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    if (!isObject(event.data)) return;
    const data = event.data as { source?: string; type?: string } & Record<string, unknown>;

    // `@hyperframes/core` runtime envelopes (the wire format used by the
    // upstream player and the CDN-hosted runtime).
    if (data.source === 'hf-preview') {
      if (data.type === 'timeline') {
        const durationFrames = Number(data.durationInFrames);
        if (Number.isFinite(durationFrames) && durationFrames > 0) {
          lastDuration = durationFrames / HYPERFRAMES_FPS;
          onReady({ type: 'ready', duration: lastDuration });
        }
        return;
      }
      if (data.type === 'state') {
        const frame = Number(data.frame);
        const time = Number.isFinite(frame) ? frame / HYPERFRAMES_FPS : 0;
        const playing = Boolean(data.isPlaying);
        // Upstream protocol has no explicit `ended` — derive from
        // `time >= duration` once we know the duration.
        const ended = !playing && lastDuration > 0 && time >= lastDuration - 1 / HYPERFRAMES_FPS;
        lastPlaying = playing;
        onState({ type: 'state', time, playing, ended });
        return;
      }
      if (data.type === 'media-autoplay-blocked') {
        onAutoplayBlocked({ type: 'media-autoplay-blocked' });
        return;
      }
      if (data.type === 'stage-size') {
        const width = Number(data.width);
        const height = Number(data.height);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          onStageSize?.({ type: 'stage-size', width, height });
        }
        return;
      }
      // Ignore: diagnostic, picker, analytics, perf
      return;
    }

    // Bare-shape protocol kept for shim runtimes and tests that post
    // `{type: "ready"|"state"|"media-autoplay-blocked"}` directly.
    if (data.type === 'ready') {
      const next = data as unknown as ReadyMessage;
      lastDuration = next.duration;
      onReady(next);
    } else if (data.type === 'state') {
      const next = data as unknown as StateMessage;
      lastPlaying = next.playing;
      onState(next);
    } else if (data.type === 'media-autoplay-blocked') {
      onAutoplayBlocked(data as unknown as AutoplayBlockedMessage);
    }
  };

  globalThis.addEventListener('message', handleMessage, { signal });

  const handleLoad = (): void => {
    const win = iframe.contentWindow as ExposedWindow | null;
    if (!win) return;
    // Skip injection only when the runtime has already booted (it exposes
    // __player). __timelines on its own is just composition data waiting for
    // a runtime to consume it.
    if (win.__player) return;
    const src = typeof runtimeSrc === 'function' ? runtimeSrc() : runtimeSrc;
    if (!src) return;
    injectRuntime(win, src);
  };

  iframe.addEventListener('load', handleLoad, { signal });

  const player = (): HyperframesPlayer | null => {
    const win = iframe.contentWindow as ExposedWindow | null;
    return win?.__player ?? null;
  };

  const postControl = (action: string, extra: Record<string, unknown> = {}): void => {
    iframe.contentWindow?.postMessage({ source: 'hf-parent', type: 'control', action, ...extra }, '*');
  };

  void lastPlaying; // reserved for future ended-derivation tweaks

  return {
    play(): void {
      const fn = player()?.play;
      if (isFunction(fn)) fn();
      else postControl('play');
    },
    pause(): void {
      const fn = player()?.pause;
      if (isFunction(fn)) fn();
      else postControl('pause');
    },
    setCurrentTime(time: number): void {
      const fn = player()?.seek;
      if (isFunction(fn)) fn(time);
      else postControl('seek', { frame: Math.round(time * HYPERFRAMES_FPS) });
    },
    setPlaybackRate(rate: number): void {
      // No flat `setPlaybackRate` on the upstream `__player`; the upstream
      // player component sends the postMessage envelope. Try the legacy
      // direct call first so shim runtimes / tests keep working.
      const fn = player()?.setPlaybackRate;
      if (isFunction(fn)) fn(rate);
      else postControl('set-playback-rate', { playbackRate: rate });
    },
    setVolume(volume: number): void {
      // Upstream has no global `setVolume` — volume is per-element via
      // `__player.setElementVolume(id, volume)`. videojs's primary control
      // is muted; treat volume as a no-op against the real runtime and let
      // shim runtimes (including tests) handle it via `__player.setVolume`.
      const fn = player()?.setVolume;
      if (isFunction(fn)) fn(volume);
    },
    setMuted(muted: boolean): void {
      const fn = player()?.setMuted;
      if (isFunction(fn)) fn(muted);
      else postControl('set-muted', { muted });
    },
    dispose(): void {
      controller.abort();
    },
  };
}

function injectRuntime(win: Window, src: string): void {
  const doc = win.document;
  if (!doc) return;
  // Skip if a script with the same src already exists.
  if (doc.querySelector(`script[src="${CSS.escape(src)}"]`)) return;
  const script = doc.createElement('script');
  script.src = src;
  script.async = true;
  doc.head?.append(script) ?? doc.documentElement?.append(script);
}
