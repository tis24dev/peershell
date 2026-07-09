// Stage the loadable Tabby plugin (package.json + built dist/) and zip it to
// tabby-peershell.zip at the repo root. The web-client HTML is bundled into
// dist/index.js at build time, so only package.json + dist/ are needed.
// Uses python3 for the zip (the `zip` CLI is not present everywhere).
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const tabby = path.join(root, 'clients', 'tabby')
const distIndex = path.join(tabby, 'dist', 'index.js')
if (!existsSync(distIndex)) {
    throw new Error('build first: clients/tabby/dist/index.js missing (run `npm run build:all`)')
}

const stage = path.join(root, 'build')
const pkgDir = path.join(stage, 'tabby-peershell')
rmSync(stage, { recursive: true, force: true })
mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })

copyFileSync(path.join(tabby, 'package.json'), path.join(pkgDir, 'package.json'))
copyFileSync(distIndex, path.join(pkgDir, 'dist', 'index.js'))
const map = path.join(tabby, 'dist', 'index.js.map')
if (existsSync(map)) {
    copyFileSync(map, path.join(pkgDir, 'dist', 'index.js.map'))
}

const outBase = path.join(root, 'tabby-peershell')
rmSync(`${outBase}.zip`, { force: true })
execFileSync('python3', ['-c', `import shutil;shutil.make_archive(${JSON.stringify(outBase)},'zip',${JSON.stringify(stage)})`], { stdio: 'inherit' })
console.log(`packaged ${outBase}.zip`)
