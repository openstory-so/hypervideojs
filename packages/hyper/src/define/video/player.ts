import { HyperVideo } from '../../media/hyper-video';
import { safeDefine } from '../safe-define';

export class HyperVideoElement extends HyperVideo {
  static readonly tagName = 'hyper-video';
}

safeDefine(HyperVideoElement as unknown as CustomElementConstructor & { tagName: string });

declare global {
  interface HTMLElementTagNameMap {
    [HyperVideoElement.tagName]: HyperVideoElement;
  }
}
