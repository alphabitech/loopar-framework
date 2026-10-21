import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react';
import { readdirSync, lstatSync } from 'fs';
import { resolve } from 'pathe';
import { compression, defineAlgorithm } from 'vite-plugin-compression2';
import { constants } from 'zlib';
import tailwindcss from '@tailwindcss/vite';
import svgr from 'vite-plugin-svgr';

const framework = process.cwd();
const loopar = 'node_modules/loopar';

const BUILD_COMPRESS = (process.env.BUILD_COMPRESS ?? 'brotli').toLowerCase();
const BROTLI_QUALITY = Number(process.env.BUILD_BROTLI_QUALITY ?? 9);
const GZIP_LEVEL = Number(process.env.BUILD_GZIP_LEVEL ?? 6);

const compressionAlgorithms = [
  (BUILD_COMPRESS === 'gzip' || BUILD_COMPRESS === 'both') &&
    defineAlgorithm('gzip', { level: GZIP_LEVEL }),
  (BUILD_COMPRESS === 'brotli' || BUILD_COMPRESS === 'both') &&
    defineAlgorithm('brotliCompress', { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }),
].filter(Boolean);

const resRoot = (...args) => resolve(framework, ...args);
const resLoopar = (...args) => resRoot(loopar, ...args);

const Alias = (dir, dirOnly = false) => {
  return readdirSync(dir).reduce((acc, name) => {
    const fullPath = resolve(dir, name);
    const baseName = name.split(".")[0];
    const ext = name.split(".").pop()?.toLowerCase();

    if (lstatSync(fullPath).isDirectory()) {
      acc[`@@${baseName}`] = fullPath;
      !dirOnly && Object.assign(acc, Alias(fullPath));
    } else if (
      baseName.length > 0 && 
      baseName !== 'index' &&
      ['js', 'jsx', 'ts', 'tsx'].includes(ext)
    ) {
      acc[`@${baseName}`] = fullPath;
    }
    return acc;
  }, {});
};

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  const isServerBuild = process.env.BUILD_TARGET === 'server';
  const isWatch = process.env.WATCH === '1';
  const target = isServerBuild ? 'server' : 'client';

  return {
    resolve: {
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.d.ts'],
      dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
      alias: {
        // Framework namespaces (the document system) FIRST: Vite matches
        // aliases in key order, and `Alias(src)` below also emits a generic
        // '@loopar' key (from src/loopar.jsx) that would swallow these.
        '@loopar/document': resLoopar('src/document'),
        '@loopar/form': resLoopar('src/document/form'),
        '@loopar/list': resLoopar('src/document/list'),
        '@loopar/page': resLoopar('src/document/page'),
        '@loopar/print': resLoopar('src/document/print'),

        ...Alias(resLoopar('src/components')),
        ...Alias(resLoopar('src'), true),
        '@cn': resolve('node_modules/cn/src'),
        '@app': resRoot('app/'),
        'loopar': resLoopar('src/loopar.jsx'),
        '@loopar': resLoopar('src/'),
        '@global': resLoopar('core/global'),
        '@workspace': resLoopar('src/workspace'),
        '@context': resLoopar('src/context'),
        '@services': resLoopar('services'),
        '/app': resRoot('app'),

        '@uiw': resRoot('node_modules/@uiw/'),
        'file-type': resRoot('node_modules/file-type'),
      },
    },

    plugins: [
      tailwindcss(),
      react({
        devTarget: "esnext",
      }),
      svgr(),

      !isDev && !isWatch && compressionAlgorithms.length > 0 && compression({
        algorithms: compressionAlgorithms,
        threshold: 512,
        include: /\.(js|mjs|css|html|json|svg)$/,
        exclude: [/\.map$/, /stats\.html$/],
      })
    ].filter(Boolean),

    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "lucide-react",
      ],
    },
    
    ssr: {
      external: true,
      noExternal: ['lucide-react'],
    },

    build: {
      outDir: resRoot(isWatch ? 'build/staging' : 'dist', target),
      ssr: isServerBuild,
      manifest: true,
      target: 'esnext',

      // Only changes under apps/**/client/** trigger a rebuild. This narrows the
      // trigger to where you iterate (app views) — it does NOT change what gets
      // built: every rebuild still bundles the full graph. Framework edits
      // (packages/loopar) won't auto-rebuild; use a full Build for those.
      ...(isWatch && { watch: { include: ['**/apps/**/client/**'] } }),

      minify: !isDev,
      
      cssCodeSplit: true,
      sourcemap: false,
      
      rolldownOptions: {
        input: resRoot(isServerBuild ? 'app/entry-server.jsx' : 'main.html'),
        output: !isServerBuild ? {
          chunkFileNames: 'assets/[hash].js',
          assetFileNames: 'assets/[hash].[ext]',
          manualChunks(id) {
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/react/jsx-runtime') ||
              id.includes('/node_modules/react/jsx-dev-runtime') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'react-vendor';
            }
          },
        } : undefined,
      },
      chunkSizeWarningLimit: 1000,
    },

    server: {
      allowedHosts: true,
      hmr: true,
      watch: {
        usePolling: process.env.VITE_USE_POLLING === 'true',
        ignored: [
          '**/sites/**/config/**',
          // Build outputs — never watched/scanned by the dev server. The
          // background watcher writes large bundles into build/staging; if the
          // dev server tries to parse those, its WASM scanner runs out of memory.
          '**/dist/**',
          '**/build/**',
        ],
      },
      fs: {
        allow: ['..'],
      }
    }
  };
});