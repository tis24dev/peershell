/**
 * SessionTransport over a WebSocket. Framework-neutral: uses the global `WebSocket` by default
 * (Electron renderer + browsers), or an injected implementation (e.g. the `ws` package in Node tests).
 * A future WebRTC DataChannel transport can implement the same SessionTransport interface.
 */
import {
    ControlMessage, Channel, encodeControl, decodeControl, encodeBinaryFrame, decodeBinaryFrame,
} from './protocol'
import { SessionTransport, TransportState, BinaryPayload } from './api'

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

export type WebSocketCtor = new (url: string) => WebSocketLike

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
    private state: TransportState = 'closed'
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
            const full = token
                ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
                : url
            let ws: WebSocketLike
            try {
                ws = new this.WS(full)
            } catch (err) {
                this.setState('closed')
                reject(err instanceof Error ? err : new Error(String(err)))
                return
            }
            ws.binaryType = 'arraybuffer'
            this.ws = ws
            ws.onopen = () => {
                this.setState('open')
                resolve()
            }
            ws.onerror = () => {
                if (this.state === 'connecting') {
                    reject(new Error('peershell: WebSocket connection failed'))
                }
            }
            ws.onclose = () => this.setState('closed')
            ws.onmessage = ev => this.dispatch(ev.data)
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
        this.ws?.close(code, reason)
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
        this.state = s
        for (const cb of this.stateCbs) {
            cb(s)
        }
    }
}
