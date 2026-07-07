import { Injectable } from '@angular/core'
import { map } from 'rxjs'
import { AppService, ConfigService, NotificationsService, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent, ResizeEvent } from 'tabby-terminal'
import { WebSocketTransport } from '@peershell/protocol'

import { ShareController, HostTerminal } from '../host/shareController'

/** Owns the active host shares and adapts a Tabby terminal tab to the transport-driven controller. */
@Injectable({ providedIn: 'root' })
export class PeershellService {
    private readonly shares = new Map<BaseTerminalTabComponent, ShareController>()

    constructor(
        private readonly app: AppService,
        private readonly config: ConfigService,
        private readonly notifications: NotificationsService,
    ) {}

    isSharing(tab: BaseTabComponent): boolean {
        return tab instanceof BaseTerminalTabComponent && this.shares.has(tab)
    }

    async shareActive(): Promise<void> {
        const tab = this.app.activeTab
        if (tab instanceof BaseTerminalTabComponent) {
            await this.startSharing(tab)
        } else {
            this.notifications.error('peershell: focus a terminal tab to share it')
        }
    }

    async startSharing(tab: BaseTerminalTabComponent): Promise<void> {
        if (this.shares.has(tab)) {
            return
        }
        const serverUrl: string | null = this.config.store.peershell?.serverUrl
        if (!serverUrl) {
            this.notifications.error('peershell: set the server URL in settings first')
            return
        }

        const transport = new WebSocketTransport()
        const controller = new ShareController(transport, this.adapt(tab), {
            onSession: h => this.notifications.info('peershell: sharing this terminal', h.magicLink),
            onPeerLeft: () => this.notifications.notice('peershell: peer disconnected'),
            onError: (code, message) => this.notifications.error(`peershell: ${code}`, message),
        })

        this.shares.set(tab, controller)
        tab.destroyed$.subscribe(() => this.shares.delete(tab))

        try {
            await controller.start(serverUrl)
        } catch (err) {
            this.shares.delete(tab)
            this.notifications.error('peershell: could not connect to the server', String(err))
        }
    }

    stopSharing(tab: BaseTerminalTabComponent): void {
        const controller = this.shares.get(tab)
        if (controller) {
            controller.stop('stopped')
            this.shares.delete(tab)
            this.notifications.notice('peershell: sharing stopped')
        }
    }

    private adapt(tab: BaseTerminalTabComponent): HostTerminal {
        return {
            output$: tab.binaryOutput$.pipe(map((b: Buffer) => new Uint8Array(b))),
            sendInput: (data: Uint8Array) => tab.sendInput(Buffer.from(data)),
            getSize: () => ({ cols: tab.size?.columns ?? 80, rows: tab.size?.rows ?? 24 }),
            resize$: tab.resize$.pipe(map((e: ResizeEvent) => ({ cols: e.columns, rows: e.rows }))),
            snapshot: () => {
                try {
                    return String(tab.frontend?.saveState() ?? '')
                } catch {
                    return ''
                }
            },
            closed$: tab.destroyed$,
        }
    }
}
