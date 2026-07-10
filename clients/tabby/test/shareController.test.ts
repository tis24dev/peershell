/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

import { Subject } from 'rxjs'
import {
    SessionTransport, ControlMessage, BinaryPayload, Channel, TransportState, base64ToUtf8, hashPin,
} from '@peershell/protocol'
import { ShareController, HostTerminal } from '../src/host/shareController'

const PIN = '135790'

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
    last<T extends ControlMessage['t']>(t: T): Extract<ControlMessage, { t: T }> | undefined {
        return [...this.sentControl].reverse().find(c => c.t === t) as never
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

async function respond(t: MockTransport, nonce: string, pin: string): Promise<void> {
    t.emitControl({ t: 'pin-response', hash: await hashPin(pin, nonce) })
}

it('gates on PIN (rate-limited), then mirrors output after snapshot-ack and injects input', async () => {
    const t = new MockTransport()
    const m = mockTab()
    const c = new ShareController(t, m.tab, PIN)

    await c.start('ws://relay')
    expect(t.controlTypes()).toEqual(['hello', 'create-session'])

    t.emitControl({ t: 'session-created', room: 'ABC234', magicLink: 'http://x/s/tok' })
    expect(c.room).toBe('ABC234')

    t.emitControl({ t: 'peer-joined', peerId: 0, kind: 'web' })
    const chal = t.last('pin-challenge')
    expect(chal).toBeTruthy()

    // Wrong PIN -> pin-fail{left:4} + a fresh challenge; input still rejected.
    await respond(t, chal!.nonce, '000000')
    await waitUntil(() => t.sentControl.some(x => x.t === 'pin-fail'))
    expect(t.last('pin-fail')!.left).toBe(4)
    t.emitBinary({ peerId: 0, channel: Channel.Input, data: new Uint8Array([1]) })
    expect(m.inputs).toHaveLength(0)

    // Correct PIN on the new challenge -> pin-ok + snapshot.
    await respond(t, t.last('pin-challenge')!.nonce, PIN)
    await waitUntil(() => t.sentControl.some(x => x.t === 'snapshot'))
    expect(t.sentControl.some(x => x.t === 'pin-ok')).toBe(true)
    expect(base64ToUtf8(t.last('snapshot')!.data)).toBe('SNAPSHOT')

    // Barrier: no output before ack.
    m.output$.next(new Uint8Array([9]))
    expect(t.sentData).toHaveLength(0)

    t.emitControl({ t: 'snapshot-ack' })
    m.output$.next(new Uint8Array([9, 9]))
    expect(t.sentData).toHaveLength(1)
    expect(Array.from(t.sentData[0].data)).toEqual([9, 9])

    // Authenticated: input now accepted.
    t.emitBinary({ peerId: 0, channel: Channel.Input, data: new Uint8Array([108, 115]) })
    expect(Array.from(m.inputs[0])).toEqual([108, 115])
})

it('kicks the peer after exhausting PIN attempts', async () => {
    const t = new MockTransport()
    const m = mockTab()
    const c = new ShareController(t, m.tab, PIN)
    await c.start('ws://relay')
    t.emitControl({ t: 'session-created', room: 'ABC234', magicLink: 'http://x' })
    t.emitControl({ t: 'peer-joined', peerId: 0, kind: 'web' })

    for (let i = 0; i < 5; i++) {
        await respond(t, t.last('pin-challenge')!.nonce, '999999')
        await waitUntil(() => t.sentControl.filter(x => x.t === 'pin-fail').length === i + 1)
    }
    expect(t.last('pin-fail')!.left).toBe(0)
    expect(t.sentControl.some(x => x.t === 'peer-left' && x.reason === 'pin-failed')).toBe(true)
    expect(c['authenticated']).toBe(false)
})

it('tears down on tab close', async () => {
    const t = new MockTransport()
    const m = mockTab()
    const c = new ShareController(t, m.tab, PIN)
    await c.start('ws://relay')
    t.emitControl({ t: 'session-created', room: 'ABC234', magicLink: 'http://x' })

    m.closed$.next()
    expect(t.closed).toBe(true)
    expect(t.controlTypes()).toEqual(expect.arrayContaining(['peer-left', 'session-close']))
})

it('re-join after peer-left does not stack duplicate output/resize forwarders', async () => {
    const t = new MockTransport()
    const m = mockTab()
    const c = new ShareController(t, m.tab, PIN)
    await c.start('ws://relay')
    t.emitControl({ t: 'session-created', room: 'ABC234', magicLink: 'http://x' })

    const joinAndStream = async (): Promise<void> => {
        const before = t.sentControl.filter(x => x.t === 'snapshot').length
        t.emitControl({ t: 'peer-joined', peerId: 0, kind: 'web' })
        await respond(t, t.last('pin-challenge')!.nonce, PIN)
        await waitUntil(() => t.sentControl.filter(x => x.t === 'snapshot').length > before)
        t.emitControl({ t: 'snapshot-ack' })
    }

    await joinAndStream()
    m.output$.next(new Uint8Array([1]))
    m.resize$.next({ cols: 90, rows: 30 })

    t.emitControl({ t: 'peer-left', reason: 'gone' })

    await joinAndStream() // fresh guest on the same controller (server keeps the host/room alive)
    m.output$.next(new Uint8Array([2]))
    m.resize$.next({ cols: 91, rows: 31 })

    // Regression (#1): exactly one Output frame per push (2 total), not doubled by a leaked sub.
    expect(t.sentData.filter(d => d.channel === Channel.Output)).toHaveLength(2)
    // The resize$ handler has no streaming guard, so a leaked sub would surface here first.
    expect(t.sentControl.filter(x => x.t === 'resize')).toHaveLength(2)
})
