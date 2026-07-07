import { Injectable } from '@angular/core'
import { map } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, ConfigService, NotificationsService, BaseTabComponent, PromptModalComponent } from 'tabby-core'
import { BaseTerminalTabComponent, ResizeEvent } from 'tabby-terminal'
import { WebSocketTransport, normalizeRoomCode, isValidRoomCode } from '@peershell/protocol'

import { ShareController, HostTerminal } from '../host/shareController'
import { MirrorTabComponent } from '../guest/mirrorTab.component'

/** Owns the active host shares and adapts a Tabby terminal tab to the transport-driven controller. */
@Injectable({ providedIn: 'root' })
export class PeershellService {
    private readonly shares = new Map<BaseTerminalTabComponent, ShareController>()

    constructor(
        private readonly app: AppService,
        private readonly config: ConfigService,
        private readonly notifications: NotificationsService,
        private readonly ngbModal: NgbModal,
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

    async joinShared(): Promise<void> {
        const serverUrl: string | null = this.config.store.peershell?.serverUrl
        if (!serverUrl) {
            this.notifications.error('peershell: set the server URL in settings first')
            return
        }
        const room = await this.promptRoom()
        if (!room) {
            return
        }
        const transport = new WebSocketTransport()
        try {
            await transport.connect(serverUrl)
        } catch (err) {
            this.notifications.error('peershell: could not connect to the server', String(err))
            return
        }
        this.app.openNewTab({
            type: MirrorTabComponent,
            inputs: {
                transport,
                room,
                profile: { name: `peershell: ${room}`, type: 'peershell-mirror', options: {} },
            },
        })
    }

    private async promptRoom(): Promise<string | null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = 'Room code'
        const result = await modal.result.catch(() => null)
        const value: string | undefined = result?.value
        if (!value) {
            return null
        }
        const room = normalizeRoomCode(value)
        if (!isValidRoomCode(room)) {
            this.notifications.error('peershell: invalid room code')
            return null
        }
        return room
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
