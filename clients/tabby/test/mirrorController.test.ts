import {
    SessionTransport, ControlMessage, BinaryPayload, Channel, TransportState, utf8ToBase64,
} from '@peershell/protocol'
import { MirrorController, MirrorSink } from '../src/guest/mirrorController'

class MockTransport implements SessionTransport {
    sentControl: ControlMessage[] = []
    sentData: Array<{ peerId: number, channel: Channel, data: Uint8Array }> = []
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
    close(): void { /* noop */ }
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

it('joins, renders + acks the snapshot, renders output, and forwards input', () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink)

    c.join('ABC234')
    expect(t.controlTypes()).toEqual(['hello', 'join'])

    t.emitControl({ t: 'snapshot', cols: 100, rows: 30, data: utf8ToBase64('SNAP') })
    expect(dec(s.emits[0])).toBe('SNAP')
    expect(s.resizes[0]).toEqual({ cols: 100, rows: 30 })
    expect(t.controlTypes()).toContain('snapshot-ack')

    t.emitBinary({ peerId: 0, channel: Channel.Output, data: new Uint8Array([79, 75]) })
    expect(dec(s.emits[1])).toBe('OK')

    // input channel from host is ignored by the guest
    t.emitBinary({ peerId: 0, channel: Channel.Input, data: new Uint8Array([1]) })
    expect(s.emits).toHaveLength(2)

    c.writeInput(new Uint8Array([108, 115]))
    expect(t.sentData).toHaveLength(1)
    expect(t.sentData[0].channel).toBe(Channel.Input)
    expect(Array.from(t.sentData[0].data)).toEqual([108, 115])
})

it('surfaces a host resize and ends on peer-left (once)', () => {
    const t = new MockTransport()
    const s = mockSink()
    const c = new MirrorController(t, s.sink)
    c.join('ABC234')

    t.emitControl({ t: 'resize', cols: 132, rows: 43 })
    expect(s.resizes.at(-1)).toEqual({ cols: 132, rows: 43 })

    t.emitControl({ t: 'peer-left', reason: 'host-ended' })
    t.emitControl({ t: 'peer-left', reason: 'again' })
    expect(s.getEnded()).toBe('host-ended')
})
