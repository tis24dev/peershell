#!/usr/bin/env node
// Publishes the Tabby plugin (clients/tabby -> npm "tabby-peershell") from the monorepo subdir.
// Verifies the bundle exists before publishing. Version bump/tagging is expected to be done
// beforehand (or by CI on a release tag). Kept intentionally small.
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'
import { execFileSync } from 'child_process'

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..')
const pluginDir = path.join(root, 'clients', 'tabby')
const bundle = path.join(pluginDir, 'dist', 'index.js')

if (!fs.existsSync(bundle)) {
    console.error(`[publish] ERROR: built bundle missing at ${bundle}. Run \`npm run build:all\` first.`)
    process.exit(1)
}

const dry = process.argv.includes('--dry-run')
const args = ['publish', ...(dry ? ['--dry-run'] : []), '--access', 'public']
console.log(`[publish] npm ${args.join(' ')} (cwd=${pluginDir})`)
execFileSync('npm', args, { cwd: pluginDir, stdio: 'inherit' })
