import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SequenceClip, SequenceVideoMedia } from '../index';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function makeRanges(ranges: Array<readonly [number, number]>): TimeRanges {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i]![0],
    end: (i: number) => ranges[i]![1],
  } as unknown as TimeRanges;
}

function setBuffered(video: HTMLMediaElement, ranges: Array<readonly [number, number]>) {
  Object.defineProperty(video, 'buffered', { value: makeRanges(ranges), configurable: true });
}

function setup(
  clips: SequenceClip[] = [
    { url: 'a.mp4', duration: 10 },
    { url: 'b.mp4', duration: 5 },
  ]
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const primary = document.createElement('video');
  host.appendChild(primary);

  // jsdom doesn't implement play()/pause()/load() and logs "Not implemented" if invoked.
  // Replace with no-op data properties on the prototype so per-instance vi.spyOn
  // calls track only that instance — assigning a value rather than using vi.spyOn
  // keeps each instance's spy independent from the prototype's function identity.
  HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {};
  HTMLMediaElement.prototype.load = function load() {};

  const media = new SequenceVideoMedia();
  media.attach(primary);
  media.clips = clips;

  const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;

  return { media, primary, helper, host };
}

describe('SequenceVideoMedia', () => {
  describe('clips & duration', () => {
    it('sums known clip durations and emits durationchange', () => {
      const { media } = setup();
      const handler = vi.fn();
      media.addEventListener('durationchange', handler);

      media.clips = [
        { url: 'a.mp4', duration: 10 },
        { url: 'b.mp4', duration: 5 },
        { url: 'c.mp4', duration: 7 },
      ];

      expect(media.duration).toBe(22);
      expect(handler).toHaveBeenCalled();
    });

    it('reports NaN duration when any clip duration is unknown', () => {
      const { media } = setup([{ url: 'a.mp4', duration: 10 }, { url: 'b.mp4' }]);
      expect(Number.isNaN(media.duration)).toBe(true);
    });
  });

  describe('mounts a two-video pool', () => {
    it('creates a sibling helper <video>', () => {
      const { host } = setup();
      const videos = host.querySelectorAll('video');
      expect(videos.length).toBe(2);
    });

    it('makes the primary visible and the helper hidden initially', () => {
      const { primary, helper } = setup();
      expect(primary.style.opacity).toBe('1');
      expect(helper.style.opacity).toBe('0');
    });

    it('points the active pool element at the first clip and the helper at the second', () => {
      const { primary, helper } = setup();
      expect(primary.getAttribute('src')).toBe('a.mp4');
      expect(helper.getAttribute('src')).toBe('b.mp4');
    });
  });

  describe('currentTime composition', () => {
    it('returns active local time + start of active clip', () => {
      const { media, primary } = setup();
      Object.defineProperty(primary, 'currentTime', { value: 4, configurable: true });
      expect(media.currentTime).toBe(4);
    });

    it('after a boundary, currentTime reflects sum of completed clips', () => {
      const { media, primary, helper } = setup();
      primary.dispatchEvent(new Event('ended'));
      Object.defineProperty(helper, 'currentTime', { value: 2, configurable: true });
      expect(media.currentTime).toBe(12);
    });
  });

  describe('boundary swap', () => {
    it('does not dispatch ended when a non-final clip ends', () => {
      const { media, primary } = setup();
      const handler = vi.fn();
      media.addEventListener('ended', handler);

      primary.dispatchEvent(new Event('ended'));

      expect(handler).not.toHaveBeenCalled();
      expect(media.ended).toBe(false);
    });

    it('flips opacity to swap the visible pool element', () => {
      const { primary, helper } = setup();
      primary.dispatchEvent(new Event('ended'));
      expect(primary.style.opacity).toBe('0');
      expect(helper.style.opacity).toBe('1');
    });

    it('plays the new active element and pauses the old one', () => {
      const { primary, helper } = setup();
      const playSpy = vi.spyOn(helper, 'play');
      const pauseSpy = vi.spyOn(primary, 'pause');

      primary.dispatchEvent(new Event('ended'));

      expect(playSpy).toHaveBeenCalled();
      expect(pauseSpy).toHaveBeenCalled();
    });

    it('preloads the next clip on the now-inactive element', () => {
      const { primary, host } = setup([
        { url: 'a.mp4', duration: 10 },
        { url: 'b.mp4', duration: 5 },
        { url: 'c.mp4', duration: 7 },
      ]);
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;

      primary.dispatchEvent(new Event('ended'));

      expect(primary.getAttribute('src')).toBe('c.mp4');
      expect(helper.getAttribute('src')).toBe('b.mp4');
    });
  });

  describe('final ended', () => {
    it('dispatches ended exactly once when the last clip ends', () => {
      const { media, primary, host } = setup();
      const handler = vi.fn();
      media.addEventListener('ended', handler);

      primary.dispatchEvent(new Event('ended'));
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;
      helper.dispatchEvent(new Event('ended'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(media.ended).toBe(true);
      expect(media.paused).toBe(true);
    });
  });

  describe('event forwarding follows the active pool', () => {
    it('forwards events from the new active pool after a clip boundary', () => {
      const { media, primary, host } = setup();
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;
      const handler = vi.fn();
      media.addEventListener('timeupdate', handler);

      // Initially active pool is `primary`.
      primary.dispatchEvent(new Event('timeupdate'));
      expect(handler).toHaveBeenCalledTimes(1);

      // Boundary swap: helper becomes active, primary becomes inactive.
      primary.dispatchEvent(new Event('ended'));
      handler.mockClear();

      // Events from the now-inactive primary must NOT propagate.
      primary.dispatchEvent(new Event('timeupdate'));
      expect(handler).not.toHaveBeenCalled();

      // Events from the now-active helper MUST propagate.
      helper.dispatchEvent(new Event('timeupdate'));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('seek across boundaries', () => {
    it('swaps to the preloaded inactive pool instead of reloading the active pool', () => {
      const { media, primary, host } = setup([
        { url: 'a.mp4', duration: 10 },
        { url: 'b.mp4', duration: 5 },
      ]);
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;

      const seeking = vi.fn();
      const seeked = vi.fn();
      media.addEventListener('seeking', seeking);
      media.addEventListener('seeked', seeked);

      const setHelperTime = vi.fn();
      Object.defineProperty(helper, 'currentTime', { set: setHelperTime, get: () => 0, configurable: true });

      media.currentTime = 12;

      // Helper had b.mp4 preloaded — swap pools instead of forcing primary to reload.
      expect(helper.getAttribute('src')).toBe('b.mp4');
      expect(primary.getAttribute('src')).toBeNull();
      expect(helper.style.opacity).toBe('1');
      expect(primary.style.opacity).toBe('0');
      expect(setHelperTime).toHaveBeenCalledWith(2);
      expect(seeking).toHaveBeenCalled();
      expect(seeked).toHaveBeenCalled();
    });

    it('loads the target clip onto the inactive pool and swaps when no pool has it preloaded', () => {
      const { media, primary, host } = setup([
        { url: 'a.mp4', duration: 10 },
        { url: 'b.mp4', duration: 5 },
        { url: 'c.mp4', duration: 7 },
      ]);
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;

      const setHelperTime = vi.fn();
      Object.defineProperty(helper, 'currentTime', { set: setHelperTime, get: () => 0, configurable: true });

      // Seek directly into clip 2; helper is preloading clip 1 (b.mp4), not c.mp4.
      // The inactive pool (helper) takes the new src — primary keeps its current
      // src untouched until the swap, which avoids reload thrash on the active.
      media.currentTime = 17;

      expect(helper.getAttribute('src')).toBe('c.mp4');
      expect(primary.getAttribute('src')).toBeNull();
      expect(helper.style.opacity).toBe('1');
      expect(primary.style.opacity).toBe('0');
      expect(setHelperTime).toHaveBeenCalledWith(2);
    });

    it('keeps playing the new active pool when seeking across clips while playing', async () => {
      const { media, host } = setup();
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;
      const helperPlay = vi.spyOn(helper, 'play');

      await media.play();
      helperPlay.mockClear();

      media.currentTime = 12;

      expect(helperPlay).toHaveBeenCalled();
    });

    it('does not start playback when seeking across clips while paused', () => {
      const { media, primary, host } = setup();
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;
      const primaryPlay = vi.spyOn(primary, 'play');
      const helperPlay = vi.spyOn(helper, 'play');

      // media is paused by default; seek across boundary
      media.currentTime = 12;

      expect(primaryPlay).not.toHaveBeenCalled();
      expect(helperPlay).not.toHaveBeenCalled();
    });
  });

  describe('buffered translation', () => {
    it('translates active video buffered ranges into the global timeline', () => {
      const { media, primary, host } = setup();
      primary.dispatchEvent(new Event('ended'));
      const helper = host.querySelector('video:nth-of-type(2)') as HTMLVideoElement;
      setBuffered(helper, [[0, 4]]);

      expect(media.buffered.length).toBe(1);
      expect(media.buffered.start(0)).toBe(10);
      expect(media.buffered.end(0)).toBe(14);
    });
  });

  describe('seekable', () => {
    it('reports [0, duration] when duration is known', () => {
      const { media } = setup();
      expect(media.seekable.length).toBe(1);
      expect(media.seekable.start(0)).toBe(0);
      expect(media.seekable.end(0)).toBe(15);
    });
  });

  describe('pause/play semantics', () => {
    it('paused stays true across boundaries when pause() was called', () => {
      const { media, primary } = setup();
      media.pause();
      expect(media.paused).toBe(true);
      primary.dispatchEvent(new Event('ended'));
      expect(media.paused).toBe(true);
    });

    it('paused stays false during boundary swap when playing', async () => {
      const { media, primary } = setup();
      await media.play();
      expect(media.paused).toBe(false);
      primary.dispatchEvent(new Event('ended'));
      expect(media.paused).toBe(false);
    });
  });

  describe('music', () => {
    it('creates an <audio> element when music is set', () => {
      const { media, host } = setup();
      media.music = 'music.mp3';
      const audio = host.querySelector('audio') as HTMLAudioElement;
      expect(audio).toBeTruthy();
      expect(audio.getAttribute('src')).toBe('music.mp3');
    });

    it('plays audio in parallel on play()', async () => {
      const { media, host } = setup();
      media.music = 'music.mp3';
      const audio = host.querySelector('audio') as HTMLAudioElement;
      const playSpy = vi.spyOn(audio, 'play');
      await media.play();
      expect(playSpy).toHaveBeenCalled();
    });

    it('does not pause audio at clip boundary', () => {
      const { media, primary, host } = setup();
      media.music = 'music.mp3';
      const audio = host.querySelector('audio') as HTMLAudioElement;
      // jsdom's `audio.src = ...` setter and `load()` synthesise a pause; ignore those.
      const audioPause = vi.spyOn(audio, 'pause');
      audioPause.mockClear();

      primary.dispatchEvent(new Event('ended'));

      expect(audioPause).not.toHaveBeenCalled();
    });

    it('seeks audio when master time changes during playback', async () => {
      const { media, host } = setup();
      media.music = 'music.mp3';
      const audio = host.querySelector('audio') as HTMLAudioElement;
      Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
      const setSpy = vi.fn();
      Object.defineProperty(audio, 'currentTime', { set: setSpy, get: () => 0, configurable: true });

      await media.play();
      setSpy.mockClear();

      media.currentTime = 7;

      expect(setSpy).toHaveBeenCalledWith(7);
    });

    it('does not touch audio when seeking while paused', () => {
      const { media, host } = setup();
      media.music = 'music.mp3';
      const audio = host.querySelector('audio') as HTMLAudioElement;
      Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
      const setSpy = vi.fn();
      Object.defineProperty(audio, 'currentTime', { set: setSpy, get: () => 0, configurable: true });
      const pauseSpy = vi.spyOn(audio, 'pause');

      // media is paused by default
      media.currentTime = 7;

      expect(setSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it('pauses audio when master time exceeds audio duration during playback', async () => {
      const { media, host } = setup();
      media.music = 'music.mp3';
      const audio = host.querySelector('audio') as HTMLAudioElement;
      Object.defineProperty(audio, 'duration', { value: 5, configurable: true });

      await media.play();
      const pauseSpy = vi.spyOn(audio, 'pause');

      media.currentTime = 12;

      expect(pauseSpy).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('removes the helper video and audio elements', () => {
      const { media, host } = setup();
      media.music = 'music.mp3';
      expect(host.querySelectorAll('video').length).toBe(2);
      expect(host.querySelector('audio')).toBeTruthy();

      media.destroy();

      expect(host.querySelectorAll('video').length).toBe(1);
      expect(host.querySelector('audio')).toBeFalsy();
    });

    it('nullifies the target reference', () => {
      const { media } = setup();
      expect(media.target).not.toBeNull();
      media.destroy();
      expect(media.target).toBeNull();
    });

    it('removes forwarding listeners from the primary element', () => {
      const { media, primary } = setup();
      const playHandler = vi.fn();
      media.addEventListener('play', playHandler);

      primary.dispatchEvent(new Event('play'));
      expect(playHandler).toHaveBeenCalledOnce();

      media.destroy();
      playHandler.mockClear();

      primary.dispatchEvent(new Event('play'));
      expect(playHandler).not.toHaveBeenCalled();
    });
  });
});
