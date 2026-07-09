// Stage 0+ smoke test: load the built UMD bundle the way Tabby would (nodeRequire) with the
// externalized host packages (@angular, tabby-*, rxjs, ...) generically stubbed, and instantiate
// the default NgModule. Confirms the bundle is valid, @peershell/protocol is inlined, decorators
// apply, and the plugin constructs (logs) without a real Tabby. Full GUI verification happens by
// loading dist/ into a real Tabby (see README).
const Module = require('module')
const path = require('path')

// A generic stub: any property access yields another stub; calling it (decorator factory) returns
// an identity decorator; `new`-ing it or `extends`-ing it works.
function makeStub() {
    const f = function () {}
    return new Proxy(f, {
        get: (_t, p) => (typeof p === 'symbol' ? undefined : makeStub()),
        apply: () => (target) => target,
        construct: () => ({}),
    })
}

const EXTERNAL_PREFIXES = ['@angular/', 'tabby-', 'rxjs', 'ngx-toastr', '@ng-bootstrap']
const isExternal = req => EXTERNAL_PREFIXES.some(p => req === p || req.startsWith(p))

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (isExternal(request)) {
        return makeStub()
    }
    return origLoad.call(this, request, parent, isMain)
}

const bundle = require(path.resolve(__dirname, '..', 'dist', 'index.js'))
const PluginModule = bundle.default || bundle

if (typeof PluginModule !== 'function') {
    console.error('FAIL: default export is not a class/function:', typeof PluginModule)
    process.exit(1)
}

const instance = new PluginModule()
if (!instance) {
    console.error('FAIL: could not instantiate the plugin module')
    process.exit(1)
}

console.log('PASS: bundle loaded and PeershellModule instantiated:', PluginModule.name || '(anonymous)')
