#!/usr/bin/env node
/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// Copies the built, self-contained web-client HTML into the Tabby plugin so it can
// be embedded (asset/source) and served over the outbound tunnel (httpTunnelHandler).
// Fails loudly if the source is missing so `build:all` never silently ships a stale/absent page.
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..')
const src = path.join(root, 'clients', 'web', 'dist', 'index.html')
const destDir = path.join(root, 'clients', 'tabby', 'assets')
const dest = path.join(destDir, 'web-client.html')

if (!fs.existsSync(src)) {
    console.error(`[copy-web-asset] ERROR: web-client build not found at ${src}`)
    console.error('[copy-web-asset] Run `npm run build:web` first (build:all does this in order).')
    process.exit(1)
}

fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(src, dest)
console.log(`[copy-web-asset] ${path.relative(root, src)} -> ${path.relative(root, dest)}`)
