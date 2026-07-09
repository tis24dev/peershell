import { Component } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService } from 'tabby-core'
import { AccountService } from '../account/account.service'
import { LoginModalComponent } from '../account/login-modal.component'

interface LiveSession { room: string, magicLink: string, hasGuest: boolean, createdAt: number, live?: boolean }

/** peershell settings tab: server URL, account (login/logout), live-shares dashboard, security note. */
@Component({
    template: `
        <div class="mb-4">
            <h3 class="mb-2">peershell</h3>
            <div class="alert alert-warning py-2">
                No end-to-end encryption yet: the relay server sees all terminal traffic in clear text, and
                guests get a full read-write shell. Do not share sensitive sessions on a server you do not
                trust; self-host the server in production. Access needs both the magic-link and the per-session PIN.
            </div>
        </div>

        <div class="form-line">
            <div class="header"><div class="title">Server URL</div>
                <div class="description">Rendezvous server, e.g. wss://panel.peershell.dev</div></div>
            <input type="text" class="form-control" [(ngModel)]="serverUrl" (change)="saveServerUrl()"
                placeholder="wss://host">
        </div>

        <div class="form-line">
            <div class="header"><div class="title">Fixed session PIN (optional)</div>
                <div class="description">If set, every share uses this PIN. Leave empty to generate a fresh
                    random PIN each time. At least 6 characters.</div></div>
            <input type="text" class="form-control" [(ngModel)]="pin" (change)="savePin()"
                placeholder="(auto-generated)" inputmode="numeric" autocomplete="off">
        </div>
        <div *ngIf="pinError" class="alert alert-danger py-1 px-2">{{ pinError }}</div>

        <div class="form-line">
            <div class="header"><div class="title">Account</div>
                <div class="description">{{ account.isLoggedIn() ? ('Signed in as ' + account.email) : 'Not signed in' }}</div></div>
            <div>
                <button *ngIf="!account.isLoggedIn()" class="btn btn-primary" (click)="openLogin()">Log in</button>
                <button *ngIf="account.isLoggedIn()" class="btn btn-outline-danger" (click)="logout()" [disabled]="busy">Log out</button>
            </div>
        </div>

        <div *ngIf="account.isLoggedIn()" class="mt-3">
            <div class="d-flex align-items-center mb-2">
                <h4 class="m-0 mr-auto">Active shares</h4>
                <button class="btn btn-sm btn-outline-secondary" (click)="refresh()" [disabled]="busy">Refresh</button>
            </div>
            <div *ngIf="error" class="alert alert-danger py-1 px-2">{{ error }}</div>
            <p *ngIf="!error && loaded && sessions.length === 0" class="text-muted">No live shares.</p>
            <table *ngIf="sessions.length" class="table table-sm">
                <thead><tr><th>Room</th><th>Guest</th><th>Magic-link</th></tr></thead>
                <tbody>
                    <tr *ngFor="let s of sessions">
                        <td><code>{{ s.room }}</code></td>
                        <td>{{ s.hasGuest ? 'connected' : '-' }}</td>
                        <td><small class="text-muted">{{ s.magicLink }}</small></td>
                    </tr>
                </tbody>
            </table>
        </div>
    `,
})
export class PeershellSettingsTabComponent {
    serverUrl = ''
    pin = ''
    pinError = ''
    sessions: LiveSession[] = []
    busy = false
    loaded = false
    error = ''

    constructor(
        private readonly config: ConfigService,
        private readonly ngbModal: NgbModal,
        readonly account: AccountService,
    ) {
        this.serverUrl = this.config.store.peershell?.serverUrl ?? ''
        this.pin = this.config.store.peershell?.pin ?? ''
        if (this.account.isLoggedIn()) {
            void this.refresh()
        }
    }

    async saveServerUrl(): Promise<void> {
        this.config.store.peershell.serverUrl = this.serverUrl.trim() || null
        await this.config.save()
    }

    async savePin(): Promise<void> {
        const v = this.pin.trim()
        if (v && v.length < 6) {
            this.pinError = 'PIN must be at least 6 characters (or empty to auto-generate).'
            return
        }
        this.pinError = ''
        this.config.store.peershell.pin = v || null
        await this.config.save()
    }

    async openLogin(): Promise<void> {
        const modal = this.ngbModal.open(LoginModalComponent)
        await modal.result.catch(() => null)
        if (this.account.isLoggedIn()) {
            await this.refresh()
        }
    }

    async logout(): Promise<void> {
        this.busy = true
        try {
            await this.account.logout()
            this.sessions = []
            this.loaded = false
        } finally {
            this.busy = false
        }
    }

    async refresh(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.getSessions()
            if (r.error) {
                this.error = r.error === 'unauthorized' ? 'Session expired. Log in again.' : `Could not load shares (${r.error}).`
                this.sessions = []
            } else {
                this.sessions = (r.sessions as LiveSession[]).filter(s => s.live !== false)
            }
            this.loaded = true
        } finally {
            this.busy = false
        }
    }
}
