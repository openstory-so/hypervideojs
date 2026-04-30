import { SequenceVideo } from '../../media/sequence-video';
import { safeDefine } from '../safe-define';

export class SequenceVideoElement extends SequenceVideo {
  static readonly tagName = 'video-sequence';
}

safeDefine(SequenceVideoElement);

declare global {
  interface HTMLElementTagNameMap {
    [SequenceVideoElement.tagName]: SequenceVideoElement;
  }
}
