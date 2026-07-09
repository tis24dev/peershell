import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

export interface AccountApiResult {
    status: number
    token?: string
    expiresAt?: number
    needsTotp?: boolean
    sessionKey?: string
    needsVerification?: boolean
    ok?: boolean
    error?: string
    [k: string]: unknown
}

/**
 * Client-neutral account layer: talks the server's REST API (fetch) and keeps the bearer token.
 *
 * Token storage: Tabby config store (`peershell.account`), persisted via ConfigService.save(). This is
 * an MVP tradeoff — the Tabby vault (encrypted at rest) is the intended hardening and can replace this
 * behind the same getToken/persist surface without touching callers.
 */
@Injectable({ providedIn: 'root' })
export class AccountService {
    constructor(private readonly config: ConfigService) {}

    get email(): string | null {
        return this.config.store.peershell?.account?.email ?? null
    }

    getToken(): string | null {
        const a = this.config.store.peershell?.account
        if (a?.token && (!a.expiresAt || a.expiresAt > Date.now())) {
            return a.token
        }
        return null
    }

    isLoggedIn(): boolean {
        return !!this.getToken()
    }

    /** REST base derived from the configured ws(s):// server URL. */
    private base(): string {
        const url: string = this.config.store.peershell?.serverUrl || ''
        return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '')
    }

    private async api(method: string, path: string, body?: unknown, auth = false): Promise<AccountApiResult> {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (auth) {
            const t = this.getToken()
            if (t) {
                headers.authorization = `Bearer ${t}`
            }
        }
        let res: Response
        try {
            res = await fetch(this.base() + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[peershell] fetch failed:', method, this.base() + path, err)
            return { status: 0, error: 'network-error', detail: String((err as any)?.message ?? err) }
        }
        let json: Record<string, unknown> = {}
        try {
            json = await res.json()
        } catch { /* empty/non-json body */ }
        return { status: res.status, ...json }
    }

    register(email: string, password: string): Promise<AccountApiResult> {
        return this.api('POST', '/register', { email, password })
    }

    verifyEmail(email: string, code: string): Promise<AccountApiResult> {
        return this.api('POST', '/verify-email', { email, code })
    }

    login(email: string, password: string): Promise<AccountApiResult> {
        return this.api('POST', '/login', { email, password })
    }

    verify2fa(sessionKey: string, code: string): Promise<AccountApiResult> {
        return this.api('POST', '/2fa/verify', { sessionKey, code })
    }

    requestPasswordReset(email: string): Promise<AccountApiResult> {
        return this.api('POST', '/request-password-reset', { email })
    }

    resetPassword(email: string, code: string, newPassword: string): Promise<AccountApiResult> {
        return this.api('POST', '/reset-password', { email, code, newPassword })
    }

    /** Dashboard: the account's live shares. Clears the local token on 401 (expired). */
    async getSessions(): Promise<{ account?: { email: string, totpEnabled: boolean }, sessions: any[], error?: string }> {
        const r = await this.api('GET', '/sessions', undefined, true)
        if (r.status === 200) {
            return { account: (r as any).account, sessions: (r as any).sessions ?? [] }
        }
        if (r.status === 401) {
            await this.clearLocal()
            return { sessions: [], error: 'unauthorized' }
        }
        return { sessions: [], error: String(r.error ?? r.status) }
    }

    /** Store the bearer token locally (config store). */
    async persist(email: string, token: string, expiresAt?: number): Promise<void> {
        // Top-level config keys are getter-only in Tabby: mutate the nested property, never reassign
        // store.peershell (which throws "has only a getter"). `peershell` always exists via defaults.
        this.config.store.peershell.account = { email, token, expiresAt: expiresAt ?? null }
        await this.config.save()
    }

    async clearLocal(): Promise<void> {
        if (this.config.store.peershell) {
            this.config.store.peershell.account = null
            await this.config.save()
        }
    }

    async logout(): Promise<void> {
        try {
            await this.api('POST', '/logout', {}, true)
        } catch { /* revoke is best-effort */ }
        await this.clearLocal()
    }
}
