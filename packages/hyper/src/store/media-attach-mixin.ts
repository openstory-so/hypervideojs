import type { Media } from '@videojs/core/dom';
import { type Context, ContextEvent, createContext } from '@videojs/element/context';
import type { CustomElement } from '@videojs/utils/dom';
import type { AnyConstructor, Constructor } from '@videojs/utils/types';

interface MediaContextValue {
  media: Media | null;
  setMedia: (media: Media | null) => void;
}

const MEDIA_CONTEXT_KEY = Symbol.for('@videojs/media');

type MediaContext = Context<typeof MEDIA_CONTEXT_KEY, MediaContextValue>;

const mediaContext: MediaContext = createContext<MediaContextValue, typeof MEDIA_CONTEXT_KEY>(MEDIA_CONTEXT_KEY);

/**
 * Mixin that registers the element as the media with whichever provider element
 * supplies `mediaContext`. The context key is `Symbol.for('@videojs/media')`,
 * which is identical across packages, so the same `<video-player>` provider
 * from `@videojs/html` is reached without an install dependency on it.
 */
export function MediaAttachMixin<Class extends AnyConstructor<HTMLElement>>(BaseClass: Class): Class {
  class MediaAttachElement extends (BaseClass as unknown as Constructor<CustomElement>) {
    #setMedia: ((media: Media | null) => void) | null = null;
    #unsubscribe: (() => void) | null = null;

    getMediaTarget(): Media | null {
      return this as unknown as Media;
    }

    override connectedCallback() {
      super.connectedCallback?.();

      this.dispatchEvent(
        new ContextEvent(
          mediaContext,
          this,
          (value, unsubscribe) => {
            if (unsubscribe) this.#unsubscribe = unsubscribe;
            this.#setMedia = value?.setMedia ?? null;
            if (this.isConnected) {
              this.#setMedia?.(this.getMediaTarget());
            }
          },
          true
        )
      );
    }

    override disconnectedCallback() {
      super.disconnectedCallback?.();
      this.#setMedia?.(null);
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#setMedia = null;
    }
  }

  return MediaAttachElement as unknown as Class;
}
