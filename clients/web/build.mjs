#!/usr/bin/env node
// Stage 0 build: emit a self-contained dist/index.html (placeholder).
// Stage 4 replaces this with a webpack (target 'web') build that inlines xterm.js + the transport.
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'

const dir = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)))
const src = path.join(dir, 'src', 'index.html')
const outDir = path.join(dir, 'dist')

fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(src, path.join(outDir, 'index.html'))
console.log('[web-client] wrote dist/index.html (Stage 0 placeholder)')
