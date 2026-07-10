/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/**
 * Per-session PIN challenge-response. The raw PIN never crosses the wire: the host sends a
 * fresh single-use `nonce`, the peer replies with `H(pin, nonce)`, the host verifies locally.
 *
 * Uses Web Crypto (`globalThis.crypto`), available in browsers and Node >= 18.
 */

const MIN_PIN_LENGTH = 6

function toHex(bytes: Uint8Array): string {
    let out = ''
    for (const b of bytes) {
        out += b.toString(16).padStart(2, '0')
    }
    return out
}

/** A fresh, single-use nonce (hex). Generate a new one for every challenge. */
export function generateNonce(byteLength = 16): string {
    const arr = new Uint8Array(byteLength)
    globalThis.crypto.getRandomValues(arr)
    return toHex(arr)
}

/** A random numeric PIN (default 6 digits) for a share. Kept local; never sent in cleartext. */
export function generatePin(digits = 6): string {
    // Rejection sampling: reject the top slice of the 2^32 range that does not divide evenly by
    // `max`, so every PIN is equiprobable (plain `% max` would bias the low codes).
    const max = 10 ** digits
    const limit = Math.floor(0x100000000 / max) * max
    const arr = new Uint32Array(1)
    do {
        globalThis.crypto.getRandomValues(arr)
    } while (arr[0] >= limit)
    return (arr[0] % max).toString().padStart(digits, '0')
}

/** `H(pin, nonce)` as a hex string (SHA-256 over `nonce:pin`). */
export async function hashPin(pin: string, nonce: string): Promise<string> {
    const data = new TextEncoder().encode(`${nonce}:${pin}`)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
    return toHex(new Uint8Array(digest))
}

/** Constant-time-ish comparison of two equal-length hex strings. */
function safeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false
    }
    let diff = 0
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return diff === 0
}

/** Verify a peer's `pin-response` hash against the expected `H(pin, nonce)`. */
export async function verifyPin(pin: string, nonce: string, responseHash: string): Promise<boolean> {
    const expected = await hashPin(pin, nonce)
    return safeEqualHex(expected, responseHash)
}

/** Basic PIN policy check (min length, digits). Callers should also rate-limit attempts. */
export function isAcceptablePin(pin: string): boolean {
    return pin.length >= MIN_PIN_LENGTH && /^[0-9]+$/.test(pin)
}
