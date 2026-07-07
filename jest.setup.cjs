// jest-environment-node (Node 18) does not expose the Web Crypto global; the real runtimes
// (browsers, Electron renderer, Node >= 20) do. Provide it for tests so pinAuth can run.
if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto
}
