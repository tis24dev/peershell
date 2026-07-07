/**
 * End-to-end interop of the two real controllers through the throwaway relay: ShareController (host,
 * driving a mock terminal) <-> dev relay <-> MirrorController (guest, driving a mock sink). Verifies
 * snapshot delivery + ack barrier, live output host->guest, and input guest->host.
 */
import WebSocket from 'ws'
import { Subject } from 'rxjs'
import { WebSocketTransport, WebSocketCtor } from '@peershell/protocol'
import { ShareController, HostTerminal } from '../src/host/shareController'
import { MirrorController } from '../src/guest/mirrorController'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startRelay } = require('../../../server/dev-relay.cjs') as {
    startRelay: (port?: number) => Promise<{ url: string, close: () => Promise<void> }>
}

const WS = WebSocket as unknown as WebSocketCtor
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

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

it('mirrors snapshot + live output host->guest and input guest->host', async () => {
    const hostTransport = new WebSocketTransport(WS)
    const guestTransport = new WebSocketTransport(WS)

    const output$ = new Subject<Uint8Array>()
    const inputs: Uint8Array[] = []
    const hostTab: HostTerminal = {
        output$,
        resize$: new Subject<{ cols: number, rows: number }>(),
        closed$: new Subject<void>(),
        sendInput: d => inputs.push(d),
        getSize: () => ({ cols: 111, rows: 33 }),
        snapshot: () => 'SNAPSHOT-VT',
    }

    const emits: Uint8Array[] = []
    let hostResize: { cols: number, rows: number } | null = null
    let sawLive = false
    const guest = new MirrorController(guestTransport, {
        emit: d => {
            emits.push(d)
            if (dec(d).includes('LIVE')) {
                sawLive = true
            }
        },
        hostResize: (cols, rows) => { hostResize = { cols, rows } },
        ended: () => { /* noop */ },
    })

    const host = new ShareController(hostTransport, hostTab, {
        onSession: ({ room }) => guest.join(room),
    })

    await guestTransport.connect(relay.url)
    await host.start(relay.url)

    // Keep emitting host output until the guest has received a live frame (survives the ack round-trip).
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
