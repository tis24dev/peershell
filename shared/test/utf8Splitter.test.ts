import { Utf8Splitter } from '../src/utf8Splitter'
import { isValidRoomCode, isAllowedTunnelPath } from '../src/api'

describe('Utf8Splitter', () => {
    it('reassembles multibyte codepoints split one byte at a time', () => {
        const full = 'aé🚀z' // 'é' = 2 bytes, '🚀' = 4 bytes
        const bytes = new TextEncoder().encode(full)
        const s = new Utf8Splitter()
        let out = ''
        for (const b of bytes) {
            out += s.write(new Uint8Array([b]))
        }
        out += s.flush()
        expect(out).toBe(full)
        expect(out.includes('�')).toBe(false)
    })

    it('passes ASCII straight through', () => {
        const s = new Utf8Splitter()
        expect(s.write(new TextEncoder().encode('hello'))).toBe('hello')
    })
})

describe('validators', () => {
    it('accepts valid room codes and rejects ambiguous chars', () => {
        expect(isValidRoomCode('ABC234')).toBe(true)
        expect(isValidRoomCode('abc234')).toBe(true) // normalized to upper
        expect(isValidRoomCode('ABC01O')).toBe(false) // 0/1/O excluded
        expect(isValidRoomCode('SHORT')).toBe(false) // < 6
    })

    it('tunnel path whitelist rejects traversal/SSRF', () => {
        expect(isAllowedTunnelPath('/')).toBe(true)
        expect(isAllowedTunnelPath('/index.html')).toBe(true)
        expect(isAllowedTunnelPath('/../../etc/passwd')).toBe(false)
        expect(isAllowedTunnelPath('/%2e%2e/%2e%2e/etc/passwd')).toBe(false)
        expect(isAllowedTunnelPath('http://169.254.169.254/')).toBe(false)
        expect(isAllowedTunnelPath('/secret')).toBe(false)
    })
})
