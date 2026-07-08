/**
 * Reverse HTTP tunnel end-to-end: a Node HTTP client GETs the host's magic-link on the relay; the
 * relay forwards http-get down the host's outbound WS; the host's HttpTunnelHandler serves the
 * embedded page; the body comes back to the HTTP client. No browser needed.
 */
import * as http from 'http'
import WebSocket from 'ws'
import { WebSocketTransport, WebSocketCtor, HttpTunnelHandler } from '../src'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startRelay } = require('../../server/src/index.cjs') as {
    startRelay: (port?: number) => Promise<{ url: string, close: () => Promise<void> }>
}

const WS = WebSocket as unknown as WebSocketCtor
const HTML = '<!doctype html><title>peershell web-client</title><body>hi</body>'

function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
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

function httpGet(url: string): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = ''
            res.setEncoding('utf-8')
            res.on('data', c => { body += c })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }).on('error', reject)
    })
}

let relay: { url: string, close: () => Promise<void> }
beforeAll(async () => { relay = await startRelay(0) })
afterAll(async () => { await relay.close() })

it('serves the host-embedded web-client page over the tunnel', async () => {
    const hostTransport = new WebSocketTransport(WS)
    let magicLink = ''
    hostTransport.onControl(m => {
        if (m.t === 'session-created') {
            magicLink = m.magicLink
        }
    })
    // eslint-disable-next-line no-new
    new HttpTunnelHandler(hostTransport, () => HTML)

    await hostTransport.connect(relay.url)
    hostTransport.sendControl({ t: 'hello', role: 'host', kind: 'desktop' })
    hostTransport.sendControl({ t: 'create-session' })
    await waitFor(() => magicLink !== '')

    const res = await httpGet(magicLink)
    expect(res.status).toBe(200)
    expect(res.body).toBe(HTML)

    hostTransport.close()
}, 15000)
