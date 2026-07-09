import { Injectable } from '@angular/core'
import { map } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, ConfigService, NotificationsService, BaseTabComponent, SplitTabComponent, PromptModalComponent, PlatformService } from 'tabby-core'
import { BaseTerminalTabComponent, ResizeEvent } from 'tabby-terminal'
import {
    WebSocketTransport, normalizeRoomCode, isValidRoomCode, generatePin, PinProvider, HttpTunnelHandler,
} from '@peershell/protocol'

import { ShareController, HostTerminal } from '../host/shareController'
import { MirrorTabComponent } from '../guest/mirrorTab.component'
import { AccountService } from '../account/account.service'
import { LoginModalComponent } from '../account/login-modal.component'
import { ShareInfoModalComponent } from '../host/share-info-modal.component'
import webClientHtml from '../../assets/web-client.html'

/** Owns the active host shares and adapts a Tabby terminal tab to the transport-driven controller. */
@Injectable({ providedIn: 'root' })
export class PeershellService {
    private readonly shares = new Map<BaseTerminalTabComponent, ShareController>()
    // Per-share grace/establish timers, keyed by tab so stopSharing() owns their teardown.
    private readonly shareTimers = new Map<BaseTerminalTabComponent,
        { grace: ReturnType<typeof setTimeout> | null, establish: ReturnType<typeof setTimeout> | null }>()

    constructor(
        private readonly app: AppService,
        private readonly config: ConfigService,
        private readonly notifications: NotificationsService,
        private readonly ngbModal: NgbModal,
        private readonly account: AccountService,
        private readonly platform: PlatformService,
    ) {}

    isSharing(tab: BaseTabComponent): boolean {
        return tab instanceof BaseTerminalTabComponent && this.shares.has(tab)
    }

    /**
     * The terminal to act on in the active tab (SplitTabComponent-aware). Prefers the focused pane, but
     * getFocusedTab() can be null (e.g. focus moved to the toolbar), so fall back to the tab's terminals.
     */
    private focusedTerminal(): BaseTerminalTabComponent | null {
        const active = this.app.activeTab
        if (active instanceof SplitTabComponent) {
            const focused = active.getFocusedTab()
            if (focused instanceof BaseTerminalTabComponent) {
                return focused
            }
            const terms = active.getAllTabs().filter(
                (t): t is BaseTerminalTabComponent => t instanceof BaseTerminalTabComponent)
            // Prefer one that is currently shared; otherwise the first terminal in the tab.
            return terms.find(t => this.shares.has(t)) ?? terms[0] ?? null
        }
        return active instanceof BaseTerminalTabComponent ? active : null
    }

    async shareActive(): Promise<void> {
        const tab = this.focusedTerminal()
        if (tab) {
            await this.startSharing(tab)
        } else {
            this.notifications.error('peershell: focus a terminal tab to share it')
        }
    }

    /** Stop sharing the focused terminal, if it is currently shared. */
    stopActive(): void {
        const tab = this.focusedTerminal()
        if (tab && this.shares.has(tab)) {
            this.stopSharing(tab)
        } else {
            this.notifications.notice('peershell: this terminal is not being shared')
        }
    }

