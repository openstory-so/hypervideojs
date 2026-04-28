# @videojs/hyper

Hyperframes-backed custom media element for Video.js 10.

`<hyper-video>` drives a hyperframes composition (sequenced clips + parallel
music) through the standard `<video-player>` chrome from `@videojs/html`. The
composition runs inside a sandboxed iframe; a hidden proxy `<video>` is what
the videojs feature slices observe.

## Install

```sh
pnpm add @videojs/hyper @videojs/html
```

## Usage

```ts
import '@videojs/html/video/player';
import '@videojs/hyper/video/player';
```

```html
<video-player>
  <hyper-video
    src="/path/to/composition.html"
    runtime-src="https://example.com/hyperframes-runtime.js"
    playsinline
  ></hyper-video>
</video-player>
```
