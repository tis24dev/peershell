/**
 * Guest side of a shared session. Tabby-agnostic (drives a SessionTransport + a small MirrorSink
 * port), so it is fully unit-testable and reusable by the web-client / mobile later. MirrorSession
 * adapts it to a Tabby BaseSession.
 *
 * Stage 2 scope: join, render the snapshot then ack it (barrier), render live output, forward the
 * guest's keystrokes as input, and surface host resizes + session end. The PIN gate lands in Stage 3.
 */
import {
    SessionTransport, ControlMessage, Channel, ClientKind, SINGLE_PEER, base64ToBytes,
} from '@peershell/protocol'

/** Port the controller drives on the guest terminal (adapted from a Tabby session). */
export interface MirrorSink {
    emit(data: Uint8Array): void
    hostResize(cols: number, rows: number): void
    ended(reason: string): void
}

export class MirrorController {
    private readonly peerId = SINGLE_PEER
    private endedFlag = false

    constructor(
        private readonly transport: SessionTransport,
        private readonly sink: MirrorSink,
    ) {
        this.transport.onControl(m => this.onControl(m))
        this.transport.onBinary(f => {
            if (f.channel === Channel.Output) {
                this.sink.emit(f.data)
            }
        })
    }

    /** Announce as a guest and join the room. Handlers are wired in the ctor so no frame is missed. */
    join(room: string, opts: { name?: string, kind?: ClientKind } = {}): void {
        this.transport.sendControl({
            t: 'hello', role: 'guest', kind: opts.kind ?? 'desktop', client: 'tabby-peershell',
        })
        this.transport.sendControl({ t: 'join', room, name: opts.name })
    }

    private onControl(m: ControlMessage): void {
        switch (m.t) {
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

    /** Forward the guest's keystrokes to the host. */
    writeInput(data: Uint8Array): void {
        this.transport.sendData(this.peerId, Channel.Input, data)
    }

    private end(reason: string): void {
        if (this.endedFlag) {
            return
        }
        this.endedFlag = true
        this.sink.ended(reason)
    }

    close(): void {
        this.transport.close(1000, 'guest-closed')
    }
}
