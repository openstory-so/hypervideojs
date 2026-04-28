import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AutoplayBlockedMessage,
  createIframeBridge,
  type HyperframesPlayer,
  type ReadyMessage,
  type StateMessage,
} from '../iframe-bridge';

interface ExposedWindow extends Window {
  __player?: HyperframesPlayer;
  __timelines?: unknown;
}

function createIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  return iframe;
}

function postFromIframe(iframe: HTMLIFrameElement, data: unknown): void {
  globalThis.dispatchEvent(
    new MessageEvent('message', {
      source: iframe.contentWindow,
      data,
    })
  );
}

function noop(): void {}

afterEach(() => {
  document.body.replaceChildren();
});

describe('createIframeBridge', () => {
  it('routes inbound ready/state/autoplay messages to the right callbacks', () => {
    const iframe = createIframe();
    const onReady = vi.fn<(message: ReadyMessage) => void>();
    const onState = vi.fn<(message: StateMessage) => void>();
    const onAutoplayBlocked = vi.fn<(message: AutoplayBlockedMessage) => void>();

    const bridge = createIframeBridge({
      iframe,
      onReady,
      onState,
      onAutoplayBlocked,
    });

    postFromIframe(iframe, { type: 'ready', duration: 12 });
    expect(onReady).toHaveBeenCalledWith({ type: 'ready', duration: 12 });

    postFromIframe(iframe, { type: 'state', time: 1.5, playing: true, ended: false });
    expect(onState).toHaveBeenCalledWith({ type: 'state', time: 1.5, playing: true, ended: false });

    postFromIframe(iframe, { type: 'media-autoplay-blocked', message: 'blocked' });
    expect(onAutoplayBlocked).toHaveBeenCalledWith({ type: 'media-autoplay-blocked', message: 'blocked' });

    bridge.dispose();
  });

  it('ignores messages from other windows', () => {
    const iframe = createIframe();
    const onReady = vi.fn();

    const bridge = createIframeBridge({ iframe, onReady, onState: noop, onAutoplayBlocked: noop });

    globalThis.dispatchEvent(
      new MessageEvent('message', {
        source: null,
        data: { type: 'ready', duration: 10 },
      })
    );
    expect(onReady).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it('prefers __player methods over postMessage fallback', () => {
    const iframe = createIframe();
    const win = iframe.contentWindow as ExposedWindow;
    const player: Required<HyperframesPlayer> = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setPlaybackRate: vi.fn(),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
    };
    win.__player = player;
    const postMessage = vi.spyOn(win, 'postMessage');

    const bridge = createIframeBridge({ iframe, onReady: noop, onState: noop, onAutoplayBlocked: noop });

    bridge.play();
    bridge.pause();
    bridge.setCurrentTime(2);
    bridge.setPlaybackRate(1.5);
    bridge.setVolume(0.5);
    bridge.setMuted(true);

    expect(player.play).toHaveBeenCalledOnce();
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.seek).toHaveBeenCalledWith(2);
    expect(player.setPlaybackRate).toHaveBeenCalledWith(1.5);
    expect(player.setVolume).toHaveBeenCalledWith(0.5);
    expect(player.setMuted).toHaveBeenCalledWith(true);
    expect(postMessage).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it('falls back to hf-parent control envelopes when __player is unavailable', () => {
    const iframe = createIframe();
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage');

    const bridge = createIframeBridge({ iframe, onReady: noop, onState: noop, onAutoplayBlocked: noop });

    bridge.play();
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'hf-parent', type: 'control', action: 'play' },
      '*'
    );

    // setCurrentTime translates seconds → frames (canonical 30fps)
    bridge.setCurrentTime(3);
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'hf-parent', type: 'control', action: 'seek', frame: 90 },
      '*'
    );

    bridge.setPlaybackRate(1.5);
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'hf-parent', type: 'control', action: 'set-playback-rate', playbackRate: 1.5 },
      '*'
    );

    bridge.setMuted(true);
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'hf-parent', type: 'control', action: 'set-muted', muted: true },
      '*'
    );

    bridge.dispose();
  });

  it('translates upstream hf-preview timeline + state envelopes to seconds', () => {
    const iframe = createIframe();
    const ready = vi.fn<(message: ReadyMessage) => void>();
    const state = vi.fn<(message: StateMessage) => void>();

    const bridge = createIframeBridge({
      iframe,
      onReady: ready,
      onState: state,
      onAutoplayBlocked: noop,
    });

    // Upstream timeline message — durationInFrames = 450 → 15s @ 30fps
    postFromIframe(iframe, {
      source: 'hf-preview',
      type: 'timeline',
      durationInFrames: 450,
      clips: [],
      scenes: [],
      compositionWidth: 1920,
      compositionHeight: 1080,
    });
    expect(ready).toHaveBeenCalledWith({ type: 'ready', duration: 15 });

    // Upstream state message — frame = 90 → 3s @ 30fps
    postFromIframe(iframe, {
      source: 'hf-preview',
      type: 'state',
      frame: 90,
      isPlaying: true,
      muted: false,
      playbackRate: 1,
    });
    expect(state).toHaveBeenCalledWith({ type: 'state', time: 3, playing: true, ended: false });

    // Final-frame state at the duration boundary should mark ended once paused
    postFromIframe(iframe, {
      source: 'hf-preview',
      type: 'state',
      frame: 450,
      isPlaying: false,
      muted: false,
      playbackRate: 1,
    });
    expect(state).toHaveBeenLastCalledWith({ type: 'state', time: 15, playing: false, ended: true });

    bridge.dispose();
  });

  it('ignores non-state hf-preview envelopes (diagnostic, stage-size, picker)', () => {
    const iframe = createIframe();
    const ready = vi.fn();
    const state = vi.fn();

    const bridge = createIframeBridge({
      iframe,
      onReady: ready,
      onState: state,
      onAutoplayBlocked: noop,
    });

    postFromIframe(iframe, { source: 'hf-preview', type: 'diagnostic', code: 'x', details: {} });
    postFromIframe(iframe, { source: 'hf-preview', type: 'stage-size', width: 1920, height: 1080 });
    postFromIframe(iframe, { source: 'hf-preview', type: 'analytics' });

    expect(ready).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();

    bridge.dispose();
  });

  describe('runtime injection on load', () => {
    let originalCSSEscape: typeof CSS.escape | undefined;

    beforeEach(() => {
      originalCSSEscape = globalThis.CSS?.escape;
      globalThis.CSS ??= { escape: (value: string) => value } as typeof CSS;
      globalThis.CSS.escape ??= (value: string) => value;
    });

    afterEach(() => {
      if (originalCSSEscape) globalThis.CSS.escape = originalCSSEscape;
    });

    it('injects a script tag with runtime-src when __player/__timelines are missing', () => {
      const iframe = createIframe();
      const bridge = createIframeBridge({
        iframe,
        runtimeSrc: 'https://example.com/runtime.js',
        onReady: noop,
        onState: noop,
        onAutoplayBlocked: noop,
      });

      iframe.dispatchEvent(new Event('load'));

      const win = iframe.contentWindow as ExposedWindow;
      const script = win.document.querySelector('script[src="https://example.com/runtime.js"]');
      expect(script).not.toBeNull();

      bridge.dispose();
    });

    it('does not inject when __player is already present', () => {
      const iframe = createIframe();
      const win = iframe.contentWindow as ExposedWindow;
      win.__player = { play: noop };

      const bridge = createIframeBridge({
        iframe,
        runtimeSrc: 'https://example.com/runtime.js',
        onReady: noop,
        onState: noop,
        onAutoplayBlocked: noop,
      });

      iframe.dispatchEvent(new Event('load'));

      expect(win.document.querySelector('script[src="https://example.com/runtime.js"]')).toBeNull();
      bridge.dispose();
    });

    it('does inject when only __timelines is present (composition awaiting runtime)', () => {
      const iframe = createIframe();
      const win = iframe.contentWindow as ExposedWindow;
      win.__timelines = { main: {} };

      const bridge = createIframeBridge({
        iframe,
        runtimeSrc: 'https://example.com/runtime.js',
        onReady: noop,
        onState: noop,
        onAutoplayBlocked: noop,
      });

      iframe.dispatchEvent(new Event('load'));

      expect(win.document.querySelector('script[src="https://example.com/runtime.js"]')).not.toBeNull();
      bridge.dispose();
    });
  });

  it('dispose() removes the message listener', () => {
    const iframe = createIframe();
    const onReady = vi.fn();

    const bridge = createIframeBridge({ iframe, onReady, onState: noop, onAutoplayBlocked: noop });
    bridge.dispose();

    postFromIframe(iframe, { type: 'ready', duration: 10 });
    expect(onReady).not.toHaveBeenCalled();
  });
});
