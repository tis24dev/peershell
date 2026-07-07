import { Subject } from 'rxjs'
import {
    SessionTransport, ControlMessage, BinaryPayload, Channel, TransportState, base64ToUtf8,
} from '@peershell/protocol'
import { ShareController, HostTerminal } from '../src/host/shareController'

class MockTransport implements SessionTransport {
    sentControl: ControlMessage[] = []
    sentData: Array<{ peerId: number, channel: Channel, data: Uint8Array }> = []
    closed = false
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
    close(): void {
        this.closed = true
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
}

function mockTab() {
    const output$ = new Subject<Uint8Array>()
    const resize$ = new Subject<{ cols: number, rows: number }>()
    const closed$ = new Subject<void>()
    const inputs: Uint8Array[] = []
    const tab: HostTerminal = {
        output$,
        resize$,
        closed$,
        sendInput: d => inputs.push(d),
        getSize: () => ({ cols: 80, rows: 24 }),
        snapshot: () => 'SNAPSHOT',
    }
    return { tab, output$, resize$, closed$, inputs }
}

it('creates a session, then mirrors output only after snapshot-ack and injects input', async () => {
    const t = new MockTransport()
    const m = mockTab()
    const c = new ShareController(t, m.tab)

    await c.start('ws://relay')
    expect(t.controlTypes()).toEqual(['hello', 'create-session'])

    t.emitControl({ t: 'session-created', room: 'ABC234', magicLink: 'http://x/s/tok' })
    expect(c.room).toBe('ABC234')
    expect(c.magicLink).toBe('http://x/s/tok')

    t.emitControl({ t: 'peer-joined', peerId: 0, kind: 'web' })
    const snap = t.sentControl.find(x => x.t === 'snapshot')
    expect(snap && snap.t === 'snapshot' && base64ToUtf8(snap.data)).toBe('SNAPSHOT')

    // Barrier: no output before the guest acks the snapshot.
    m.output$.next(new Uint8Array([1, 2, 3]))
    expect(t.sentData.length).toBe(0)

    t.emitControl({ t: 'snapshot-ack' })
    m.output$.next(new Uint8Array([9, 9]))
    expect(t.sentData).toHaveLength(1)
    expect(t.sentData[0].channel).toBe(Channel.Output)
    expect(Array.from(t.sentData[0].data)).toEqual([9, 9])

    // Guest input frame is injected into the local terminal.
    t.emitBinary({ peerId: 0, channel: Channel.Input, data: new Uint8Array([108, 115]) })
    expect(m.inputs).toHaveLength(1)
    expect(Array.from(m.inputs[0])).toEqual([108, 115])

    // resize is forwarded as a control message.
    m.resize$.next({ cols: 120, rows: 40 })
    expect(t.sentControl.find(x => x.t === 'resize')).toEqual({ t: 'resize', cols: 120, rows: 40 })
})

it('tears down on tab close and stops forwarding', async () => {
    const t = new MockTransport()
    const m = mockTab()
    const c = new ShareController(t, m.tab)
    await c.start('ws://relay')
    t.emitControl({ t: 'session-created', room: 'ABC234', magicLink: 'http://x/s/tok' })
    t.emitControl({ t: 'peer-joined', peerId: 0, kind: 'desktop' })
    t.emitControl({ t: 'snapshot-ack' })

    m.closed$.next()
    expect(t.closed).toBe(true)
    expect(t.controlTypes()).toEqual(expect.arrayContaining(['peer-left', 'session-close']))

    const before = t.sentData.length
    m.output$.next(new Uint8Array([5]))
    expect(t.sentData.length).toBe(before)
})
