import { WebSocketTransport, WebSocketCtor, WebSocketLike } from '../src/websocketTransport'
import { encodeControl, encodeBinaryFrame, Channel } from '../src/protocol'

let last: FakeWS

class FakeWS implements WebSocketLike {
    binaryType = ''
    sent: Array<string | ArrayBufferView | ArrayBuffer> = []
    closed = false
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null

    constructor(public url: string) {
        last = this
    }
    send(data: string | ArrayBufferView | ArrayBuffer): void {
        this.sent.push(data)
    }
    close(): void {
        this.closed = true
        this.onclose?.(null)
    }
    sentControlTypes(): string[] {
        return this.sent
            .filter((d): d is string => typeof d === 'string')
            .map(d => JSON.parse(d).t)
    }
}

const WS = FakeWS as unknown as WebSocketCtor

async function connected() {
    const transport = new WebSocketTransport(WS)
    const p = transport.connect('ws://x')
    last.onopen?.(null)
    await p
    return transport
}

afterEach(() => jest.useRealTimers())

it('routes text -> control and arraybuffer -> binary', async () => {
    jest.useFakeTimers()
    const transport = await connected()
    const controls: string[] = []
    const bins: Array<{ channel: Channel, data: number[] }> = []
    transport.onControl(m => controls.push(m.t))
    transport.onBinary(f => bins.push({ channel: f.channel, data: Array.from(f.data) }))

    last.onmessage?.({ data: encodeControl({ t: 'pin-ok' }) })
    const frame = encodeBinaryFrame(0, Channel.Output, new Uint8Array([1, 2, 3]))
    last.onmessage?.({ data: frame.buffer })

    expect(controls).toEqual(['pin-ok'])
    expect(bins).toEqual([{ channel: Channel.Output, data: [1, 2, 3] }])
})

it('sends a ping every 20s and answers an incoming ping with pong (both handled below the app)', async () => {
    jest.useFakeTimers()
    const transport = await connected()
    const appControls: string[] = []
    transport.onControl(m => appControls.push(m.t))

    jest.advanceTimersByTime(20000)
    expect(last.sentControlTypes()).toContain('ping')

    last.onmessage?.({ data: encodeControl({ t: 'ping' }) })
    expect(last.sentControlTypes()).toContain('pong')

    // ping/pong are not surfaced to the application
    last.onmessage?.({ data: encodeControl({ t: 'pong' }) })
    expect(appControls).toEqual([])
})

it('stops the keepalive timer on close', async () => {
    jest.useFakeTimers()
    const transport = await connected()
    transport.close()
    const before = last.sent.length
    jest.advanceTimersByTime(60000)
    expect(last.sent.length).toBe(before)
})

it('rejects connect() if the socket closes before it opens (does not hang)', async () => {
    jest.useFakeTimers()
    const transport = new WebSocketTransport(WS)
    const p = transport.connect('ws://x')
    last.onclose?.(null)
    await expect(p).rejects.toThrow(/closed during connect/)
})

it('rejects connect() if the handshake times out (does not hang)', async () => {
    jest.useFakeTimers()
    const transport = new WebSocketTransport(WS)
    const p = transport.connect('ws://x')
    jest.advanceTimersByTime(15000)
    await expect(p).rejects.toThrow(/timed out/)
    expect(last.closed).toBe(true)
})
