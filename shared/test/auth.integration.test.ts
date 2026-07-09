/**
 * Stage 6 server: account REST (register/verify/login/2FA/logout/rate-limit) + WS auth-gate on
 * create-session. Runs the real server ephemeral (in-memory store) with requireAuth ON.
 */
import * as http from 'http'
import WebSocket from 'ws'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('../../server/src/index.cjs') as {
    startRelay: (port?: number, opts?: any) => Promise<{ url: string, publicUrl: string, close: () => Promise<void> }>
    totpAt: (secret: string, counter: number) => string
}

let relay: { url: string, publicUrl: string, close: () => Promise<void> }
let httpBase = ''
const sent: any[] = []
let logSpy: jest.SpyInstance

beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* silence */ })
    relay = await server.startRelay(0, {
        requireAuth: true,
        ephemeral: true,
        // Inject a mailer stub so registration takes the email-verification path (not auto-verify) and
        // the code is captured here for the test.
        email: { apiKey: 'test', from: 'noreply@test', sendFn: async (o: any) => { sent.push(o) } },
    })
    httpBase = relay.url.replace('ws://', 'http://')
})
afterAll(async () => { await relay.close(); logSpy.mockRestore() })

function api(method: string, path: string, body?: any, token?: string): Promise<{ status: number, json: any }> {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null
        const u = new URL(httpBase + path)
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method,
            headers: {
                'content-type': 'application/json',
                ...(data ? { 'content-length': data.length } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        }, res => {
            let b = ''
            res.setEncoding('utf-8')
            res.on('data', c => { b += c })
            res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(b || '{}') }) } catch { resolve({ status: res.statusCode ?? 0, json: {} }) } })
        })
        req.on('error', reject)
        if (data) { req.write(data) }
        req.end()
    })
}

const codeFor = (email: string): string => {
    const mail = [...sent].reverse().find(m => m.to === email)
    const m = mail && /(\d{6})/.exec(mail.text)
    return m ? m[1] : ''
}

// Drive the WS create-session leg; resolves with the first control message the server sends back.
function createSessionWs(token?: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(relay.url + (token ? `?token=${token}` : ''))
        const to = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 6000)
        ws.on('open', () => {
            ws.send(JSON.stringify({ v: 1, t: 'hello', role: 'host', kind: 'desktop' }))
            ws.send(JSON.stringify({ v: 1, t: 'create-session' }))
        })
        ws.on('message', d => {
            let m: any = null
            try { m = JSON.parse(d.toString()) } catch { /* ignore */ }
            if (m && (m.t === 'session-created' || m.t === 'error')) {
                clearTimeout(to)
                ws.close()
                resolve(m)
            }
        })
        ws.on('error', e => { clearTimeout(to); reject(e) })
    })
}

async function registerVerifyLogin(email: string, password = 'CorrectHorse9'): Promise<string> {
    await api('POST', '/register', { email, password })
    await api('POST', '/verify-email', { email, code: codeFor(email) })
    const r = await api('POST', '/login', { email, password })
    return r.json.token
}

it('register -> verify -> login issues a token; login before verify is blocked', async () => {
    const email = 'alice@example.com'
    const reg = await api('POST', '/register', { email, password: 'CorrectHorse9' })
    expect(reg.status).toBe(200)
    expect(reg.json.needsVerification).toBe(true)

    const early = await api('POST', '/login', { email, password: 'CorrectHorse9' })
    expect(early.status).toBe(403)
    expect(early.json.error).toBe('needs-verification')

    const code = codeFor(email)
    expect(code).toMatch(/^\d{6}$/)
    const ver = await api('POST', '/verify-email', { email, code })
    expect(ver.status).toBe(200)

    const login = await api('POST', '/login', { email, password: 'CorrectHorse9' })
    expect(login.status).toBe(200)
    expect(typeof login.json.token).toBe('string')
    expect(login.json.expiresAt).toBeGreaterThan(Date.now())
}, 20000)

it('rejects weak password and invalid email at registration', async () => {
    expect((await api('POST', '/register', { email: 'b@example.com', password: 'short' })).json.error).toBe('password-too-weak')
    expect((await api('POST', '/register', { email: 'not-an-email', password: 'CorrectHorse9' })).json.error).toBe('invalid-email')
})

it('login failures are generic (no email enumeration) and rate-limited', async () => {
    const email = 'carol@example.com'
    await registerVerifyLogin(email)
    // wrong password AND nonexistent email -> identical error
    const bad = await api('POST', '/login', { email, password: 'WrongPassword1' })
    const ghost = await api('POST', '/login', { email: 'ghost@example.com', password: 'WhateverPass1' })
    expect(bad.status).toBe(401)
    expect(bad.json.error).toBe('invalid-credentials')
    expect(ghost.json.error).toBe('invalid-credentials')
    // hammer to trip the limiter (5 fails already includes 'bad' above -> a few more)
    let last = bad
    for (let i = 0; i < 6; i++) { last = await api('POST', '/login', { email, password: 'WrongPassword1' }) }
    expect(last.status).toBe(429)
    expect(last.json.error).toBe('rate-limited')
}, 30000)

