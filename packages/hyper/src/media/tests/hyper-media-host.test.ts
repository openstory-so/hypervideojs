import { CustomMediaElement } from '@videojs/core/dom/media/custom-media-element';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HyperMediaHost } from '../hyper-media-host';
import type { HyperframesPlayer } from '../iframe-bridge';

interface ExposedWindow extends Window {
  __player?: HyperframesPlayer;
}

let tagCounter = 0;

function defineHyperElement(): { Ctor: CustomElementConstructor; tag: string } {
  const tag = `test-hyper-${++tagCounter}`;
  const Ctor = CustomMediaElement('video', HyperMediaHost) as unknown as CustomElementConstructor;
  customElements.define(tag, Ctor);
  return { Ctor, tag };
}

interface HyperLikeElement extends HTMLElement {
  src: string;
  audioSrc: string;
  runtimeSrc: string;
  duration: number;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  error: { code: number; message: string } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
}

function create(def: { Ctor: CustomElementConstructor; tag: string }): HyperLikeElement {
  const el = new def.Ctor() as unknown as HyperLikeElement;
  document.body.append(el as unknown as HTMLElement);
  return el;
}

function getIframe(el: HyperLikeElement): HTMLIFrameElement {
  const iframe = (el as unknown as HTMLElement).shadowRoot?.querySelector('iframe');
  if (!iframe) throw new Error('iframe not found');
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

beforeEach(() => {
  globalThis.CSS ??= { escape: (value: string) => value } as typeof CSS;
  globalThis.CSS.escape ??= (value: string) => value;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('HyperMediaHost', () => {
  it('mounts a sandboxed iframe in the shadow root and hides the proxy <video>', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/composition.html';

    const iframe = getIframe(el);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe.getAttribute('src')).toBe('https://example.com/composition.html');

    const proxy = (el as unknown as HTMLElement).shadowRoot?.querySelector('video');
    expect(proxy).not.toBeNull();
    expect(proxy?.style.opacity).toBe('0');
  });

  it('appends audioSrc as a query param when both are set', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    el.audioSrc = 'https://example.com/a.mp3';

    const iframe = getIframe(el);
    expect(iframe.getAttribute('src')).toBe('https://example.com/c.html?audioSrc=https%3A%2F%2Fexample.com%2Fa.mp3');
  });

  it('inbound ready sets duration and dispatches durationchange/loadedmetadata', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    const iframe = getIframe(el);

    const events: string[] = [];
    for (const type of ['loadedmetadata', 'durationchange', 'canplay']) {
      el.addEventListener(type, () => events.push(type));
    }

    postFromIframe(iframe, { type: 'ready', duration: 42 });

    expect(el.duration).toBe(42);
    expect(events).toEqual(['loadedmetadata', 'durationchange', 'canplay']);
  });

  it('inbound state drives currentTime, paused, ended, and dispatches matching events', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    const iframe = getIframe(el);

    const events: string[] = [];
    for (const type of ['timeupdate', 'play', 'playing', 'pause', 'ended']) {
      el.addEventListener(type, () => events.push(type));
    }

    postFromIframe(iframe, { type: 'state', time: 1, playing: true, ended: false });
    expect(el.currentTime).toBe(1);
    expect(el.paused).toBe(false);
    expect(events).toContain('play');
    expect(events).toContain('playing');
    expect(events).toContain('timeupdate');

    postFromIframe(iframe, { type: 'state', time: 2, playing: false, ended: false });
    expect(el.paused).toBe(true);
    expect(events).toContain('pause');

    postFromIframe(iframe, { type: 'state', time: 5, playing: false, ended: true });
    expect(el.ended).toBe(true);
    expect(events).toContain('ended');
  });

  it('outbound play()/pause() calls the iframe __player without echoing back', async () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    const iframe = getIframe(el);
    const win = iframe.contentWindow as ExposedWindow;

    const playSpy = vi.fn();
    const pauseSpy = vi.fn();
    win.__player = { play: playSpy, pause: pauseSpy };

    await el.play();
    expect(playSpy).toHaveBeenCalledOnce();
    expect(el.paused).toBe(true);

    el.pause();
    expect(pauseSpy).toHaveBeenCalledOnce();
  });

  it('seek via currentTime setter calls the iframe and updates state on inbound state', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    const iframe = getIframe(el);
    const win = iframe.contentWindow as ExposedWindow;

    const seekSpy = vi.fn();
    win.__player = { seek: seekSpy };

    el.currentTime = 7;
    expect(seekSpy).toHaveBeenCalledWith(7);

    postFromIframe(iframe, { type: 'state', time: 7, playing: false, ended: false });
    expect(el.currentTime).toBe(7);
  });

  it('media-autoplay-blocked surfaces via host.error and dispatches error event', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    const iframe = getIframe(el);

    const errorSpy = vi.fn();
    el.addEventListener('error', errorSpy);

    postFromIframe(iframe, { type: 'media-autoplay-blocked' });

    expect(el.error).not.toBeNull();
    expect(el.error?.code).toBe(4);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('src swap updates iframe and resets bridge state', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/a.html';
    const iframe = getIframe(el);

    postFromIframe(iframe, { type: 'ready', duration: 30 });
    postFromIframe(iframe, { type: 'state', time: 5, playing: true, ended: false });
    expect(el.duration).toBe(30);
    expect(el.currentTime).toBe(5);

    const emittedTypes: string[] = [];
    for (const type of ['emptied', 'loadstart']) {
      el.addEventListener(type, () => emittedTypes.push(type));
    }

    el.src = 'https://example.com/b.html';

    expect(iframe.getAttribute('src')).toBe('https://example.com/b.html');
    expect(Number.isNaN(el.duration)).toBe(true);
    expect(el.currentTime).toBe(0);
    expect(el.paused).toBe(true);
    expect(emittedTypes).toEqual(['emptied', 'loadstart']);
  });

  it('removing the element tears down the iframe and stops processing messages', () => {
    const el = create(defineHyperElement());
    el.src = 'https://example.com/c.html';
    const iframe = getIframe(el);

    el.remove();

    expect(iframe.isConnected).toBe(false);

    const before = { duration: el.duration, currentTime: el.currentTime };
    postFromIframe(iframe, { type: 'ready', duration: 99 });
    expect(el.duration).toEqual(before.duration);
  });
});
