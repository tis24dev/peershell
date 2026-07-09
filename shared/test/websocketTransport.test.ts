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

it('ignores late events from a socket superseded by a reconnect', async () => {
    jest.useFakeTimers()
    const transport = new WebSocketTransport(WS)
    const states: string[] = []
    const controls: string[] = []
    transport.onState(s => states.push(s))
    transport.onControl(m => controls.push(m.t))

    // First connection opens, then the socket drops.
    const p1 = transport.connect('ws://x')
    const first = last
    first.onopen?.(null)
    await p1
    const staleClose = first.onclose // capture before the reconnect detaches it
    const staleMsg = first.onmessage
    first.onclose?.(null)

    // Reconnect on the SAME transport: a brand-new socket supersedes the first.
    const p2 = transport.connect('ws://x')
    expect(last).not.toBe(first)
    last.onopen?.(null)
    await p2

    const stateCount = states.length
    // A late close/message from the OLD socket must not drive the new transport.
    staleClose?.(null)
    staleMsg?.({ data: encodeControl({ t: 'pin-ok' }) })
    expect(states.length).toBe(stateCount)
    expect(controls).toEqual([])
})

it('a socket rejected before it opens cannot deliver a late message', async () => {
    jest.useFakeTimers()
    const transport = new WebSocketTransport(WS)
    const controls: string[] = []
    transport.onControl(m => controls.push(m.t))
    const p = transport.connect('ws://x')
    const staleMsg = last.onmessage // capture before the reject detaches it
    last.onclose?.(null) // reject before open
    await expect(p).rejects.toThrow(/closed during connect/)
    // The rejected socket is severed, so a late frame from it must not reach the app.
    staleMsg?.({ data: encodeControl({ t: 'pin-ok' }) })
    expect(controls).toEqual([])
})
