/**
 * End-to-end interop of the two real controllers through the throwaway relay: ShareController (host,
 * driving a mock terminal) <-> dev relay <-> MirrorController (guest, driving a mock sink). Verifies
 * the PIN handshake, snapshot delivery + ack barrier, live output host->guest, and input guest->host.
 */
import WebSocket from 'ws'
import { Subject } from 'rxjs'
import { WebSocketTransport, WebSocketCtor } from '@peershell/protocol'
import { ShareController, HostTerminal } from '../src/host/shareController'
import { MirrorController, MirrorSink } from '../src/guest/mirrorController'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startRelay } = require('../../../server/dev-relay.cjs') as {
    startRelay: (port?: number) => Promise<{ url: string, close: () => Promise<void> }>
}

const WS = WebSocket as unknown as WebSocketCtor
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const PIN = '246810'

function waitFor(pred: () => boolean, timeoutMs = 12000): Promise<void> {
    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            if (pred()) {
                clearInterval(iv)
                clearTimeout(to)
                resolve()
            }
        }, 10)
        const to = setTimeout(() => {
            clearInterval(iv)
            reject(new Error('waitFor timed out'))
        }, timeoutMs)
    })
}

let relay: { url: string, close: () => Promise<void> }
beforeAll(async () => { relay = await startRelay(0) })
afterAll(async () => { await relay.close() })

function hostTerminal(output$: Subject<Uint8Array>, inputs: Uint8Array[]): HostTerminal {
    return {
        output$,
        resize$: new Subject<{ cols: number, rows: number }>(),
        closed$: new Subject<void>(),
        sendInput: d => inputs.push(d),
        getSize: () => ({ cols: 111, rows: 33 }),
        snapshot: () => 'SNAPSHOT-VT',
    }
}

it('PIN handshake, then mirrors snapshot + live output host->guest and input guest->host', async () => {
    const hostTransport = new WebSocketTransport(WS)
    const guestTransport = new WebSocketTransport(WS)
    const output$ = new Subject<Uint8Array>()
    const inputs: Uint8Array[] = []

    const emits: Uint8Array[] = []
    let hostResize: { cols: number, rows: number } | null = null
    let sawLive = false
    const sink: MirrorSink = {
        emit: d => {
            emits.push(d)
            if (dec(d).includes('LIVE')) {
                sawLive = true
            }
        },
        hostResize: (cols, rows) => { hostResize = { cols, rows } },
        ended: () => { /* noop */ },
    }
    const guest = new MirrorController(guestTransport, sink, async () => PIN)
    const host = new ShareController(hostTransport, hostTerminal(output$, inputs), PIN, {
        onSession: ({ room }) => guest.join(room),
    })

    await guestTransport.connect(relay.url)
    await host.start(relay.url)

    const pump = setInterval(() => output$.next(enc('LIVE\r\n')), 15)
    await waitFor(() => sawLive)
    clearInterval(pump)

    guest.writeInput(enc('typed-by-guest\n'))
    await waitFor(() => inputs.some(i => dec(i).includes('typed-by-guest')))

    expect(dec(emits[0])).toBe('SNAPSHOT-VT')
    expect(hostResize).toEqual({ cols: 111, rows: 33 })
    expect(emits.some(e => dec(e).includes('LIVE'))).toBe(true)

    host.stop('done')
    guest.close()
}, 15000)

it('a wrong PIN never streams and ends the guest', async () => {
    const hostTransport = new WebSocketTransport(WS)
    const guestTransport = new WebSocketTransport(WS)
    const output$ = new Subject<Uint8Array>()
    const inputs: Uint8Array[] = []

    let endedReason: string | null = null
    const sink: MirrorSink = {
        emit: () => { /* should never receive a snapshot/output */ },
        hostResize: () => { /* noop */ },
        ended: reason => { endedReason = reason },
    }
    const guest = new MirrorController(guestTransport, sink, async () => 'wrong-pin')
    const host = new ShareController(hostTransport, hostTerminal(output$, inputs), PIN, {
        onSession: ({ room }) => guest.join(room),
    })

    await guestTransport.connect(relay.url)
    await host.start(relay.url)

    await waitFor(() => endedReason !== null)
    expect(endedReason).toBe('wrong PIN')

    host.stop('done')
    guest.close()
}, 15000)
