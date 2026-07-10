/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// jest-environment-node (Node 18) does not expose the Web Crypto global; the real runtimes
// (browsers, Electron renderer, Node >= 20) do. Provide it for tests so pinAuth can run.
if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto
}
if (!globalThis.btoa) {
    globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64')
}
if (!globalThis.atob) {
    globalThis.atob = s => Buffer.from(s, 'base64').toString('binary')
}
