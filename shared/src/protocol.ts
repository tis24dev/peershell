/**
 * peershell wire protocol — control messages + binary terminal framing.
 * Framework-neutral (no Angular/RxJS/Node-Buffer). See PROTOCOL.md for the spec.
 */

export const PROTOCOL_VERSION = 1

/** Binary frame channel tags. */
export enum Channel {
    Output = 0x01, // host -> guest
    Input = 0x02, // guest -> host
}

/** Peer id used while only 1 host + 1 guest are supported. */
export const SINGLE_PEER = 0

// ---------------------------------------------------------------------------
// Control messages (JSON, sent as WebSocket TEXT frames)
// ---------------------------------------------------------------------------

export type Role = 'host' | 'guest'
export type ClientKind = 'desktop' | 'web' | 'mobile'

interface Base {
    v?: number
    peerId?: number
}

export type ControlMessage =
    | (Base & { t: 'hello', role: Role, kind?: ClientKind, client?: string })
    | (Base & { t: 'create-session' })
    | (Base & { t: 'session-created', room: string, magicLink: string })
    | (Base & { t: 'session-close' })
    | (Base & { t: 'join', room?: string, token?: string, name?: string })
    | (Base & { t: 'peer-joined', peerId: number, kind: ClientKind })
    | (Base & { t: 'peer-left', peerId?: number, reason?: string })
    | (Base & { t: 'error', code: string, message?: string })
    | (Base & { t: 'ping' })
    | (Base & { t: 'pong' })
    | (Base & { t: 'pin-challenge', nonce: string })
    | (Base & { t: 'pin-response', hash: string })
    | (Base & { t: 'pin-ok' })
    | (Base & { t: 'pin-fail', left: number })
    | (Base & { t: 'snapshot', cols: number, rows: number, data: string })
    | (Base & { t: 'snapshot-ack' })
    | (Base & { t: 'resize', cols: number, rows: number })
    | (Base & { t: 'http-get', reqId: string, path: string, headers?: Record<string, string> })
    | (Base & { t: 'http-response', reqId: string, status: number, headers?: Record<string, string>, bodyBase64: string })

export type ControlType = ControlMessage['t']

/** Serialize a control message to a JSON string (stamps the protocol version). */
export function encodeControl(msg: ControlMessage): string {
    return JSON.stringify({ ...msg, v: PROTOCOL_VERSION })
}

/** Parse a JSON control message. Throws on malformed JSON or missing `t`. */
export function decodeControl(text: string): ControlMessage {
    const obj = JSON.parse(text)
    if (typeof obj !== 'object' || obj === null || typeof obj.t !== 'string') {
        throw new Error('peershell: malformed control message')
    }
    return obj as ControlMessage
}

// ---------------------------------------------------------------------------
// Binary terminal frames (WebSocket BINARY frames)
//   [ peerId: uint32 BE ][ tag: uint8 ][ raw PTY bytes... ]
// ---------------------------------------------------------------------------

export const BINARY_HEADER_BYTES = 5

export interface BinaryFrame {
    peerId: number
    channel: Channel
    data: Uint8Array
}

/** Encode a terminal data frame. `data` is copied after the 5-byte header. */
export function encodeBinaryFrame(peerId: number, channel: Channel, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(BINARY_HEADER_BYTES + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, peerId >>> 0, false) // big-endian
    view.setUint8(4, channel)
    out.set(data, BINARY_HEADER_BYTES)
    return out
}

/** Decode a terminal data frame from an ArrayBuffer or Uint8Array. */
export function decodeBinaryFrame(input: ArrayBuffer | Uint8Array): BinaryFrame {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (bytes.length < BINARY_HEADER_BYTES) {
        throw new Error('peershell: binary frame too short')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const peerId = view.getUint32(0, false)
    const channel = view.getUint8(4) as Channel
    // slice() copies so callers can retain the payload independently of the socket buffer.
    const data = bytes.slice(BINARY_HEADER_BYTES)
    return { peerId, channel, data }
}
