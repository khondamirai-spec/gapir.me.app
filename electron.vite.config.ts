import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      /*
       * Never inline an asset as a data: URI.
       *
       * Vite inlines anything under 4 KB by default, which quietly turned the smallest font
       * subset into `src: url(data:font/woff2;base64,…)` — and the renderers run under
       * `default-src 'self'`, which has no data: in it. The result is one Cyrillic subset
       * that loads in dev and is blocked in the packaged build, which is the worst shape a
       * bug can have. Emitting every asset as a file keeps the CSP strict and the two
       * environments identical.
       */
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          overlay: resolve('src/renderer/overlay/index.html'),
          dockGuides: resolve('src/renderer/dock-guides/index.html'),
          app: resolve('src/renderer/app/index.html')
        }
      }
    }
  }
});
