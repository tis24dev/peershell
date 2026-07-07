// Stage 0 smoke test: load the built UMD bundle the way Tabby would (nodeRequire), with the
// externalized host packages stubbed, and instantiate the default NgModule. Confirms the bundle
// is valid, @peershell/protocol is inlined, and the plugin constructs (logs) without a real Tabby.
// Full GUI verification happens by loading dist/ into a real Tabby (see README).
const Module = require('module')
const path = require('path')

const stubs = {
    '@angular/core': { NgModule: () => target => target },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request]
    }
    return origLoad.call(this, request, parent, isMain)
}

const bundle = require(path.resolve(__dirname, '..', 'dist', 'index.js'))
const PluginModule = bundle.default || bundle

if (typeof PluginModule !== 'function') {
    console.error('FAIL: default export is not a class/function:', typeof PluginModule)
    process.exit(1)
}

// Instantiating triggers the module constructor's console.log.
const instance = new PluginModule()
if (!instance) {
    console.error('FAIL: could not instantiate the plugin module')
    process.exit(1)
}

console.log('PASS: bundle loaded and PeershellModule instantiated:', PluginModule.name || '(anonymous)')
