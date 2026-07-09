import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { AccountService, AccountApiResult } from './account.service'

type Mode = 'account' | 'login' | 'verify' | '2fa' | 'reset-request' | 'reset'

const ERRORS: Record<string, string> = {
    'invalid-credentials': 'Email or password is not valid.',
    'needs-verification': 'Verify your email first (check email or the server log for the code).',
    'rate-limited': 'Too many attempts. Please try again later.',
    'password-too-weak': 'Password must be at least 8 characters.',
    'invalid-email': 'Enter a valid email address.',
    'invalid': 'Wrong or expired code.',
    'invalid-code': 'Wrong 2FA code.',
    'too-many-attempts': 'Too many attempts. Try again later.',
    'unauthorized': 'Session expired. Please log in again.',
    'network-error': 'Cannot reach the peershell server. Check the server URL in settings.',
}

/** Login / create-account / verify / 2FA / password-reset / logout. Resolves modal.close(token) on login. */
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
                    <input class="form-control" type="password" [(ngModel)]="password" name="password">
                    <small class="form-text text-muted">At least 8 characters (for a new account).</small></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Log in</button>
                <button class="btn btn-outline-primary ml-2" type="button" [disabled]="busy" (click)="submitRegister()">Create account</button>
                <button class="btn btn-link float-right" type="button" [disabled]="busy" (click)="switch('reset-request')">Forgot password?</button>
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

            <form *ngIf="mode === 'reset-request'" (ngSubmit)="submitResetRequest()">
                <p class="mb-2">Enter your email to receive a password-reset code.</p>
                <div class="form-group">
                    <input class="form-control" type="email" [(ngModel)]="email" name="email" autofocus></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Send reset code</button>
                <button class="btn btn-link" type="button" [disabled]="busy" (click)="switch('login')">Back to log in</button>
            </form>

            <form *ngIf="mode === 'reset'" (ngSubmit)="submitReset()">
                <p class="mb-2">Enter the reset code for <strong>{{ email }}</strong> and a new password.</p>
                <div class="form-group"><label>Reset code</label>
                    <input class="form-control" type="text" [(ngModel)]="code" name="code" maxlength="6" autofocus></div>
                <div class="form-group"><label>New password</label>
                    <input class="form-control" type="password" [(ngModel)]="newPassword" name="newPassword">
                    <small class="form-text text-muted">At least 8 characters.</small></div>
                <button class="btn btn-primary" type="submit" [disabled]="busy">Set new password</button>
                <button class="btn btn-link" type="button" [disabled]="busy" (click)="switch('login')">Back to log in</button>
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
    newPassword = ''
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
        this.newPassword = ''
    }

    private get normEmail(): string {
        return this.email.trim().toLowerCase()
    }

    private fail(r: AccountApiResult): void {
        const base = ERRORS[String(r.error)] ?? (r.error ? String(r.error) : `Request failed (${r.status})`)
        const detail = (r as { detail?: string }).detail
        this.error = detail ? `${base}  ·  ${detail}` : base
    }

    async submitLogin(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.login(this.normEmail, this.password)
            if (r.needsTotp && r.sessionKey) {
                this.sessionKey = r.sessionKey
                this.switch('2fa')
                return
            }
            if (r.status === 200 && r.token) {
                await this.account.persist(this.normEmail, r.token, r.expiresAt)
                this.modal.close(r.token)
                return
            }
            if (r.error === 'needs-verification') {
                this.switch('verify')
                this.info = 'Please verify your email. The code is in your email or the server log.'
                return
            }
            this.fail(r)
        } catch (e) {
            this.error = `Unexpected error: ${String((e as { message?: string })?.message ?? e)}`
        } finally {
            this.busy = false
        }
    }

    async submitRegister(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.register(this.normEmail, this.password)
            if (r.status === 200 && r.token) {
                // Auto-verified (email delivery unavailable) -> logged in immediately.
                await this.account.persist(this.normEmail, r.token, r.expiresAt)
                this.modal.close(r.token)
                return
            }
            if (r.status === 200 && r.needsVerification) {
                this.switch('verify')
                this.info = 'Check your email for the 6-digit code, then verify.'
                return
            }
            if (r.status === 200 && r.alreadyRegistered) {
                this.switch('login')
                this.info = 'That email is already registered — please log in.'
                return
            }
            this.fail(r)
        } catch (e) {
            this.error = `Unexpected error: ${String((e as { message?: string })?.message ?? e)}`
        } finally {
            this.busy = false
        }
    }

    async submitVerify(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.verifyEmail(this.normEmail, this.code.trim())
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

    async submit2fa(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.verify2fa(this.sessionKey, this.code.trim())
            if (r.status === 200 && r.token) {
                await this.account.persist(this.normEmail, r.token, r.expiresAt)
                this.modal.close(r.token)
                return
            }
            this.fail(r)
        } finally {
            this.busy = false
        }
    }

    async submitResetRequest(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            await this.account.requestPasswordReset(this.normEmail)
            this.switch('reset')
            this.info = 'If that email exists, a reset code was sent (check your email or the server log).'
        } finally {
            this.busy = false
        }
    }

    async submitReset(): Promise<void> {
        this.busy = true
        this.error = ''
        try {
            const r = await this.account.resetPassword(this.normEmail, this.code.trim(), this.newPassword)
            if (r.status === 200) {
                this.switch('login')
                this.info = 'Password changed. Please log in.'
            } else {
                this.fail(r)
            }
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
