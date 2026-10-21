import path from 'pathe';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve against this file, not process.cwd(): the core may be started from
// a different working directory (pm2, CLI subcommands, tests).
const selfRoute = path.dirname(fileURLToPath(import.meta.url));
const srcFile = path.resolve(selfRoute, "src/markdown-render.js");
const distDir = path.resolve(selfRoute, "dist/ssr");
const distFile  = path.resolve(distDir, "markdown-render.js");

const needsBuild = () => {
  if (process.env.NODE_ENV === 'production') return !fs.existsSync(distFile);
  if (!fs.existsSync(distFile)) return true;
  const srcDir = path.dirname(srcFile);
  const newest = Math.max(...fs.readdirSync(srcDir).map(f => fs.statSync(path.join(srcDir, f)).mtimeMs));
  return newest > fs.statSync(distFile).mtimeMs;
};

if (needsBuild()) {
  // Vite only when the SSR bundle must be (re)built: loading `loopar` with a
  // fresh bundle (production, tests, CLI) never pulls the bundler in.
  const { build } = await import('vite');
  await build({
    root: selfRoute,
    ssr: {
      noExternal: ['@uiw/react-markdown-preview'],
    },
    build: {
      ssr: true,
      outDir: distDir,
      rolldownOptions: {
        input: srcFile,
      },
      minify: true,
    },
  });
}

// ESM dynamic import needs a file:// URL — a bare absolute path fails on
// Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME, "c:" is read as a protocol).
const { renderMarkdown } = await import(pathToFileURL(distFile).href);

export const markdownRenderer = (markdown) => renderMarkdown(markdown);