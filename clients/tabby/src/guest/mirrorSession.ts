import { Injector } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { LogService } from 'tabby-core'
import { BaseSession, UTF8SplitterMiddleware } from 'tabby-terminal'
import { SessionTransport, MirrorController, MirrorSink, PinProvider } from '@peershell/protocol'

/**
 * A "fake shell" session backing the guest mirror tab. Inbound frames become terminal output via
 * emitOutput(); the guest's keystrokes arrive through write() and are forwarded to the host.
 * Delegates all wire logic to the Tabby-agnostic MirrorController.
 */
export class MirrorSession extends BaseSession {
    private readonly hostResize = new Subject<{ cols: number, rows: number }>()
    private readonly controller: MirrorController

    constructor(
        injector: Injector,
        private readonly transport: SessionTransport,
        private readonly room: string,
        pinProvider: PinProvider,
    ) {
        super(injector.get(LogService).create('peershell'))
        // Reassemble multibyte UTF-8 split across network frames before rendering (see PROTOCOL.md).
        this.middleware.push(new UTF8SplitterMiddleware())

        const sink: MirrorSink = {
            emit: data => this.emitOutput(Buffer.from(data)),
            hostResize: (cols, rows) => this.hostResize.next({ cols, rows }),
            ended: reason => {
                this.emitOutput(Buffer.from(`\r\n[peershell] ${reason}\r\n`))
                void this.destroy()
            },
        }
        this.controller = new MirrorController(this.transport, sink, pinProvider)
    }

    get hostResize$(): Observable<{ cols: number, rows: number }> {
        return this.hostResize
    }

    async start(_options?: unknown): Promise<void> {
        this.open = true
        this.controller.join(this.room)
    }

    write(data: Buffer): void {
        this.controller.writeInput(new Uint8Array(data))
    }

    // tmate model: the guest never resizes the host PTY; it only adopts the host's size.
    resize(_columns: number, _rows: number): void { /* no-op */ }

    kill(_signal?: string): void {
        this.controller.close()
    }

    async gracefullyKillProcess(): Promise<void> {
        this.controller.close()
    }

    supportsWorkingDirectory(): boolean {
        return false
    }

    async getWorkingDirectory(): Promise<string | null> {
        return null
    }
}
