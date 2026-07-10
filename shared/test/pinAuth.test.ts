/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

import { hashPin, verifyPin, generateNonce, isAcceptablePin } from '../src/pinAuth'

describe('pinAuth challenge-response', () => {
    it('hash is deterministic and a 64-char hex digest', async () => {
        const h1 = await hashPin('123456', 'nonceA')
        const h2 = await hashPin('123456', 'nonceA')
        expect(h1).toBe(h2)
        expect(h1).toMatch(/^[0-9a-f]{64}$/)
    })

    it('a different nonce yields a different hash, and the raw PIN never appears in the hash', async () => {
        const h1 = await hashPin('123456', 'nonceA')
        const h2 = await hashPin('123456', 'nonceB')
        expect(h1).not.toBe(h2)
        expect(h1.includes('123456')).toBe(false)
    })

    it('verifyPin accepts the correct PIN and rejects a wrong one', async () => {
        const nonce = generateNonce()
        const hash = await hashPin('654321', nonce)
        expect(await verifyPin('654321', nonce, hash)).toBe(true)
        expect(await verifyPin('000000', nonce, hash)).toBe(false)
    })

    it('generateNonce is fresh 32-char hex', () => {
        const a = generateNonce()
        const b = generateNonce()
        expect(a).toMatch(/^[0-9a-f]{32}$/)
        expect(a).not.toBe(b)
    })

    it('isAcceptablePin enforces min length and digits', () => {
        expect(isAcceptablePin('12345')).toBe(false)
        expect(isAcceptablePin('123456')).toBe(true)
        expect(isAcceptablePin('abcdef')).toBe(false)
    })
})
