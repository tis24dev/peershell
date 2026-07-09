import {
    MirrorController, MirrorSink, PinProvider,
    SessionTransport, ControlMessage, BinaryPayload, Channel, TransportState, utf8ToBase64, hashPin,
} from '../src'

class MockTransport implements SessionTransport {
    sentControl: ControlMessage[] = []
    sentData: Array<{ peerId: number, channel: Channel, data: Uint8Array }> = []
    closed: { code?: number, reason?: string } | null = null
    private controlCb?: (m: ControlMessage) => void
    private binaryCb?: (f: BinaryPayload) => void

    connect(): Promise<void> {
        return Promise.resolve()
    }
    sendControl(m: ControlMessage): void {
        this.sentControl.push(m)
    }
    sendData(peerId: number, channel: Channel, data: Uint8Array): void {
        this.sentData.push({ peerId, channel, data })
    }
    close(code?: number, reason?: string): void {
        this.closed = { code, reason }
    }
    onControl(cb: (m: ControlMessage) => void): void {
        this.controlCb = cb
    }
    onBinary(cb: (f: BinaryPayload) => void): void {
        this.binaryCb = cb
    }
    onState(_cb: (s: TransportState) => void): void { /* unused */ }

    emitControl(m: ControlMessage): void {
        this.controlCb?.(m)
    }
    emitBinary(f: BinaryPayload): void {
        this.binaryCb?.(f)
    }
    controlTypes(): string[] {
        return this.sentControl.map(c => c.t)
    }
    last<T extends ControlMessage['t']>(t: T): Extract<ControlMessage, { t: T }> | undefined {
        return [...this.sentControl].reverse().find(c => c.t === t) as never
    }
}

function mockSink() {
    const emits: Uint8Array[] = []
    const resizes: Array<{ cols: number, rows: number }> = []
    let ended: string | null = null
    const sink: MirrorSink = {
        emit: d => emits.push(d),
        hostResize: (cols, rows) => resizes.push({ cols, rows }),
        ended: reason => { ended = reason },
    }
    return { sink, emits, resizes, getEnded: () => ended }
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const noPin: PinProvider = async () => null

function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            if (pred()) {
                clearInterval(iv)
                clearTimeout(to)
                resolve()
            }
        }, 5)
        const to = setTimeout(() => {
            clearInterval(iv)
            reject(new Error('waitUntil timeout'))
        }, ms)
    })
}

it('answers the PIN challenge with H(pin, nonce)', async () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink, async () => '424242')
    c.join({ room: 'ABC234' })
    expect(t.controlTypes()).toEqual(['hello', 'join'])

    t.emitControl({ t: 'pin-challenge', nonce: 'nonce-xyz' })
    await waitUntil(() => t.sentControl.some(x => x.t === 'pin-response'))
    expect(t.last('pin-response')!.hash).toBe(await hashPin('424242', 'nonce-xyz'))
})

it('renders + acks the snapshot, renders output, forwards input', () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink, noPin)
    c.join({ room: 'ABC234' })

    t.emitControl({ t: 'snapshot', cols: 100, rows: 30, data: utf8ToBase64('SNAP') })
    expect(dec(s.emits[0])).toBe('SNAP')
    expect(s.resizes[0]).toEqual({ cols: 100, rows: 30 })
    expect(t.controlTypes()).toContain('snapshot-ack')

    t.emitBinary({ peerId: 0, channel: Channel.Output, data: new Uint8Array([79, 75]) })
    expect(dec(s.emits[1])).toBe('OK')

    c.writeInput(new Uint8Array([108, 115]))
    expect(t.sentData[0].channel).toBe(Channel.Input)
    expect(Array.from(t.sentData[0].data)).toEqual([108, 115])
})

it('ends on pin-fail with no attempts left, but not while attempts remain', () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink, noPin)
    c.join({ room: 'ABC234' })

    t.emitControl({ t: 'pin-fail', left: 3 })
    expect(s.getEnded()).toBeNull()

    t.emitControl({ t: 'pin-fail', left: 0 })
    expect(s.getEnded()).toBe('wrong PIN')
})

it('surfaces a host resize and ends on peer-left (once)', () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink, noPin)
    c.join({ room: 'ABC234' })

    t.emitControl({ t: 'resize', cols: 132, rows: 43 })
    expect(s.resizes.at(-1)).toEqual({ cols: 132, rows: 43 })

    t.emitControl({ t: 'peer-left', reason: 'host-ended' })
    t.emitControl({ t: 'peer-left', reason: 'again' })
    expect(s.getEnded()).toBe('host-ended')
})

it('cancelling the PIN prompt ends the session AND tears down the transport', async () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink, noPin)
    c.join({ room: 'ABC234' })

    t.emitControl({ t: 'pin-challenge', nonce: 'n1' })
    await waitUntil(() => s.getEnded() !== null)
    // Regression (#8): cancel must fire sink.ended (so the guest UI stops re-prompting) ...
    expect(s.getEnded()).toBe('guest-closed')
    // ... and still close the transport (its prior behavior).
    expect(t.closed).not.toBeNull()
})

it('closes the transport whenever the session ends', () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink, noPin)
    c.join({ room: 'ABC234' })

    // Regression (#9): end() must also close the transport so the web client's socket + keepalive
    // do not leak until the server reaper reclaims them.
    t.emitControl({ t: 'peer-left', reason: 'host-ended' })
    expect(s.getEnded()).toBe('host-ended')
    expect(t.closed).not.toBeNull()
})
