/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/**
 * Guest side of a shared session. Framework-neutral (drives a SessionTransport + a small MirrorSink
 * port + a PIN provider), so it is reused by the Tabby plugin (via MirrorSession) and the web-client
 * (and future mobile). PIN/render/input logic lives here once.
 *
 * Flow: join -> answer the host's PIN challenge -> on pin-ok, render the snapshot then ack it
 * (barrier) -> render live output, forward the guest's keystrokes.
 */
import { Channel, ClientKind, SINGLE_PEER, ControlMessage } from './protocol'
import { SessionTransport } from './api'
import { base64ToBytes } from './base64'
import { hashPin } from './pinAuth'

/** Port the controller drives on the guest terminal (adapted from a Tabby session or an xterm). */
export interface MirrorSink {
    emit(data: Uint8Array): void
    hostResize(cols: number, rows: number): void
    ended(reason: string): void
}

/** Asks the user for the session PIN. Returns null if cancelled. */
export type PinProvider = () => Promise<string | null>

export class MirrorController {
    private readonly peerId = SINGLE_PEER
    private endedFlag = false

    constructor(
        private readonly transport: SessionTransport,
        private readonly sink: MirrorSink,
        private readonly pinProvider: PinProvider,
    ) {
        this.transport.onControl(m => this.onControl(m))
        this.transport.onBinary(f => {
            if (f.channel === Channel.Output) {
                this.sink.emit(f.data)
            }
        })
    }

    /**
     * Announce as a guest and join, either by `room` code (Tabby desktop) or opaque `token`
     * (browser magic-link). Handlers are wired in the ctor so no frame is missed.
     */
    join(target: { room?: string, token?: string, name?: string, kind?: ClientKind }): void {
        this.transport.sendControl({
            t: 'hello', role: 'guest', kind: target.kind ?? 'desktop', client: 'peershell',
        })
        this.transport.sendControl({ t: 'join', room: target.room, token: target.token, name: target.name })
    }

    private onControl(m: ControlMessage): void {
        switch (m.t) {
            case 'pin-challenge':
                this.answerPin(m.nonce).catch(() => this.end('pin verification failed'))
                break
            case 'pin-fail':
                if (m.left <= 0) {
                    this.end('wrong PIN')
                }
                // left > 0: the host re-challenges, which re-prompts.
                break
            case 'snapshot':
                this.sink.emit(base64ToBytes(m.data))
                this.sink.hostResize(m.cols, m.rows)
                this.transport.sendControl({ t: 'snapshot-ack' })
                break
            case 'resize':
                this.sink.hostResize(m.cols, m.rows)
                break
            case 'peer-left':
                this.end(m.reason ?? 'host ended the session')
                break
            case 'error':
                this.end(m.message ? `${m.code}: ${m.message}` : m.code)
                break
            default:
                break
        }
    }

    private async answerPin(nonce: string): Promise<void> {
        const pin = await this.pinProvider()
        if (!pin) {
            this.end('guest-closed')
            return
        }
        const hash = await hashPin(pin, nonce)
        this.transport.sendControl({ t: 'pin-response', hash })
    }

    /** Forward the guest's keystrokes to the host. */
    writeInput(data: Uint8Array): void {
        this.transport.sendData(this.peerId, Channel.Input, data)
    }

    private end(reason: string): void {
        if (this.endedFlag) {
            return
        }
        this.endedFlag = true
        // Notify the sink FIRST (the web client sets `stopped` in sink.ended, gating the reconnect
        // loop), THEN tear down the transport so its `closed` state does not re-arm a reconnect.
        this.sink.ended(reason)
        this.transport.close(1000, reason)
    }

    close(): void {
        // Mark the session ended so a control frame racing the tab-kill cannot re-enter end() and drive
        // sink.ended() on an already-torn-down guest.
        this.endedFlag = true
        this.transport.close(1000, 'guest-closed')
    }
}
