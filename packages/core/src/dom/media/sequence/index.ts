import { isNumber } from '@videojs/utils/predicate';
import type { MediaEngineHost } from '../../../core/media/types';
import { HTMLVideoElementHost } from '../video-host';

export interface SequenceClip {
  /** Source URL for this clip. Required. */
  url: string;
  /**
   * Duration of this clip in seconds. Optional — when omitted, the engine
   * fills it in from the inner video's `loadedmetadata` event. The composed
   * `duration` is `NaN` until every clip's duration is known.
   */
  duration?: number;
}

export interface SequenceMediaProps {
  clips: SequenceClip[];
  music: string | null;
  musicDriftTolerance: number;
}

export const sequenceMediaDefaultProps: SequenceMediaProps = {
  clips: [],
  music: null,
  musicDriftTolerance: 0.15,
};

const POOL_OVERLAY_STYLE = 'position:absolute;inset:0;width:100%;height:100%;object-fit:inherit;';

interface ComposedTimeRanges extends TimeRanges {}

function makeRanges(ranges: Array<readonly [number, number]>): ComposedTimeRanges {
  const frozen = ranges.map(([s, e]) => [s, e] as const);
  return Object.freeze({
    length: frozen.length,
    start(i: number) {
      const r = frozen[i];
      if (!r) throw new DOMException('Index out of range', 'IndexSizeError');
      return r[0];
    },
    end(i: number) {
      const r = frozen[i];
      if (!r) throw new DOMException('Index out of range', 'IndexSizeError');
      return r[1];
    },
  } as TimeRanges);
}

const EMPTY_RANGES = makeRanges([]);

/**
 * Plays a sequence of clips back-to-back as if they were one media element.
 *
 * Two pool `<video>` elements (A, B) are layered in the same box; while one
 * plays, the other preloads the next clip. At each boundary the engine
 * flips opacity to swap which is visible/audible, with no `src` reload on
 * the playing element. A separate `<audio>` element plays the optional
 * music track in parallel, soft-synced to the master clock so it doesn't
 * restart at clip boundaries.
 */
