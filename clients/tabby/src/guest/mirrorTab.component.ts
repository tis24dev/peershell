import { Component, Injector, Input } from '@angular/core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { SessionTransport } from '@peershell/protocol'

import { MirrorSession } from './mirrorSession'
import { PinProvider } from './mirrorController'

/**
 * Guest tab that renders a mirrored remote terminal. Reuses BaseTerminalTabComponent's template so
 * xterm.js rendering, selection, scrollback, etc. all work; only the session is our MirrorSession.
 *
 * NOTE: needs validation in a real Tabby GUI (module wiring + profile), which cannot run headless here.
 */
@Component({
    selector: 'peershell-mirror-tab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
    animations: BaseTerminalTabComponent.animations,
})
export class MirrorTabComponent extends BaseTerminalTabComponent<any> {
    @Input() transport!: SessionTransport
    @Input() room!: string
    @Input() pinProvider!: PinProvider
    session: MirrorSession | null = null

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(injector: Injector) {
        super(injector)
    }

    ngOnInit(): void {
        this.logger = this.log.create('peershell-mirror')
        if (!this.profile) {
            this.profile = {
                name: `peershell: ${this.room}`,
                type: 'peershell-mirror',
                options: {},
            }
        }
        super.ngOnInit()
    }

    protected onFrontendReady(): void {
        const session = new MirrorSession(this.injector, this.transport, this.room, this.pinProvider)
        this.setSession(session)
        // Adopt the host's size (tmate model). Guest window resizes are ignored (no frontend.resize$
        // subscription) so there is no resize feedback loop.
        this.subscribeUntilDestroyed(session.hostResize$, ({ cols, rows }) => {
            this.frontend?.xterm?.resize(cols, rows)
        })
        void session.start()
        super.onFrontendReady()
    }

    ngOnDestroy(): void {
        super.ngOnDestroy()
        void this.session?.destroy()
    }
}