it('verify-email and reset-password rate-limit code brute-force (same per-email lockout as login)', async () => {
    // Isolated relay: the extra registrations + lockouts must not touch the shared server's per-IP
    // registration budget or rate-limiter state that later tests rely on.
    const mails: any[] = []
    const r2 = await server.startRelay(0, {
        requireAuth: true, ephemeral: true,
        email: { apiKey: 'test', from: 'noreply@test', sendFn: async (o: any) => { mails.push(o) } },
    })
    const base2 = r2.url.replace('ws://', 'http://')
    const post = (path: string, body: any): Promise<{ status: number, json: any }> => new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body))
        const u = new URL(base2 + path)
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
            let b = ''
            res.setEncoding('utf-8')
            res.on('data', c => { b += c })
            res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(b || '{}') }) } catch { resolve({ status: res.statusCode ?? 0, json: {} }) } })
        })
        req.on('error', reject)
        req.write(data)
        req.end()
    })
    const codeOf = (email: string): string => {
        const mail = [...mails].reverse().find(m => m.to === email)
        const m = mail && /(\d{6})/.exec(mail.text)
        return m ? m[1] : ''
    }
    try {
        // verify-email: a 6-digit code must not be brute-forceable, so wrong codes trip the limiter.
        const ve = 'brute-verify@example.com'
        expect((await post('/register', { email: ve, password: 'CorrectHorse9' })).status).toBe(200)
        let v = await post('/verify-email', { email: ve, code: '000000' })
        expect(v.status).toBe(400)
        for (let i = 0; i < 6; i++) { v = await post('/verify-email', { email: ve, code: '000000' }) }
        expect(v.status).toBe(429)
        expect(v.json.error).toBe('rate-limited')

        // reset-password: same protection on its 6-digit code (expiry window alone is not enough).
        const rp = 'brute-reset@example.com'
        await post('/register', { email: rp, password: 'CorrectHorse9' })
        await post('/verify-email', { email: rp, code: codeOf(rp) })
        await post('/request-password-reset', { email: rp })
        let r = await post('/reset-password', { email: rp, code: '000000', newPassword: 'BrandNewHorse9' })
        expect(r.status).toBe(400)
        for (let i = 0; i < 6; i++) { r = await post('/reset-password', { email: rp, code: '000000', newPassword: 'BrandNewHorse9' }) }
        expect(r.status).toBe(429)
        expect(r.json.error).toBe('rate-limited')
    } finally {
        await r2.close()
    }
}, 40000)

it('WS create-session is gated: rejected without a token, accepted with one', async () => {
    const noAuth = await createSessionWs()
    expect(noAuth.t).toBe('error')
    expect(noAuth.code).toBe('unauthorized')

    const token = await registerVerifyLogin('dave@example.com')
    const ok = await createSessionWs(token)
    expect(ok.t).toBe('session-created')
    expect(ok.room).toMatch(/^[2-9A-HJ-NP-Z]{6}$/)
    expect(ok.magicLink).toContain('/s/')
}, 20000)

it('optional TOTP: setup -> enable -> login needs 2FA -> verify issues token', async () => {
    const email = 'erin@example.com'
    const token = await registerVerifyLogin(email)

    const setup = await api('POST', '/2fa/setup', {}, token)
    expect(setup.status).toBe(200)
    const secret = setup.json.secret as string
    expect(secret.length).toBeGreaterThan(10)

    const enable = await api('POST', '/2fa/enable', { code: server.totpAt(secret, Math.floor(Date.now() / 30000)) }, token)
    expect(enable.status).toBe(200)

    const login = await api('POST', '/login', { email, password: 'CorrectHorse9' })
    expect(login.json.needsTotp).toBe(true)
    expect(typeof login.json.sessionKey).toBe('string')

    const verify = await api('POST', '/2fa/verify', { sessionKey: login.json.sessionKey, code: server.totpAt(secret, Math.floor(Date.now() / 30000)) })
    expect(verify.status).toBe(200)
    expect(typeof verify.json.token).toBe('string')
}, 25000)

it('auto-verifies and returns a token when no email is configured', async () => {
    const r2 = await server.startRelay(0, { requireAuth: true, ephemeral: true }) // no email cfg -> log path
    const base2 = r2.url.replace('ws://', 'http://')
    const post = (path: string, body: any): Promise<{ status: number, json: any }> => new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body))
        const u = new URL(base2 + path)
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
            let b = ''
            res.on('data', c => { b += c })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(b || '{}') }))
        })
        req.on('error', reject)
        req.write(data)
        req.end()
    })
    const r = await post('/register', { email: 'noemail@example.com', password: 'CorrectHorse9' })
    expect(r.status).toBe(200)
    expect(typeof r.json.token).toBe('string')
    expect(r.json.autoVerified).toBe(true)
    await r2.close()
}, 15000)

it('logout revokes the token (dashboard then unauthorized)', async () => {
    const token = await registerVerifyLogin('frank@example.com')
    const before = await api('GET', '/sessions', undefined, token)
    expect(before.status).toBe(200)
    expect(before.json.account.email).toBe('frank@example.com')

    const out = await api('POST', '/logout', {}, token)
    expect(out.status).toBe(200)

    const after = await api('GET', '/sessions', undefined, token)
    expect(after.status).toBe(401)
}, 20000)
