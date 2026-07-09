/**
 * SessionTransport over a WebSocket. Framework-neutral: uses the global `WebSocket` by default
 * (Electron renderer + browsers), or an injected implementation (e.g. the `ws` package in Node tests).
 * A future WebRTC DataChannel transport can implement the same SessionTransport interface.
 */
import {
    ControlMessage, Channel, encodeControl, decodeControl, encodeBinaryFrame, decodeBinaryFrame,
} from './protocol'
import { SessionTransport, TransportState, BinaryPayload } from './api'
import { utf8ToBase64Url } from './base64'

/** Non-secret subprotocol the server echoes back; carries no credential. */
const AUTH_SENTINEL = 'peershell.v1'
/** Prefix for the credential-bearing subprotocol offered by the client. Never echoed by the server. */
const BEARER_PREFIX = 'peershell.bearer.'

/** Minimal browser-WebSocket surface we rely on (satisfied by DOM WebSocket and the `ws` package). */
export interface WebSocketLike {
    binaryType: string
    send(data: string | ArrayBufferView | ArrayBuffer): void
    close(code?: number, reason?: string): void
    onopen: ((ev: unknown) => void) | null
    onmessage: ((ev: { data: unknown }) => void) | null
    onclose: ((ev: unknown) => void) | null
    onerror: ((ev: unknown) => void) | null
}

export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike

const KEEPALIVE_INTERVAL_MS = 20000
/** Reject connect() if the handshake neither opens nor closes within this window (no silent hangs). */
const CONNECT_TIMEOUT_MS = 15000

function toUint8(data: unknown): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data)
    }
    if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    }
    throw new Error('peershell: unexpected binary message type')
}

export class WebSocketTransport implements SessionTransport {
    private ws: WebSocketLike | null = null
    private keepalive: ReturnType<typeof setInterval> | null = null
    private readonly WS: WebSocketCtor
    private readonly controlCbs: Array<(m: ControlMessage) => void> = []
    private readonly binaryCbs: Array<(f: BinaryPayload) => void> = []
    private readonly stateCbs: Array<(s: TransportState) => void> = []

    constructor(wsImpl?: WebSocketCtor) {
        const impl = wsImpl ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket
        if (!impl) {
            throw new Error('peershell: no WebSocket implementation available (inject one for Node)')
        }
        this.WS = impl
    }

    connect(url: string, token?: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.setState('connecting')
            // The credential rides in the Sec-WebSocket-Protocol handshake header (base64url), NOT the URL
            // query, so it never lands in reverse-proxy/access logs. The server echoes only AUTH_SENTINEL.
            const protocols = token ? [AUTH_SENTINEL, BEARER_PREFIX + utf8ToBase64Url(token)] : undefined
            let ws: WebSocketLike
            try {
                ws = protocols ? new this.WS(url, protocols) : new this.WS(url)
            } catch (err) {
                this.setState('closed')
                reject(err instanceof Error ? err : new Error(String(err)))
                return
            }
            ws.binaryType = 'arraybuffer'
            this.ws = ws
            // Settle the connect promise exactly once. Without this guard a close/error arriving before
            // open (or a silent hang) would leave connect() pending forever.
            let settled = false
            let timer: ReturnType<typeof setTimeout> | null = null
            const clear = (): void => {
                if (timer !== null) {
                    clearTimeout(timer)
                    timer = null
                }
            }
            ws.onopen = () => {
                if (settled) {
                    return
                }
                settled = true
                clear()
                this.setState('open')
                this.startKeepalive()
                resolve()
            }
            ws.onerror = () => {
                if (settled) {
                    return
                }
                settled = true
                clear()
                this.setState('closed')
                reject(new Error('peershell: WebSocket connection failed'))
            }
            ws.onclose = () => {
                if (!settled) {
                    settled = true
                    clear()
                    this.setState('closed')
                    reject(new Error('peershell: WebSocket closed during connect'))
                } else {
                    // Post-open close: normal teardown. setState('closed') stops the keepalive.
                    this.setState('closed')
                }
            }
            ws.onmessage = ev => this.dispatch(ev.data)
            timer = setTimeout(() => {
                if (settled) {
                    return
                }
                settled = true
                timer = null
                try {
                    ws.close()
                } catch { /* ignore */ }
                this.setState('closed')
                reject(new Error('peershell: WebSocket connect timed out'))
            }, CONNECT_TIMEOUT_MS)
            // Don't let a pending connect timeout hold a Node process (or test runner) open.
            const t = timer as unknown as { unref?: () => void }
            if (typeof t.unref === 'function') {
                t.unref()
            }
        })
    }

    private dispatch(data: unknown): void {
        if (typeof data === 'string') {
            let msg: ControlMessage
            try {
                msg = decodeControl(data)
            } catch {
                return // ignore malformed control frames
            }
            // Keepalive is handled at the transport layer and not surfaced to the app.
            if (msg.t === 'ping') {
                this.sendControl({ t: 'pong' })
                return
            }
            if (msg.t === 'pong') {
                return
            }
            for (const cb of this.controlCbs) {
                cb(msg)
            }
            return
        }
        let frame: BinaryPayload
        try {
            frame = decodeBinaryFrame(toUint8(data))
        } catch {
            return
        }
        for (const cb of this.binaryCbs) {
            cb(frame)
        }
    }

    sendControl(msg: ControlMessage): void {
        this.ws?.send(encodeControl(msg))
    }

    sendData(peerId: number, channel: Channel, data: Uint8Array): void {
        this.ws?.send(encodeBinaryFrame(peerId, channel, data))
    }

    close(code?: number, reason?: string): void {
        this.stopKeepalive()
        this.ws?.close(code, reason)
    }

    private startKeepalive(): void {
        this.stopKeepalive()
        this.keepalive = setInterval(() => this.sendControl({ t: 'ping' }), KEEPALIVE_INTERVAL_MS)
        // Don't keep a Node process (or test runner) alive just for keepalive.
        const timer = this.keepalive as unknown as { unref?: () => void }
        if (typeof timer.unref === 'function') {
            timer.unref()
        }
    }

    private stopKeepalive(): void {
        if (this.keepalive !== null) {
            clearInterval(this.keepalive)
            this.keepalive = null
        }
    }

    onControl(cb: (m: ControlMessage) => void): void {
        this.controlCbs.push(cb)
    }

    onBinary(cb: (f: BinaryPayload) => void): void {
        this.binaryCbs.push(cb)
    }

    onState(cb: (s: TransportState) => void): void {
        this.stateCbs.push(cb)
    }

    private setState(s: TransportState): void {
        if (s === 'closed') {
            this.stopKeepalive()
        }
        for (const cb of this.stateCbs) {
            cb(s)
        }
    }
}
