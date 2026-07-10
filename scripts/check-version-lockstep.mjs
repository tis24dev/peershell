/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// The publishable/workspace package.json versions must stay in lockstep (the release
// pipeline bumps them together). Fails CI if they diverge.
import { readFileSync } from 'node:fs'

const pkgs = [
    'shared/package.json',
    'clients/web/package.json',
    'clients/tabby/package.json',
    'server/package.json',
]

const versions = pkgs.map(p => [p, JSON.parse(readFileSync(p, 'utf8')).version])
const distinct = [...new Set(versions.map(([, v]) => v))]

if (distinct.length !== 1) {
    console.error('Version lockstep FAILED, workspaces disagree:')
    for (const [p, v] of versions) {
        console.error(`  ${p} = ${v}`)
    }
    process.exit(1)
}

console.log(`version lockstep OK: all workspaces at ${distinct[0]}`)
