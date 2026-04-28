import { CustomMediaElement } from '@videojs/core/dom/media/custom-media-element';
import { MediaAttachMixin } from '../store/media-attach-mixin';
import { HyperMediaHost } from './hyper-media-host';

const HYPER_VIDEO_OBSERVED = ['audio-src', 'runtime-src'] as const;

export class HyperVideo extends MediaAttachMixin(CustomMediaElement('video', HyperMediaHost)) {
  static get observedAttributes(): string[] {
    return [
      // biome-ignore lint/complexity/noThisInStatic: forwards to the parent's observed list
      ...super.observedAttributes,
      ...HYPER_VIDEO_OBSERVED,
    ];
  }
}