export class SequenceVideoMedia
  extends HTMLVideoElementHost
  implements MediaEngineHost<null, HTMLVideoElement>, SequenceMediaProps
{
  #clips: SequenceClip[] = [];
  #knownDurations: number[] = [];
  #index = 0;

  #activeKey: 'A' | 'B' = 'A';
  #poolB: HTMLVideoElement | null = null;
  #audio: HTMLAudioElement | null = null;
  #music: string | null = null;
  #musicDriftTolerance = sequenceMediaDefaultProps.musicDriftTolerance;

  #paused = true;
  #ended = false;
  #seeking = false;
  #syncRaf: number | null = null;
  #lastDuration = Number.NaN;

  // We forward events from the *active* pool to this host (not the original
  // attached target), so that consumers always see events from whichever video
  // is currently visible/audible.  The base class's automatic forwarding is
  // bypassed by overriding `addEventListener` below.
  #listenerTypes = new Set<string>();
  #forwardActiveEvent = (event: Event) => {
    this.dispatchEvent(new (event.constructor as typeof Event)(event.type, event));
  };

  get engine(): null {
    return null;
  }

  get clips(): SequenceClip[] {
    return this.#clips;
  }

  set clips(value: SequenceClip[]) {
    const next = Array.isArray(value) ? value.filter((c) => c && typeof c.url === 'string') : [];
    this.#clips = next;
    this.#knownDurations = next.map((c) => (isNumber(c.duration) ? c.duration : Number.NaN));
    this.#index = Math.min(this.#index, Math.max(0, next.length - 1));
    this.#ended = false;
    this.#applyClipsToPool();
    this.#emitDurationChangeIfChanged();
  }

  get music(): string | null {
    return this.#music;
  }

  set music(value: string | null) {
    if (this.#music === value) return;
    this.#music = value;
    this.#applyMusic();
  }

  get musicDriftTolerance(): number {
    return this.#musicDriftTolerance;
  }

  set musicDriftTolerance(value: number) {
    this.#musicDriftTolerance = isNumber(value) && value >= 0 ? value : sequenceMediaDefaultProps.musicDriftTolerance;
  }

  // --- Active pool element accessor ---

  /**
   * The pool video currently playing (visible + audible). Equal to `target`
   * when activeKey === 'A'.
   */
  get #activeVideo(): HTMLVideoElement | null {
    return this.#activeKey === 'A' ? this.target : this.#poolB;
  }

  get #inactiveVideo(): HTMLVideoElement | null {
    return this.#activeKey === 'A' ? this.#poolB : this.target;
  }

  // --- Lifecycle ---

  attach(target: HTMLVideoElement) {
    super.attach(target);
    this.#mountPool(target);
    this.#applyClipsToPool();
    this.#applyMusic();
    this.#rebindActiveListeners(null, this.#activeVideo);
  }

  detach() {
    this.#stopSyncLoop();
    this.#rebindActiveListeners(this.#activeVideo, null);
    this.#audio?.pause();
    this.#audio?.remove();
    this.#audio = null;
    this.#poolB?.pause();
    this.#poolB?.remove();
    this.#poolB = null;
    super.detach();
  }

  // --- Event forwarding from active pool ---

  // Override the base class so that listeners forward from whichever pool
  // element is currently active, not just the originally-attached target.
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: never) => void) | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    EventTarget.prototype.addEventListener.call(this, type, listener as EventListener, options);
    if (!this.#listenerTypes.has(type)) {
      this.#listenerTypes.add(type);
      this.#activeVideo?.addEventListener(type, this.#forwardActiveEvent);
    }
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: never) => void) | null,
    options?: boolean | EventListenerOptions
  ): void {
    EventTarget.prototype.removeEventListener.call(this, type, listener as EventListener, options);
  }

  #rebindActiveListeners(prev: HTMLVideoElement | null, next: HTMLVideoElement | null): void {
    if (prev === next) return;
    for (const type of this.#listenerTypes) {
      prev?.removeEventListener(type, this.#forwardActiveEvent);
      next?.addEventListener(type, this.#forwardActiveEvent);
    }
  }

  destroy() {
    this.detach();
    this.#clips = [];
    this.#knownDurations = [];
    this.#index = 0;
  }

  // --- Composed Video properties ---

  get currentTime(): number {
    const offset = this.#clipStart(this.#index);
    const local = this.#activeVideo?.currentTime ?? 0;
    return offset + local;
  }

  set currentTime(value: number) {
    if (!isNumber(value) || this.#clips.length === 0) return;
    const totalKnown = this.#totalKnownDuration();
    const target = Math.max(0, Math.min(value, Number.isFinite(totalKnown) ? totalKnown : value));

    const targetIndex = this.#findClipForTime(target);
    const local = target - this.#clipStart(targetIndex);

    this.#seeking = true;
    this.dispatchEvent(new Event('seeking'));

    if (targetIndex !== this.#index) {
      const inactiveEl = this.#inactiveVideo;
      const targetUrl = this.#clips[targetIndex]?.url ?? '';

      if (inactiveEl && targetUrl && inactiveEl.getAttribute('src') === targetUrl) {
        // The inactive pool already has the target clip preloaded — swap
        // active/inactive instead of forcing the active pool to reload its src.
        this.#swapActiveTo(targetIndex);
      } else {
        this.#index = targetIndex;
        this.#applyClipsToPool();
      }
    }

    const active = this.#activeVideo;
    if (active) {
      try {
        active.currentTime = local;
      } catch {
        // readyState may be < HAVE_METADATA
      }
    }

    this.#syncMusicTime(target);

    this.#seeking = false;
    this.dispatchEvent(new Event('seeked'));
    this.dispatchEvent(new Event('timeupdate'));
  }

  #swapActiveTo(newIndex: number): void {
    const previousActive = this.#activeVideo;
    this.#index = newIndex;
    this.#activeKey = this.#activeKey === 'A' ? 'B' : 'A';
    const newActive = this.#activeVideo;

    this.#rebindActiveListeners(previousActive, newActive);
    this.#syncOpacity();

    if (!this.#paused) {
      void newActive?.play().catch(() => {});
    }
    previousActive?.pause();

    // The new inactive (formerly active) should preload the next clip.
    const newInactive = this.#inactiveVideo;
    const nextUrl = this.#clips[newIndex + 1]?.url ?? '';
    if (newInactive) {
      if (nextUrl) {
        if (newInactive.getAttribute('src') !== nextUrl) {
          newInactive.src = nextUrl;
          newInactive.load?.();
        }
      } else {
        newInactive.removeAttribute('src');
      }
    }
  }

  get duration(): number {
    return this.#totalKnownDuration();
  }

  get paused(): boolean {
    return this.#paused;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get seeking(): boolean {
    return this.#seeking || (this.#activeVideo?.seeking ?? false);
  }

  get readyState(): number {
    return this.#activeVideo?.readyState ?? 0;
  }

  get buffered(): TimeRanges {
    const active = this.#activeVideo;
    if (!active) return EMPTY_RANGES;
    const offset = this.#clipStart(this.#index);
    const ranges: Array<readonly [number, number]> = [];
    for (let i = 0; i < active.buffered.length; i++) {
      ranges.push([active.buffered.start(i) + offset, active.buffered.end(i) + offset]);
    }
    return makeRanges(ranges);
  }

  get seekable(): TimeRanges {
    const total = this.#totalKnownDuration();
    if (!Number.isFinite(total) || total <= 0) return EMPTY_RANGES;
    return makeRanges([[0, total]]);
  }

  get src(): string {
    return this.#clips[this.#index]?.url ?? '';
  }

  set src(_value: string) {
    // Sequence sources come from the clip list, not a single src.
  }

  get currentSrc(): string {
    return this.#activeVideo?.currentSrc ?? '';
  }

  // --- Playback ---

  async play(): Promise<void> {
    if (this.#clips.length === 0) return;
    this.#paused = false;
    this.#ended = false;
    const active = this.#activeVideo;
    const playPromise = active?.play() ?? Promise.resolve();
    if (this.#audio && this.#music) {
      this.#syncMusicTime(this.currentTime);
      void this.#audio.play().catch(() => {});
    }
    this.#startSyncLoop();
    await playPromise;
  }

  pause(): void {
    this.#paused = true;
    this.#activeVideo?.pause();
    this.#audio?.pause();
    this.#stopSyncLoop();
  }

  load(): void {
    this.#applyClipsToPool();
  }

  // --- Internal: pool & lifecycle ---

  #mountPool(target: HTMLVideoElement) {
    target.style.position = target.style.position || 'relative';
    target.style.zIndex = '1';

    const parent = target.parentElement ?? (target.getRootNode() as ParentNode | null);
    if (!parent) return;

    if (!this.#poolB) {
      const b = (target.ownerDocument ?? document).createElement('video');
      b.setAttribute('playsinline', '');
      b.muted = false;
      b.preload = 'auto';
      b.style.cssText = POOL_OVERLAY_STYLE;
      b.style.zIndex = '0';
      b.style.opacity = '0';
      b.style.pointerEvents = 'none';
      target.insertAdjacentElement('afterend', b);
      this.#poolB = b;

      target.addEventListener('ended', this.#onActiveEnded);
      b.addEventListener('ended', this.#onActiveEnded);
    }

    if (!this.#audio) {
      const a = (target.ownerDocument ?? document).createElement('audio');
      a.preload = 'auto';
      a.style.display = 'none';
      target.insertAdjacentElement('afterend', a);
      this.#audio = a;
    }
  }

  #applyClipsToPool() {
    const a = this.target;
    const b = this.#poolB;

    const activeUrl = this.#clips[this.#index]?.url ?? '';
    const nextUrl = this.#clips[this.#index + 1]?.url ?? '';

    const activeEl = this.#activeKey === 'A' ? a : b;
    const inactiveEl = this.#activeKey === 'A' ? b : a;

    if (activeEl && activeEl.getAttribute('src') !== activeUrl) {
      if (activeUrl) activeEl.src = activeUrl;
      else activeEl.removeAttribute('src');
    }
    if (inactiveEl && inactiveEl.getAttribute('src') !== nextUrl) {
      if (nextUrl) inactiveEl.src = nextUrl;
      else inactiveEl.removeAttribute('src');
      if (nextUrl) inactiveEl.load?.();
    }

    this.#syncOpacity();
  }

  #syncOpacity() {
    const a = this.target;
    const b = this.#poolB;
    if (a) a.style.opacity = this.#activeKey === 'A' ? '1' : '0';
    if (b) b.style.opacity = this.#activeKey === 'B' ? '1' : '0';
  }

  // --- Internal: boundary swap ---

  #onActiveEnded = (event: Event) => {
    if (event.target !== this.#activeVideo) return;

    if (!this.#fillKnownDurationFromActive()) {
      this.#emitDurationChangeIfChanged();
    }

    // Suppress the underlying `ended` event in both branches: in the final
    // case we re-dispatch it manually after updating state, and in the
    // boundary case we don't want consumers to see a spurious `ended`.
    event.stopImmediatePropagation();

    if (this.#index >= this.#clips.length - 1) {
      this.#paused = true;
      this.#ended = true;
      this.#audio?.pause();
      this.#stopSyncLoop();
      this.dispatchEvent(new Event('ended'));
      return;
    }

    const previousActive = this.#activeVideo;
    this.#index += 1;
    this.#activeKey = this.#activeKey === 'A' ? 'B' : 'A';

    const newActive = this.#activeVideo;
    this.#rebindActiveListeners(previousActive, newActive);
    if (newActive) {
      try {
        newActive.currentTime = 0;
      } catch {
        // ignore — readyState may be < HAVE_METADATA
      }
      void newActive.play().catch(() => {});
    }
    previousActive?.pause();

    this.#syncOpacity();

    const inactive = this.#inactiveVideo;
    const nextUrl = this.#clips[this.#index + 1]?.url ?? '';
    if (inactive) {
      if (nextUrl) {
        inactive.src = nextUrl;
        inactive.load?.();
      } else {
        inactive.removeAttribute('src');
      }
    }

    this.dispatchEvent(new Event('timeupdate'));
  };

  #fillKnownDurationFromActive(): boolean {
    const active = this.#activeVideo;
    if (!active) return false;
    const d = active.duration;
    if (!Number.isFinite(d) || d <= 0) return false;
    if (this.#knownDurations[this.#index] === d) return false;
    this.#knownDurations[this.#index] = d;
    this.#emitDurationChangeIfChanged();
    return true;
  }

  // --- Internal: time math ---

  #clipStart(index: number): number {
    let sum = 0;
    for (let i = 0; i < index; i++) {
      const d = this.#knownDurations[i];
      if (d == null || !Number.isFinite(d)) return Number.NaN;
      sum += d;
    }
    return sum;
  }

  #totalKnownDuration(): number {
    if (this.#clips.length === 0) return Number.NaN;
    let sum = 0;
    for (const d of this.#knownDurations) {
      if (d == null || !Number.isFinite(d)) return Number.NaN;
      sum += d;
    }
    return sum;
  }

  #findClipForTime(time: number): number {
    let acc = 0;
    for (let i = 0; i < this.#knownDurations.length; i++) {
      const d = this.#knownDurations[i];
      if (d == null || !Number.isFinite(d)) return i;
      if (time < acc + d) return i;
      acc += d;
    }
    return Math.max(0, this.#clips.length - 1);
  }

  #emitDurationChangeIfChanged() {
    const next = this.#totalKnownDuration();
    const prev = this.#lastDuration;
    const same = (Number.isNaN(next) && Number.isNaN(prev)) || next === prev;
    if (same) return;
    this.#lastDuration = next;
    this.dispatchEvent(new Event('durationchange'));
  }

  // --- Internal: music sync ---

  #applyMusic() {
    const audio = this.#audio;
    if (!audio) return;
    if (this.#music) {
      if (audio.getAttribute('src') !== this.#music) {
        audio.src = this.#music;
        audio.load();
      }
      if (!this.#paused) {
        this.#syncMusicTime(this.currentTime);
        void audio.play().catch(() => {});
      }
    } else {
      audio.removeAttribute('src');
      audio.pause();
    }
  }

  #syncMusicTime(masterTime: number) {
    const audio = this.#audio;
    if (!audio || !this.#music) return;
    const audioDur = audio.duration;
    if (Number.isFinite(audioDur) && audioDur > 0 && masterTime >= audioDur) {
      audio.pause();
      return;
    }
    try {
      audio.currentTime = masterTime;
    } catch {
      // ignore — readyState may be < HAVE_METADATA
    }
  }

  #startSyncLoop() {
    if (this.#syncRaf != null) return;
    const tick = () => {
      this.#syncRaf = null;
      if (this.#paused) return;
      this.#correctMusicDrift();
      this.#syncRaf = (globalThis.requestAnimationFrame?.(tick) ?? null) as number | null;
    };
    this.#syncRaf = (globalThis.requestAnimationFrame?.(tick) ?? null) as number | null;
  }

  #stopSyncLoop() {
    if (this.#syncRaf != null) {
      globalThis.cancelAnimationFrame?.(this.#syncRaf);
      this.#syncRaf = null;
    }
  }

  #correctMusicDrift() {
    const audio = this.#audio;
    if (!audio || !this.#music || audio.paused) return;
    const drift = audio.currentTime - this.currentTime;
    if (Math.abs(drift) > this.#musicDriftTolerance) {
      this.#syncMusicTime(this.currentTime);
    }
  }
}
