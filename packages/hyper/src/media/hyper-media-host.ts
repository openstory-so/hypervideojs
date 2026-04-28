import { HTMLVideoElementHost } from '@videojs/core/dom';

/** Minimal `MediaError`-like shape compatible with `@videojs/core` `errorFeature`. */
export interface HyperMediaError {
  readonly code: number;
  readonly message: string;
}

import { isString } from '@videojs/utils/predicate';
import {
  type AutoplayBlockedMessage,
  createIframeBridge,
  type IframeBridge,
  type ReadyMessage,
  type StateMessage,
} from './iframe-bridge';

const AUTOPLAY_BLOCKED_CODE = 4;

/**
 * Media host that drives a hyperframes composition through a sandboxed iframe.
 * Owns the iframe lifecycle, bridges control + state between videojs and the
 * composition, and dispatches synthetic events on the proxy `<video>` so the
 * existing feature slices observe state changes unchanged.
 */
export class HyperMediaHost extends HTMLVideoElementHost {
  #src = '';
  #audioSrc = '';
  #runtimeSrc = '';

  #iframe: HTMLIFrameElement | null = null;
  #wrapper: HTMLDivElement | null = null;
  #bridge: IframeBridge | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #stageWidth = 1920;
  #stageHeight = 1080;

  #duration = NaN;
  #currentTime = 0;
  #paused = true;
  #ended = false;
  #playbackRate = 1;
  #volume = 1;
  #muted = false;
  #error: HyperMediaError | null = null;
  #destroyed = false;

  override get src(): string {
    return this.#src;
  }

