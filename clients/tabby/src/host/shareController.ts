/**
 * Host side of a shared session. Deliberately Tabby-agnostic: it drives a SessionTransport and a
 * small HostTerminal port, so it is fully unit-testable with mocks. PeershellService adapts a real
 * Tabby BaseTerminalTabComponent to HostTerminal.
 *
 * Flow: connect -> create session -> guest joins -> PIN challenge-response (rate-limited) -> on
 * pin-ok send the snapshot, wait for snapshot-ack (barrier), then mirror output and inject input.
 * Input frames are ignored until the guest is authenticated.
 */
import { Observable, Subscription } from 'rxjs'
import {
    SessionTransport, ControlMessage, Channel, SINGLE_PEER, utf8ToBase64,
    generateNonce, verifyPin,
} from '@peershell/protocol'

const MAX_PIN_ATTEMPTS = 5

/** Port the controller needs from the host terminal (adapted from Tabby's tab). */
export interface HostTerminal {
    readonly output$: Observable<Uint8Array>
    sendInput(data: Uint8Array): void
    getSize(): { cols: number, rows: number }
    readonly resize$: Observable<{ cols: number, rows: number }>
    snapshot(): string
    readonly closed$: Observable<void>
}

export interface ShareHandle { room: string, magicLink: string }

export interface ShareHooks {
    onSession?: (h: ShareHandle) => void
    onPeerJoined?: () => void
    onAuthenticated?: () => void
    onPinFailed?: () => void
    onPeerLeft?: (reason?: string) => void
    onError?: (code: string, message?: string) => void
}

export class ShareController {
    room: string | null = null
    magicLink: string | null = null

    private subs = new Subscription()
    private streaming = false
    private authenticated = false
    private peerId = SINGLE_PEER
    private stopped = false
    private nonce = ''
    private attemptsLeft = MAX_PIN_ATTEMPTS

    constructor(
        private readonly transport: SessionTransport,
        private readonly tab: HostTerminal,
        private readonly pin: string,
        private readonly hooks: ShareHooks = {},
    ) {}

    async start(serverUrl: string, token?: string): Promise<void> {
        this.transport.onControl(m => this.onControl(m))
        this.transport.onBinary(f => {
            // Reject any input until the guest has passed the PIN.
            if (f.channel === Channel.Input && this.authenticated) {
                this.tab.sendInput(f.data)
            }
        })
        this.subs.add(this.tab.closed$.subscribe(() => this.stop('host-ended')))

        await this.transport.connect(serverUrl, token)
        this.transport.sendControl({ t: 'hello', role: 'host', kind: 'desktop', client: 'tabby-peershell' })
        this.transport.sendControl({ t: 'create-session' })
    }

    private onControl(m: ControlMessage): void {
        switch (m.t) {
            case 'session-created':
                this.room = m.room
                this.magicLink = m.magicLink
                this.hooks.onSession?.({ room: m.room, magicLink: m.magicLink })
                break
            case 'peer-joined':
                this.peerId = m.peerId ?? SINGLE_PEER
                this.authenticated = false
                this.attemptsLeft = MAX_PIN_ATTEMPTS
                this.hooks.onPeerJoined?.()
                this.challenge()
                break
            case 'pin-response':
                void this.verifyResponse(m.hash)
                break
            case 'snapshot-ack':
                this.beginStream()
                break
            case 'peer-left':
                this.streaming = false
                this.authenticated = false
                this.hooks.onPeerLeft?.(m.reason)
                break
            case 'error':
                this.hooks.onError?.(m.code, m.message)
                break
            default:
                break
        }
    }

    private challenge(): void {
        this.nonce = generateNonce()
        this.transport.sendControl({ t: 'pin-challenge', nonce: this.nonce })
    }

    private async verifyResponse(hash: string): Promise<void> {
        const ok = await verifyPin(this.pin, this.nonce, hash)
        if (ok) {
            this.authenticated = true
            this.transport.sendControl({ t: 'pin-ok' })
            this.hooks.onAuthenticated?.()
            this.sendSnapshot()
            return
        }
        this.attemptsLeft -= 1
        this.transport.sendControl({ t: 'pin-fail', left: this.attemptsLeft })
        if (this.attemptsLeft > 0) {
            this.challenge()
        } else {
            this.transport.sendControl({ t: 'peer-left', reason: 'pin-failed' })
            this.hooks.onPinFailed?.()
        }
    }

    private sendSnapshot(): void {
        const size = this.tab.getSize()
        this.transport.sendControl({
            t: 'snapshot',
            cols: size.cols,
            rows: size.rows,
            data: utf8ToBase64(this.tab.snapshot()),
        })
    }

    private beginStream(): void {
        if (this.streaming || this.stopped || !this.authenticated) {
            return
        }
        this.streaming = true
        this.subs.add(this.tab.output$.subscribe(data => {
            if (this.streaming) {
                this.transport.sendData(this.peerId, Channel.Output, data)
            }
        }))
        this.subs.add(this.tab.resize$.subscribe(sz => {
            this.transport.sendControl({ t: 'resize', cols: sz.cols, rows: sz.rows })
        }))
    }

    stop(reason = 'stopped'): void {
        if (this.stopped) {
            return
        }
        this.stopped = true
        if (this.room !== null) {
            this.transport.sendControl({ t: 'peer-left', reason })
            this.transport.sendControl({ t: 'session-close' })
        }
        this.streaming = false
        this.authenticated = false
        this.subs.unsubscribe()
        this.transport.close(1000, reason)
    }
}
