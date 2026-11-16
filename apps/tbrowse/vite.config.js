import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// An MCP App view is delivered as ONE html document through resources/read,
// and the host's sandbox blocks every external script/style by default, so
// the whole app (React, tbrowse, the MCP Apps SDK) is inlined into the page.
//
// The result is written to ../../ui/tbrowse.html, which server.mjs reads at
// startup. That file is committed (the repo's .gitignore drops `dist`), so the
// server itself still runs with no install and no build step.
const UI_DIR = resolve(import.meta.dirname, '../../ui');

export default defineConfig({
  plugins: [
    react(),
    viteSingleFile(),
    {
      name: 'gramene-mcp-rename-output',
      apply: 'build',
      closeBundle() {
        rmSync(resolve(UI_DIR, 'tbrowse.html'), { force: true });
        renameSync(resolve(UI_DIR, 'index.html'), resolve(UI_DIR, 'tbrowse.html'));
      },
    },
  ],
  build: {
    outDir: UI_DIR,
    emptyOutDir: false,
    target: 'es2022',
  },
});
