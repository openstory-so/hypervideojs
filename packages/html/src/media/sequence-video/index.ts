import { CustomMediaElement } from '@videojs/core/dom/media/custom-media-element';
import { type SequenceClip, SequenceVideoMedia } from '@videojs/core/dom/media/sequence';
import { MediaAttachMixin } from '../../store/media-attach-mixin';

export type { SequenceClip };

/**
 * Look up a method on the prototype chain ABOVE `SequenceVideo` and call it
 * on `instance`. Necessary because the `MediaAttachMixin` adds lifecycle
 * methods that the static type system doesn't track on the mixed class.
 */
function invokeSuper(instance: object, name: string, ...args: unknown[]): void {
  let proto = Object.getPrototypeOf(SequenceVideo.prototype);
  while (proto && proto !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (desc && typeof desc.value === 'function') {
      desc.value.apply(instance, args);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
}

export class SequenceVideo extends MediaAttachMixin(CustomMediaElement('video', SequenceVideoMedia)) {
  static get observedAttributes(): string[] {
    // biome-ignore lint/complexity/noThisInStatic: intentional use of super
    return [...super.observedAttributes, 'music'];
  }

  #childObserver: MutationObserver | null = null;
  #sourceObservers = new WeakMap<HTMLSourceElement, MutationObserver>();

  connectedCallback(): void {
    invokeSuper(this, 'connectedCallback');
    this.#syncClipsFromSources();
    this.#observeChildren();
  }

  disconnectedCallback(): void {
    invokeSuper(this, 'disconnectedCallback');
    this.#unobserveChildren();
  }

  // The `music` attribute flows through `CustomMediaElement`'s
  // `attributeChangedCallback`: it's listed in `observedAttributes` and the
  // `SequenceVideoMedia` getter/setter is detected during `#define`, so the
  // base class wires `music` into `mediaHostAttrToProp` and writes the
  // attribute value directly to `mediaHost.music`. Overriding here would
  // create an infinite loop (setter → setAttribute → callback → setter).

  #syncClipsFromSources(): void {
    const sources = this.querySelectorAll<HTMLSourceElement>(':scope > source');
    const clips: SequenceClip[] = [];
    for (const el of sources) {
      const src = el.getAttribute('src');
      if (!src) continue;
      const clip: SequenceClip = { url: src };
      const dur = el.getAttribute('data-duration');
      if (dur) {
        const n = Number(dur);
        if (Number.isFinite(n) && n > 0) clip.duration = n;
      }
      clips.push(clip);
    }
    (this as unknown as SequenceVideoMedia).clips = clips;
  }

  #observeChildren(): void {
    if (this.#childObserver) return;
    this.#childObserver = new MutationObserver(() => {
      this.#refreshSourceObservers();
      this.#syncClipsFromSources();
    });
    this.#childObserver.observe(this, { childList: true });
    this.#refreshSourceObservers();
  }

  #unobserveChildren(): void {
    this.#childObserver?.disconnect();
    this.#childObserver = null;
    for (const el of this.querySelectorAll<HTMLSourceElement>(':scope > source')) {
      this.#sourceObservers.get(el)?.disconnect();
      this.#sourceObservers.delete(el);
    }
  }

  #refreshSourceObservers(): void {
    for (const el of this.querySelectorAll<HTMLSourceElement>(':scope > source')) {
      if (this.#sourceObservers.has(el)) continue;
      const obs = new MutationObserver(() => this.#syncClipsFromSources());
      obs.observe(el, { attributes: true, attributeFilter: ['src', 'data-duration'] });
      this.#sourceObservers.set(el, obs);
    }
  }
}
