import '@app/styles.css';
import '@videojs/html/video/player';
import '@videojs/hyper/video/player';
import { createHtmlSandboxState, createLatestLoader } from '@app/shared/html/sandbox-state';
import { loadVideoSkinTag } from '@app/shared/html/skins';
import { onSkinChange } from '@app/shared/sandbox-listener';
import { SOURCES } from '@app/shared/sources';

const html = String.raw;

// Same runtime URL @hyperframes/player defaults to. Drives the composition's
// timelines, media sync, captions, nested compositions, and animation
// adapters (GSAP, CSS, Lottie, Three, WAAPI). Loaded over the wire — no
// install dep on @hyperframes/*.
const HYPER_RUNTIME_SRC =
  'https://cdn.jsdelivr.net/npm/@hyperframes/core/dist/hyperframe.runtime.iife.js';
const COMPOSITION_SRC = SOURCES['kara-design'].url;

const state = createHtmlSandboxState();
const loadLatest = createLatestLoader();

async function render() {
  const tag = await loadLatest(() => loadVideoSkinTag(state.skin, state.styling));
  if (!tag) return;

  document.getElementById('root')!.innerHTML = html`
    <video-player>
      <${tag} class="aspect-video max-w-4xl mx-auto">
        <hyper-video
          src="${COMPOSITION_SRC}"
          runtime-src="${HYPER_RUNTIME_SRC}"
          playsinline
          crossorigin="anonymous"
        ></hyper-video>
      </${tag}>
    </video-player>
  `;
}

render();

onSkinChange((skin) => {
  state.skin = skin;
  render();
});
