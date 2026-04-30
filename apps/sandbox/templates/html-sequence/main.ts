import '@app/styles.css';
import '@videojs/html/video/player';
import '@videojs/html/media/sequence-video';
import { createHtmlSandboxState, createLatestLoader } from '@app/shared/html/sandbox-state';
import { loadVideoSkinTag } from '@app/shared/html/skins';
import { onSkinChange } from '@app/shared/sandbox-listener';

const html = String.raw;

const state = createHtmlSandboxState();
const loadLatest = createLatestLoader();

const CLIPS = [
  { url: 'https://stream.mux.com/lhnU49l1VGi3zrTAZhDm9LUUxSjpaPW9BL4jY25Kwo4/highest.mp4', duration: 12 },
  { url: 'https://stream.mux.com/VcmKA6aqzIzlg3MayLJDnbF55kX00mds028Z65QxvBYaA/high.mp4', duration: 8 },
  { url: 'https://stream.mux.com/Sc89iWAyNkhJ3P1rQ02nrEdCFTnfT01CZ2KmaEcxXfB008/low.mp4', duration: 15 },
];

const MUSIC =
  'https://commondatastorage.googleapis.com/codeskulptor-demos/DDR_assets/Kangaroo_MusiQue_-_The_Neverwritten_Role_Playing_Game.mp3';

const stitchedStoryboardPromise = buildStitchedStoryboard(CLIPS);

async function render() {
  const [tag, storyboardSrc] = await Promise.all([
    loadLatest(() => loadVideoSkinTag(state.skin, state.styling)),
    stitchedStoryboardPromise,
  ]);
  if (!tag) return;

  const sources = CLIPS.map((c) => html`<source src="${c.url}" data-duration="${c.duration}" />`).join('');

  const root = document.getElementById('root');
  if (!root) return;
  const template = document.createElement('template');
  template.innerHTML = html`
    <video-player>
      <${tag} class="aspect-video max-w-4xl mx-auto">
        <video-sequence music="${MUSIC}" playsinline crossorigin="anonymous">
          ${sources}
        </video-sequence>
      </${tag}>
    </video-player>
  `;
  root.replaceChildren(template.content);

  if (storyboardSrc) {
    const sequence = root.querySelector('video-sequence');
    if (sequence) {
      const track = document.createElement('track');
      track.kind = 'metadata';
      track.label = 'thumbnails';
      track.src = storyboardSrc;
      track.default = true;
      sequence.appendChild(track);
    }
  }
}

render();

onSkinChange((skin) => {
  state.skin = skin;
  render();
});

// --- Stitched Mux storyboard ---
//
// Mux exposes a per-asset `storyboard.vtt` whose cues map timeline positions
// to sprite tiles on `storyboard.jpg`. For a sequence we fetch each clip's
// storyboard, clamp cues to that clip's `data-duration` (the sequencer's
// playable window for the clip), and offset them by the cumulative timeline
// position so the slider preview lines up with the composed timeline.

interface SequenceClip {
  url: string;
  duration: number;
}

async function buildStitchedStoryboard(clips: readonly SequenceClip[]): Promise<string | null> {
  const lines = ['WEBVTT', ''];
  let offset = 0;

  for (const clip of clips) {
    const assetId = extractMuxAssetId(clip.url);
    if (!assetId) {
      offset += clip.duration;
      continue;
    }

    try {
      const response = await fetch(`https://image.mux.com/${assetId}/storyboard.vtt`);
      if (!response.ok) {
        offset += clip.duration;
        continue;
      }
      const vtt = await response.text();

      for (const cue of parseVttCues(vtt)) {
        if (cue.start >= clip.duration) break;
        const start = offset + cue.start;
        const end = offset + Math.min(cue.end, clip.duration);
        lines.push(`${formatVttTime(start)} --> ${formatVttTime(end)}`);
        lines.push(cue.text);
        lines.push('');
      }
    } catch {
      // Network or parse failure on a single clip is non-fatal — keep the
      // offset moving so subsequent clips line up with the composed timeline.
    }

    offset += clip.duration;
  }

  if (lines.length <= 2) return null;

  const blob = new Blob([lines.join('\n')], { type: 'text/vtt' });
  return URL.createObjectURL(blob);
}

function extractMuxAssetId(url: string): string | null {
  const match = url.match(/^https:\/\/stream\.mux\.com\/([^/.]+)/);
  return match?.[1] ?? null;
}

interface VttCue {
  start: number;
  end: number;
  text: string;
}

function parseVttCues(vtt: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = vtt.replace(/\r\n/g, '\n').split('\n\n');
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith('WEBVTT')) continue;

    const lines = trimmed.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes(' --> '));
    if (timingIndex === -1) continue;

    const [startStr, endStr] = lines[timingIndex]!.split(' --> ');
    const start = parseVttTime(startStr!);
    const end = parseVttTime(endStr!);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const text = lines.slice(timingIndex + 1).join('\n');
    if (!text) continue;

    cues.push({ start, end, text });
  }
  return cues;
}

function parseVttTime(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts.pop()) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return Number.NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${s.toFixed(3).padStart(6, '0')}`;
}
