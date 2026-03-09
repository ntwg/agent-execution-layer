#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = resolve(rootDir, 'dist', 'scripts', 'ado-workflow.js');

if (!existsSync(entryPath)) {
  console.error('agent-execution-layer: missing build output. Run "npm run build" first.');
  process.exit(1);
}

await import(pathToFileURL(entryPath).href);