  override set src(value: string) {
    if (this.#src === value) return;
    this.#src = value;
    this.load();
  }

  get audioSrc(): string {
    return this.#audioSrc;
  }

  set audioSrc(value: string) {
    this.#audioSrc = value;
    this.#updateIframeSrc();
  }

  get runtimeSrc(): string {
    return this.#runtimeSrc;
  }

  set runtimeSrc(value: string) {
    this.#runtimeSrc = value;
  }

  override get duration(): number {
    return this.#duration;
  }

  override get currentTime(): number {
    return this.#currentTime;
  }

  override set currentTime(value: number) {
    if (Number.isNaN(value)) return;
    this.#currentTime = value;
    this.#bridge?.setCurrentTime(value);
    this.#dispatch('timeupdate');
  }

  override get paused(): boolean {
    return this.#paused;
  }

  override get ended(): boolean {
    return this.#ended;
  }

  override get playbackRate(): number {
    return this.#playbackRate;
  }

  override set playbackRate(value: number) {
    this.#playbackRate = value;
    this.#bridge?.setPlaybackRate(value);
    this.#dispatch('ratechange');
  }

  override get volume(): number {
    return this.#volume;
  }

  override set volume(value: number) {
    this.#volume = value;
    this.#bridge?.setVolume(value);
    this.#dispatch('volumechange');
  }

  override get muted(): boolean {
    return this.#muted;
  }

  override set muted(value: boolean) {
    this.#muted = value;
    this.#bridge?.setMuted(value);
    this.#dispatch('volumechange');
  }

  override get error(): HyperMediaError | null {
    return this.#error;
  }

  override get readyState(): number {
    return Number.isFinite(this.#duration) ? 4 : 0;
  }

  override play(): Promise<void> {
    this.#bridge?.play();
    return Promise.resolve();
  }

  override pause(): void {
    this.#bridge?.pause();
  }

  override load(): void {
    this.#resetState();
    this.#dispatch('emptied');
    this.#dispatch('loadstart');
    this.#updateIframeSrc();
  }

  override attach(target: HTMLVideoElement): void {
    super.attach(target);
    if (this.#destroyed) return;
    this.#ensureIframe();
    if (this.#src) this.#updateIframeSrc();
  }

  override detach(): void {
    this.#teardownIframe();
    super.detach();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.detach();
  }

  #ensureIframe(): void {
    if (this.#iframe) return;
    const target = this.target;
    if (!target) return;
    const root = target.getRootNode() as ShadowRoot | Document;

    const doc = target.ownerDocument ?? globalThis.document;
    // Wrapper provides a positioned containing block for the iframe. Without
    // it, the iframe's `offsetParent` pierces the open shadow root and
    // resolves to <body>, so absolute positioning would size against the
    // viewport instead of the player slot.
    const wrapper = doc.createElement('div');
    wrapper.setAttribute('part', 'hyper-stage');
    // `position: relative` so the inner iframe's absolute positioning resolves
    // against the wrapper, not against an arbitrary ancestor that may pierce
    // the shadow root. `width/height: 100%` makes the wrapper fill whatever
    // slot the player chrome gives `<hyper-video>` — `<hyper-video>` itself
    // is `display: contents`, so the wrapper renders into the parent's flex
    // cell directly.
    wrapper.style.cssText =
      'position:relative;display:block;width:100%;height:100%;overflow:hidden;';
    const iframe = doc.createElement('iframe');
    iframe.setAttribute('part', 'hyper-iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('allow', 'autoplay');
    // Iframe is sized at the composition's native dimensions and scaled into
    // place via CSS transform — same approach as `<hyperframes-player>`. This
    // keeps the runtime's pixel coordinates intact (important for the
    // composition's hard-coded layout) while letting the player chrome
    // determine display size.
    iframe.style.cssText =
      'position:absolute;top:50%;left:50%;border:0;transform:translate(-50%,-50%) scale(1);';
    wrapper.appendChild(iframe);
    root.appendChild(wrapper);
    this.#wrapper = wrapper;

    // Hide the proxy <video> — it's only here so videojs feature slices have
    // an HTMLMediaElement to listen on. Visual output comes from the iframe.
    target.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';

    this.#iframe = iframe;
    this.#applyStageScale();

    // Recompute scale whenever the wrapper's bounds change.
    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#applyStageScale());
      this.#resizeObserver.observe(wrapper);
    }
    // First-pass scale; subsequent recalculations come via ResizeObserver and
    // the runtime's stage-size message.
    queueMicrotask(() => this.#applyStageScale());

    this.#bridge = createIframeBridge({
      iframe,
      // Pass a getter so the bridge reads the current runtime-src on every
      // iframe load. Custom-element attribute propagation order means
      // `runtime-src` is set on the host after the constructor — capturing
      // the value here would otherwise read an empty string.
      runtimeSrc: () => this.#runtimeSrc || undefined,
      onReady: this.#handleReady,
      onState: this.#handleState,
      onAutoplayBlocked: this.#handleAutoplayBlocked,
      onStageSize: this.#handleStageSize,
    });
  }

  #applyStageScale(): void {
    const iframe = this.#iframe;
    const wrapper = this.#wrapper;
    if (!iframe || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const scale = Math.min(rect.width / this.#stageWidth, rect.height / this.#stageHeight);
    iframe.style.width = `${this.#stageWidth}px`;
    iframe.style.height = `${this.#stageHeight}px`;
    iframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  #handleStageSize = (message: { width: number; height: number }): void => {
    this.#stageWidth = message.width;
    this.#stageHeight = message.height;
    this.#applyStageScale();
  };

  #teardownIframe(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#bridge?.dispose();
    this.#bridge = null;
    this.#iframe = null;
    this.#wrapper?.remove();
    this.#wrapper = null;
  }

  #updateIframeSrc(): void {
    const iframe = this.#iframe;
    if (!iframe) return;
    const next = this.#composeIframeSrc();
    if (iframe.getAttribute('src') === next) return;
    if (next) iframe.setAttribute('src', next);
    else iframe.removeAttribute('src');
  }

  #composeIframeSrc(): string {
    if (!this.#src) return '';
    if (!this.#audioSrc) return this.#src;
    const sep = this.#src.includes('?') ? '&' : '?';
    return `${this.#src}${sep}audioSrc=${encodeURIComponent(this.#audioSrc)}`;
  }

  #resetState(): void {
    this.#duration = NaN;
    this.#currentTime = 0;
    this.#paused = true;
    this.#ended = false;
    this.#error = null;
  }

  #handleReady = (message: ReadyMessage): void => {
    this.#duration = Number.isFinite(message.duration) ? message.duration : NaN;
    this.#error = null;
    this.#dispatch('loadedmetadata');
    this.#dispatch('durationchange');
    this.#dispatch('canplay');
  };

  #handleState = (message: StateMessage): void => {
    const wasPaused = this.#paused;
    const wasEnded = this.#ended;

    if (message.time !== this.#currentTime) {
      this.#currentTime = message.time;
      this.#dispatch('timeupdate');
    }

    const nextPaused = !message.playing;
    if (nextPaused !== wasPaused) {
      this.#paused = nextPaused;
      this.#dispatch(nextPaused ? 'pause' : 'play');
      if (!nextPaused) this.#dispatch('playing');
    }

    if (message.ended && !wasEnded) {
      this.#ended = true;
      this.#paused = true;
      this.#dispatch('ended');
    } else if (!message.ended && wasEnded) {
      this.#ended = false;
    }
  };

  #handleAutoplayBlocked = (message: AutoplayBlockedMessage): void => {
    this.#error = {
      code: AUTOPLAY_BLOCKED_CODE,
      message: isString(message.message) ? message.message : 'Autoplay blocked by the browser.',
    };
    this.#dispatch('error');
  };

  #dispatch(type: string): void {
    this.target?.dispatchEvent(new Event(type));
  }
}
