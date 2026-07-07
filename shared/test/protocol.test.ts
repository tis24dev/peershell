import {
    encodeBinaryFrame, decodeBinaryFrame, Channel, BINARY_HEADER_BYTES,
    encodeControl, decodeControl, PROTOCOL_VERSION,
} from '../src/protocol'

describe('binary framing', () => {
    it('round-trips peerId, channel and payload', () => {
        const data = new Uint8Array([0, 1, 2, 255, 128])
        const frame = encodeBinaryFrame(0x01020304, Channel.Output, data)
        expect(frame.length).toBe(BINARY_HEADER_BYTES + data.length)
        const d = decodeBinaryFrame(frame)
        expect(d.peerId).toBe(0x01020304)
        expect(d.channel).toBe(Channel.Output)
        expect(Array.from(d.data)).toEqual(Array.from(data))
    })

    it('preserves a large peerId (uint32) big-endian', () => {
        const d = decodeBinaryFrame(encodeBinaryFrame(0xffffffff, Channel.Input, new Uint8Array([9])))
        expect(d.peerId).toBe(0xffffffff)
    })

    it('handles input channel and empty payload (from ArrayBuffer)', () => {
        const f = encodeBinaryFrame(0, Channel.Input, new Uint8Array())
        const d = decodeBinaryFrame(f.buffer)
        expect(d.channel).toBe(Channel.Input)
        expect(d.peerId).toBe(0)
        expect(d.data.length).toBe(0)
    })

    it('throws on a too-short frame', () => {
        expect(() => decodeBinaryFrame(new Uint8Array([1, 2]))).toThrow()
    })
})

describe('control messages', () => {
    it('stamps the protocol version and round-trips', () => {
        const s = encodeControl({ t: 'pin-challenge', nonce: 'abc' })
        expect(JSON.parse(s).v).toBe(PROTOCOL_VERSION)
        const m = decodeControl(s)
        expect(m.t).toBe('pin-challenge')
        if (m.t === 'pin-challenge') {
            expect(m.nonce).toBe('abc')
        }
    })

    it('rejects malformed messages', () => {
        expect(() => decodeControl('not json')).toThrow()
        expect(() => decodeControl('{"x":1}')).toThrow()
    })
})
