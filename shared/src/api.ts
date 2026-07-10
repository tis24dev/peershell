/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/**
 * Transport abstraction + small shared validators. The transport is framework-neutral (callback
 * based); the Tabby plugin adapts it to RxJS internally, the web/mobile clients use it directly.
 * A future WebRTC DataChannel transport implements the same interface.
 */
import { ControlMessage, Channel } from './protocol'

export type TransportState = 'connecting' | 'open' | 'closed'

export interface BinaryPayload {
    peerId: number
    channel: Channel
    data: Uint8Array
}

export interface SessionTransport {
    connect(url: string, token?: string): Promise<void>
    sendControl(msg: ControlMessage): void
    sendData(peerId: number, channel: Channel, data: Uint8Array): void
    close(code?: number, reason?: string): void

    onControl(cb: (msg: ControlMessage) => void): void
    onBinary(cb: (frame: BinaryPayload) => void): void
    onState(cb: (state: TransportState) => void): void
}

// --- validators -----------------------------------------------------------

/** Crockford base32 (minus ambiguous chars), 6-10 chars. */
export const ROOM_CODE_RE = /^[2-9A-HJ-NP-Z]{6,10}$/

export function isValidRoomCode(code: string): boolean {
    return ROOM_CODE_RE.test(code.toUpperCase())
}

export function normalizeRoomCode(code: string): string {
    return code.trim().toUpperCase()
}

/** Opaque magic-link/session token: url-safe, reasonable length bounds. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

export function isValidToken(token: string): boolean {
    return TOKEN_RE.test(token)
}

/**
 * Whitelist for the reverse HTTP tunnel: the host only ever serves the embedded web-client page.
 * Rejects traversal/SSRF. URL-decode is applied before checking.
 */
export function isAllowedTunnelPath(rawPath: string): boolean {
    let path: string
    try {
        path = decodeURIComponent(rawPath)
    } catch {
        return false
    }
    if (path.includes('..') || path.includes('\0')) {
        return false
    }
    if (/^[a-z]+:\/\//i.test(path)) {
        return false
    }
    return path === '/' || path === '/index.html'
}
