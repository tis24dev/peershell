import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { AccountService, AccountApiResult } from './account.service'

type Mode = 'account' | 'login' | 'register' | 'verify' | '2fa'

const ERRORS: Record<string, string> = {
    'invalid-credentials': 'Email or password is not valid.',
    'needs-verification': 'Verify your email first (check the server log for the code).',
    'rate-limited': 'Too many attempts. Please try again later.',
    'password-too-weak': 'Password must be at least 8 characters.',
    'invalid-email': 'Enter a valid email address.',
    'invalid': 'Wrong or expired code.',
    'invalid-code': 'Wrong 2FA code.',
    'too-many-attempts': 'Too many 2FA attempts. Try logging in again.',
    'unauthorized': 'Session expired. Please log in again.',
    'network-error': 'Cannot reach the peershell server. Check the server URL in settings.',
}

/** Register / verify / login / 2FA / logout modal. Resolves modal.close(token) on a successful login. */
@Component({
    template: `
        <div class="modal-header"><h4 class="modal-title">peershell account</h4></div>
        <div class="modal-body">
            <div *ngIf="error" class="alert alert-danger py-1 px-2 mb-2">{{ error }}</div>
            <div *ngIf="info" class="alert alert-info py-1 px-2 mb-2">{{ info }}</div>

            <ng-container *ngIf="mode === 'account'">
                <p class="mb-2">Signed in as <strong>{{ email }}</strong>.</p>
                <button class="btn btn-outline-danger" [disabled]="busy" (click)="doLogout()">Log out</button>
            </ng-container>

            <form *ngIf="mode === 'login'" (ngSubmit)="submitLogin()">
                <div class="form-group"><label>Email</label>
                    <input class="form-control" type="email" [(ngModel)]="email" name="email" autofocus></div>
                <div class="form-group"><label>Password</label>
                    <input class="form-control" type="password" [(ngModel)]="password" name="password"></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Log in</button>
                <button class="btn btn-link" type="button" [disabled]="busy" (click)="switch('register')">Create account</button>
            </form>

            <form *ngIf="mode === 'register'" (ngSubmit)="submitRegister()">
                <div class="form-group"><label>Email</label>
                    <input class="form-control" type="email" [(ngModel)]="email" name="email" autofocus></div>
                <div class="form-group"><label>Password</label>
                    <input class="form-control" type="password" [(ngModel)]="password" name="password">
                    <small class="form-text text-muted">At least 8 characters.</small></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Register</button>
                <button class="btn btn-link" type="button" [disabled]="busy" (click)="switch('login')">Back to log in</button>
            </form>

            <form *ngIf="mode === 'verify'" (ngSubmit)="submitVerify()">
                <p class="mb-2">Enter the 6-digit verification code for <strong>{{ email }}</strong>.</p>
                <div class="form-group">
                    <input class="form-control" type="text" [(ngModel)]="code" name="code" maxlength="6" autofocus></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Verify</button>
                <button class="btn btn-link" type="button" [disabled]="busy" (click)="switch('login')">Back to log in</button>
            </form>

            <form *ngIf="mode === '2fa'" (ngSubmit)="submit2fa()">
                <p class="mb-2">Enter your 6-digit authenticator code.</p>
                <div class="form-group">
                    <input class="form-control" type="text" [(ngModel)]="code" name="code" maxlength="6" autofocus></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Verify</button>
            </form>
        </div>
        <div class="modal-footer">
            <button class="btn btn-outline-secondary" [disabled]="busy" (click)="modal.dismiss()">Close</button>
        </div>
    `,
})
export class LoginModalComponent {
    mode: Mode = 'login'
    email = ''
    password = ''
    code = ''
    sessionKey = ''
    busy = false
    error = ''
    info = ''

    constructor(public readonly modal: NgbActiveModal, private readonly account: AccountService) {
        if (this.account.isLoggedIn()) {
            this.mode = 'account'
            this.email = this.account.email ?? ''
        }
    }

    switch(mode: Mode): void {
        this.mode = mode
        this.error = ''
        this.info = ''
        this.code = ''
    }

    private fail(r: AccountApiResult): void {
        this.error = ERRORS[String(r.error)] ?? (r.error ? String(r.error) : `Request failed (${r.status})`)
    }

    async submitRegister(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.register(this.email.trim().toLowerCase(), this.password)
            if (r.status === 200) {
                this.switch('verify')
                this.info = 'Registered. Find your 6-digit code in the server log, then verify.'
            } else {
                this.fail(r)
            }
        } finally {
            this.busy = false
        }
    }

    async submitVerify(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.verifyEmail(this.email.trim().toLowerCase(), this.code.trim())
            if (r.status === 200) {
                this.switch('login')
                this.info = 'Email verified. You can log in now.'
            } else {
                this.fail(r)
            }
        } finally {
            this.busy = false
        }
    }

    async submitLogin(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.login(this.email.trim().toLowerCase(), this.password)
            if (r.needsTotp && r.sessionKey) {
                this.sessionKey = r.sessionKey
                this.switch('2fa')
                return
            }
            if (r.status === 200 && r.token) {
                await this.account.persist(this.email.trim().toLowerCase(), r.token, r.expiresAt)
                this.modal.close(r.token)
                return
            }
            if (r.error === 'needs-verification') {
                this.switch('verify')
                this.info = 'Please verify your email. The code is in the server log.'
                return
            }
            this.fail(r)
        } finally {
            this.busy = false
        }
    }

    async submit2fa(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.verify2fa(this.sessionKey, this.code.trim())
            if (r.status === 200 && r.token) {
                await this.account.persist(this.email.trim().toLowerCase(), r.token, r.expiresAt)
                this.modal.close(r.token)
                return
            }
            this.fail(r)
        } finally {
            this.busy = false
        }
    }

    async doLogout(): Promise<void> {
        this.busy = true
        try {
            await this.account.logout()
            this.modal.close(null)
        } finally {
            this.busy = false
        }
    }
}
