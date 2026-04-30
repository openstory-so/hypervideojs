import { afterEach, describe, expect, it } from 'vitest';
import { SequenceVideo } from '../index';

let tagCounter = 0;

function uniqueTag(base: string): string {
  return `${base}-${tagCounter++}`;
}

function defineElement(): string {
  const tag = uniqueTag('test-video-sequence');
  customElements.define(tag, class extends SequenceVideo {});
  return tag;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('SequenceVideo', () => {
  it('writes the music attribute through to the host audio element without recursing', () => {
    const tag = defineElement();
    const el = document.createElement(tag) as SequenceVideo & { music: string | null };
    el.setAttribute('music', 'music.mp3');
    document.body.appendChild(el);

    // The mediaHost setter must have run; the audio element should pick up the src.
    expect(el.music).toBe('music.mp3');
    const audio = el.shadowRoot?.querySelector('audio');
    expect(audio?.getAttribute('src')).toBe('music.mp3');
  });

  it('clears the audio src when the music attribute is removed', () => {
    const tag = defineElement();
    const el = document.createElement(tag) as SequenceVideo & { music: string | null };
    el.setAttribute('music', 'music.mp3');
    document.body.appendChild(el);

    el.removeAttribute('music');
    const audio = el.shadowRoot?.querySelector('audio');
    expect(audio?.getAttribute('src')).toBeNull();
  });
});