    async startSharing(tab: BaseTerminalTabComponent): Promise<void> {
        if (this.shares.has(tab)) {
            return
        }
        if (!(await this.confirmDisclaimer())) {
            return
        }
        const serverUrl: string | null = this.config.store.peershell?.serverUrl
        if (!serverUrl) {
            this.notifications.error('peershell: set the server URL in settings first')
            return
        }

        // Sharing is gated behind a logged-in account: the account token authenticates the outbound
        // connection so the server accepts create-session (open servers must not let anyone share).
        let token = this.account.getToken()
        if (!token) {
            token = await this.openLogin()
            if (!token) {
                this.notifications.error('peershell: log in to share a terminal')
                return
            }
        }

        // Per-session PIN, local-only (challenge-response; never sent to the server in cleartext). Use the
        // user's fixed PIN from settings if set (>= 6 chars), otherwise generate a fresh random one.
        const configuredPin = String(this.config.store.peershell?.pin ?? '').trim()
        const pin = configuredPin.length >= 6 ? configuredPin : generatePin(6)
        const transport = new WebSocketTransport()
        // Serve the embedded web-client to browsers opening the magic-link, tunneled over this same
        // outbound connection. Path is whitelisted inside HttpTunnelHandler (only '/').
        // eslint-disable-next-line no-new
        new HttpTunnelHandler(transport, () => webClientHtml)
        // Grace window: a guest disconnect (closed tab or a brief network blip) does not kill the share
        // immediately — wait ~10s for a reconnect before tearing it down.
        // Per-share timers, owned by this tab so stopSharing() cancels them on teardown. Otherwise a
        // stale grace/establish timer could later fire stopSharing() on a tab the host has re-shared.
        const timers: { grace: ReturnType<typeof setTimeout> | null, establish: ReturnType<typeof setTimeout> | null } =
            { grace: null, establish: null }
        this.shareTimers.set(tab, timers)
        // Auto-kill a share that never gets a connected guest within 5 minutes of starting.
        let established = false
        const controller = new ShareController(transport, this.adapt(tab), pin, {
            onSession: h => {
                const modal = this.ngbModal.open(ShareInfoModalComponent, { backdrop: 'static', size: 'lg' })
                modal.componentInstance.magicLink = h.magicLink
                modal.componentInstance.pin = pin
            },
            onPeerJoined: () => {
                if (timers.grace) {
                    clearTimeout(timers.grace)
                    timers.grace = null
                    this.notifications.notice('peershell: guest reconnected')
                }
            },
            onAuthenticated: () => {
                established = true
                if (timers.establish) {
                    clearTimeout(timers.establish)
                    timers.establish = null
                }
                this.notifications.notice('peershell: guest connected')
            },
            onPinFailed: () => this.notifications.error('peershell: guest failed the PIN'),
            onPeerLeft: () => {
                if (timers.grace) {
                    return
                }
                this.notifications.notice('peershell: guest disconnected — closing in 10s unless they reconnect')
                timers.grace = setTimeout(() => {
                    timers.grace = null
                    this.stopSharing(tab, 'peershell: guest gone — sharing stopped')
                }, 10000)
            },
            onError: (code, message) => {
                if (code === 'unauthorized') {
                    void this.account.clearLocal()
                    // Tear the share down now (closes the WS, cancels this share's timers, drops the entry)
                    // instead of leaving a dead session up until the 5-min establish timer fires.
                    this.stopSharing(tab, 'peershell: session expired, log in and share again')
                } else {
                    this.notifications.error(`peershell: ${code}`, message)
                }
            },
        })

        this.shares.set(tab, controller)
        tab.destroyed$.subscribe(() => {
            this.shares.delete(tab)
            this.clearShareTimers(tab)
        })
        timers.establish = setTimeout(() => {
            timers.establish = null
            if (!established) {
                this.notifications.error('peershell: no one connected in time — sharing stopped')
                this.stopSharing(tab)
            }
        }, 300000)

        try {
            await controller.start(serverUrl, token)
        } catch (err) {
            this.clearShareTimers(tab)
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
        const pinProvider: PinProvider = () => this.promptPin()
        this.app.openNewTab({
            type: MirrorTabComponent,
            inputs: {
                transport,
                room,
                pinProvider,
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

    private async promptPin(): Promise<string | null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = 'Session PIN'
        modal.componentInstance.password = true
        const result = await modal.result.catch(() => null)
        const value: string | undefined = result?.value
        return value ? value.trim() : null
    }

    /**
     * One-time no-E2E disclosure before the first share: guests get a read-write shell and the relay
     * sees traffic in clear text. Acknowledged once, remembered in config.
     */
    private async confirmDisclaimer(): Promise<boolean> {
        if (this.config.store.peershell?.disclaimerAck) {
            return true
        }
        const r = await this.platform.showMessageBox({
            type: 'warning',
            message: 'Share this terminal with peershell?',
            detail: 'Guests get full read-write access to this shell. The relay server sees all terminal '
                + 'traffic in clear text — there is no end-to-end encryption yet. Do not share sensitive '
                + 'sessions on a server you do not trust; self-host the server in production.',
            buttons: ['Share', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })
        if (r.response === 0) {
            this.config.store.peershell.disclaimerAck = true
            await this.config.save()
            return true
        }
        return false
    }

    /** Toolbar entry: pops a native dropdown menu with the peershell actions. */
    openMenu(): void {
        if (!this.account.isLoggedIn()) {
            this.platform.popupContextMenu([
                { label: 'Log in', click: () => { this.openAccount() } },
            ])
            return
        }
        const term = this.focusedTerminal()
        const sharing = !!term && this.shares.has(term)
        this.platform.popupContextMenu([
            sharing
                ? { label: 'Stop sharing this terminal', click: () => { this.stopActive() } }
                : { label: 'Share this terminal', click: () => { void this.shareActive() } },
            { label: 'Join a shared terminal', click: () => { void this.joinShared() } },
            { type: 'separator' },
            { label: `Log out (${this.account.email})`, click: () => { void this.logout() } },
        ])
    }

    /** Opens the account modal (login / register / 2FA / password reset). */
    openAccount(): void {
        this.ngbModal.open(LoginModalComponent)
    }

    async logout(): Promise<void> {
        await this.account.logout()
        this.notifications.notice('peershell: logged out')
    }

    /** Opens the login modal, resolving with the bearer token on success or null if cancelled. */
    private async openLogin(): Promise<string | null> {
        const modal = this.ngbModal.open(LoginModalComponent)
        return await modal.result.catch(() => null)
    }

    stopSharing(tab: BaseTerminalTabComponent, note = 'peershell: sharing stopped'): void {
        // Cancel this share's timers first so a pending grace/establish timer cannot later fire on a tab
        // the host has since re-shared.
        this.clearShareTimers(tab)
        const controller = this.shares.get(tab)
        if (controller) {
            controller.stop('stopped')
            this.shares.delete(tab)
            this.notifications.notice(note)
        }
    }

    private clearShareTimers(tab: BaseTerminalTabComponent): void {
        const t = this.shareTimers.get(tab)
        if (!t) {
            return
        }
        if (t.grace) {
            clearTimeout(t.grace)
            t.grace = null
        }
        if (t.establish) {
            clearTimeout(t.establish)
            t.establish = null
        }
        this.shareTimers.delete(tab)
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
