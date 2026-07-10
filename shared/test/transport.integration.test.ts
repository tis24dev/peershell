/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/**
 * End-to-end wire test: two WebSocketTransport instances talk through the throwaway dev relay,
 * exercising the full Stage 1-3 handshake (hello -> create/join -> PIN challenge-response ->
 * snapshot-ack barrier -> output/input binary frames). Uses the `ws` package as the injected
 * WebSocket implementation for Node.
 */
import WebSocket from 'ws'
import { WebSocketTransport, WebSocketCtor } from '../src/websocketTransport'
import { Channel } from '../src/protocol'
import { hashPin, verifyPin, generateNonce } from '../src/pinAuth'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startRelay } = require('../../server/src/index.cjs') as {
    startRelay: (port?: number, opts?: any) => Promise<{ port: number, url: string, close: () => Promise<void> }>
}

const WS = WebSocket as unknown as WebSocketCtor
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

let relay: { url: string, close: () => Promise<void> }

beforeAll(async () => {
    relay = await startRelay(0, { requireAuth: false })
})

afterAll(async () => {
    await relay.close()
})

async function connectPair() {
    const host = new WebSocketTransport(WS)
    const guest = new WebSocketTransport(WS)
    await host.connect(relay.url)
    await guest.connect(relay.url)
    return { host, guest }
}

it('mirrors output and injects input across the relay after a correct PIN', async () => {
    const { host, guest } = await connectPair()
    const PIN = '135790'
    let hostNonce = ''

    const done = new Promise<{ output: string, input: string }>(resolve => {
        let output = ''

        host.onControl(m => {
            if (m.t === 'session-created') {
                guest.sendControl({ t: 'hello', role: 'guest', kind: 'web' })
                guest.sendControl({ t: 'join', room: m.room })
            } else if (m.t === 'peer-joined') {
                hostNonce = generateNonce()
                host.sendControl({ t: 'pin-challenge', nonce: hostNonce })
            } else if (m.t === 'pin-response') {
                void verifyPin(PIN, hostNonce, m.hash).then(ok => {
                    expect(ok).toBe(true)
                    host.sendControl({ t: 'pin-ok' })
                    host.sendControl({ t: 'snapshot', cols: 80, rows: 24, data: '' })
                })
            } else if (m.t === 'snapshot-ack') {
                host.sendData(0, Channel.Output, enc('hello from host\r\n'))
            }
        })
        host.onBinary(f => {
            if (f.channel === Channel.Input) {
                resolve({ output, input: dec(f.data) })
            }
        })

        guest.onControl(m => {
            if (m.t === 'pin-challenge') {
                void hashPin(PIN, m.nonce).then(hash => guest.sendControl({ t: 'pin-response', hash }))
            } else if (m.t === 'snapshot') {
                guest.sendControl({ t: 'snapshot-ack' })
            }
        })
        guest.onBinary(f => {
            if (f.channel === Channel.Output) {
                output = dec(f.data)
                guest.sendData(0, Channel.Input, enc('ls\n'))
            }
        })
    })

    host.sendControl({ t: 'hello', role: 'host', kind: 'desktop' })
    host.sendControl({ t: 'create-session' })

    const result = await done
    expect(result.output).toBe('hello from host\r\n')
    expect(result.input).toBe('ls\n')

    host.close()
    guest.close()
}, 15000)

it('rejects a wrong PIN with pin-fail', async () => {
    const { host, guest } = await connectPair()
    const CORRECT = '111111'
    const WRONG = '999999'
    let hostNonce = ''

    const failed = new Promise<boolean>(resolve => {
        host.onControl(m => {
            if (m.t === 'session-created') {
                guest.sendControl({ t: 'hello', role: 'guest', kind: 'web' })
                guest.sendControl({ t: 'join', room: m.room })
            } else if (m.t === 'peer-joined') {
                hostNonce = generateNonce()
                host.sendControl({ t: 'pin-challenge', nonce: hostNonce })
            } else if (m.t === 'pin-response') {
                void verifyPin(CORRECT, hostNonce, m.hash).then(ok => {
                    host.sendControl(ok ? { t: 'pin-ok' } : { t: 'pin-fail', left: 4 })
                })
            }
        })
        guest.onControl(m => {
            if (m.t === 'pin-challenge') {
                void hashPin(WRONG, m.nonce).then(hash => guest.sendControl({ t: 'pin-response', hash }))
            } else if (m.t === 'pin-fail') {
                resolve(true)
            } else if (m.t === 'pin-ok') {
                resolve(false)
            }
        })
    })

    host.sendControl({ t: 'hello', role: 'host', kind: 'desktop' })
    host.sendControl({ t: 'create-session' })

    expect(await failed).toBe(true)
    host.close()
    guest.close()
}, 15000)
