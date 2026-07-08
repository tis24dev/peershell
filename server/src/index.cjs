/**
 * @peershell/server — rendezvous + blind relay + reverse HTTP tunnel + accounts.
 *
 * Relay: pairs one host + one guest by room-code / magic-link token, forwards every frame verbatim,
 * and serves the host-embedded web-client to browsers that open the magic-link (GET /s/<token>).
 *
 * Accounts (Stage 6): open registration + email verification (mock-logged for MVP; SMTP = Stage 7),
 * login -> opaque bearer token, optional TOTP 2FA, logout/refresh, dashboard (GET /sessions).
 * create-session over WS is GATED behind a valid account token (?token= on the WS upgrade URL):
 * without it, anyone reaching the public server could open sessions. Guests do NOT need an account
 * (they authenticate to the host with the per-session PIN, peer-to-peer).
 *
 * Persistence: atomic JSON file (data/accounts.json, mode 0600). Falls back to in-memory (ephemeral)
 * when the data dir is not writable, or when opts.ephemeral is set (tests).
 *
 * Library:   const { startRelay } = require('./index.cjs'); const s = await startRelay(0, { requireAuth:false })
 * Standalone: node server/src/index.cjs   (env: PORT, BIND, PUBLIC_URL, TOKEN_TTL_MS, PEERSHELL_DATA)
 */
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000 // magic-link
const DEFAULT_AUTH_TTL_MS = 24 * 60 * 60 * 1000 // account bearer token
const IDLE_TIMEOUT_MS = 90 * 1000
const PBKDF2_ITERS = 100000
const MIN_PASSWORD = 8
const MAX_BODY = 64 * 1024
const LOGIN_MAX_FAILS = 5
const LOGIN_LOCK_MS = 15 * 60 * 1000
const REG_MAX_PER_IP = 5
const REG_WINDOW_MS = 24 * 60 * 60 * 1000
const TOTP_SESSION_TTL_MS = 5 * 60 * 1000
const TOTP_MAX_FAILS = 3
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function genCode(n = 6) {
    const bytes = crypto.randomBytes(n)
    let out = ''
    for (let i = 0; i < n; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    }
    return out
}
const genToken = () => crypto.randomBytes(18).toString('base64url')
const genAuthToken = () => crypto.randomBytes(32).toString('base64url')
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex')
const j = obj => JSON.stringify({ v: 1, ...obj })

function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex')
    const hash = crypto.pbkdf2Sync(password, s, PBKDF2_ITERS, 32, 'sha256').toString('base64')
    return { salt: s, hash }
}
function verifyPassword(password, salt, expected) {
    const h = crypto.pbkdf2Sync(password, salt || '', PBKDF2_ITERS, 32, 'sha256').toString('base64')
    const a = Buffer.from(h)
    const b = Buffer.from(expected || '')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// --- TOTP (RFC 6238, SHA-1/30s/6-digit) — inline, zero deps ---
function base32Encode(buf) {
    let bits = ''
    for (const byte of buf) {
        bits += byte.toString(2).padStart(8, '0')
    }
    let out = ''
    for (let i = 0; i + 5 <= bits.length; i += 5) {
        out += B32[parseInt(bits.slice(i, i + 5), 2)]
    }
    return out
}
function base32Decode(str) {
    let bits = ''
    for (const c of String(str).toUpperCase().replace(/=+$/, '')) {
        const idx = B32.indexOf(c)
        if (idx >= 0) {
            bits += idx.toString(2).padStart(5, '0')
        }
    }
    const bytes = []
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2))
    }
    return Buffer.from(bytes)
}
function totpAt(secretB32, counter) {
    const key = base32Decode(secretB32)
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(counter))
    const hmac = crypto.createHmac('sha1', key).update(buf).digest()
    const off = hmac[hmac.length - 1] & 0xf
    const bin = hmac.readUInt32BE(off) & 0x7fffffff
    return (bin % 1000000).toString().padStart(6, '0')
}
function verifyTOTP(secretB32, code, atMs, window = 1) {
    if (!/^\d{6}$/.test(String(code || ''))) {
        return false
    }
    const counter = Math.floor(atMs / 30000)
    for (let i = -window; i <= window; i++) {
        if (totpAt(secretB32, counter + i) === String(code)) {
            return true
        }
    }
    return false
}

/**
 * @param {number} port
 * @param {{ host?, publicUrl?, tokenTtlMs?, authTtlMs?, requireAuth?, ephemeral?, dataDir? }} [opts]
 */
function startRelay(port = 0, opts = {}) {
    return new Promise(resolve => {
        const bindHost = opts.host || '127.0.0.1'
        const tokenTtlMs = opts.tokenTtlMs || DEFAULT_TOKEN_TTL_MS
        const authTtlMs = opts.authTtlMs || DEFAULT_AUTH_TTL_MS
        const requireAuth = opts.requireAuth !== false // default ON (production-safe)
        let boundPort = port
        let publicUrl = opts.publicUrl || ''

        const rooms = new Map() // room -> { host, guest, accountId, magicLink, createdAt }
        const magicTokens = new Map() // magic-link token -> { room, expiresAt }
        const pendingHttp = new Map() // reqId -> http res
        const loginFails = new Map() // email -> { count, until, blocks }
        const regByIp = new Map() // ip -> { count, resetAt }
        const totpSessions = new Map() // sessionKey -> { accountId, expiresAt, fails }

        const now = () => Date.now()

        // ---------- account store (atomic JSON, or ephemeral) ----------
        const dataDir = opts.dataDir || process.env.PEERSHELL_DATA || path.join(__dirname, '..', 'data')
        const accountsFile = path.join(dataDir, 'accounts.json')
        let store = { accounts: [], tokens: [] }
        let ephemeral = !!opts.ephemeral
        if (!ephemeral) {
            try {
                const raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'))
                store = { accounts: raw.accounts || [], tokens: raw.tokens || [] }
            } catch { /* fresh store */ }
            try {
                fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
                fs.accessSync(dataDir, fs.constants.W_OK)
            } catch {
                ephemeral = true
                console.warn('[peershell-server] data dir not writable -> ephemeral accounts (lost on restart)')
            }
        }
        function saveStore() {
            if (ephemeral) {
                return
            }
            try {
                const tmp = `${accountsFile}.tmp`
                fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 })
                fs.renameSync(tmp, accountsFile)
            } catch (e) {
                console.warn('[peershell-server] saveStore failed:', e && e.message)
            }
        }
        const findAccount = email => store.accounts.find(a => a.email === String(email || '').toLowerCase())
        function accountFromToken(token) {
            if (!token) {
                return null
            }
            const th = sha256hex(token)
            const rec = store.tokens.find(t => t.tokenHash === th)
            if (!rec || rec.revokedAt || rec.expiresAt < now()) {
                return null
            }
            return store.accounts.find(a => a.id === rec.accountId && !a.revoked) || null
        }
        function issueAuthToken(accountId) {
            const token = genAuthToken()
            const expiresAt = now() + authTtlMs
            store.tokens.push({ tokenHash: sha256hex(token), accountId, createdAt: now(), expiresAt, revokedAt: null })
            saveStore()
            return { token, expiresAt }
        }

        // ---------- rate-limit helpers ----------
        const loginLockedUntil = email => {
            const r = loginFails.get(email)
            return r && r.until > now() ? r.until : 0
        }
        function recordLoginFail(email) {
            const r = loginFails.get(email) || { count: 0, until: 0, blocks: 0 }
            r.count++
            if (r.count >= LOGIN_MAX_FAILS) {
                r.blocks++
                r.until = now() + LOGIN_LOCK_MS * Math.min(4, r.blocks)
                r.count = 0
            }
            loginFails.set(email, r)
        }
        function regAllowed(ip) {
            const r = regByIp.get(ip)
            if (!r || r.resetAt < now()) {
                regByIp.set(ip, { count: 1, resetAt: now() + REG_WINDOW_MS })
                return true
            }
            if (r.count >= REG_MAX_PER_IP) {
                return false
            }
            r.count++
            return true
        }
        const clientIp = req =>
            req.headers['cf-connecting-ip'] ||
            String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
            (req.socket && req.socket.remoteAddress) || 'unknown'
        const failDelay = () => new Promise(r => setTimeout(r, 100 + (crypto.randomBytes(1)[0] / 255) * 400))

        // ---------- HTTP helpers ----------
        function sendJson(res, status, obj) {
            const b = Buffer.from(JSON.stringify(obj))
            res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length })
            res.end(b)
        }
        function readJson(req, cb) {
            let body = ''
            let bad = false
            req.on('data', c => {
                body += c
                if (body.length > MAX_BODY) {
                    bad = true
                    req.destroy()
                }
            })
            req.on('end', () => {
                if (bad) {
                    return cb(null)
                }
                try {
                    cb(JSON.parse(body || '{}'))
                } catch {
                    cb(null)
                }
            })
            req.on('error', () => cb(null))
        }
        const bearer = req => {
            const h = req.headers.authorization || ''
            return h.startsWith('Bearer ') ? h.slice(7) : null
        }

        function magicRoom(token) {
            const rec = magicTokens.get(token)
            if (!rec) {
                return null
            }
            if (rec.expiresAt < now()) {
                magicTokens.delete(token)
                return null
            }
            return rec.room
        }
        function dropRoom(room) {
            rooms.delete(room)
            for (const [tok, rec] of magicTokens) {
                if (rec.room === room) {
                    magicTokens.delete(tok)
                }
            }
        }
        function safeSend(sock, data, binary) {
            if (sock && sock.readyState === sock.OPEN) {
                sock.send(data, { binary: !!binary })
            }
        }
        function resolveHttp(msg) {
            const res = pendingHttp.get(msg.reqId)
            if (res) {
                pendingHttp.delete(msg.reqId)
                res.writeHead(msg.status || 200, msg.headers || {})
                res.end(Buffer.from(msg.bodyBase64 || '', 'base64'))
            }
        }

        // ---------- REST endpoints ----------
        function handleRest(req, res) {
            const url = (req.url || '').split('?')[0]
            const method = req.method || 'GET'

            if (method === 'GET' && url === '/sessions') {
                const acct = accountFromToken(bearer(req))
                if (!acct) {
                    return sendJson(res, 401, { error: 'unauthorized' })
                }
                const sessions = []
                for (const [room, e] of rooms) {
                    if (e.accountId === acct.id) {
                        sessions.push({ room, magicLink: e.magicLink, createdAt: e.createdAt, hasGuest: !!e.guest })
                    }
                }
                return sendJson(res, 200, {
                    account: { email: acct.email, totpEnabled: !!acct.totpEnabled },
                    sessions,
                })
            }
            if (method !== 'POST') {
                return sendJson(res, 404, { error: 'not-found' })
            }

            readJson(req, async body => {
                if (!body) {
                    return sendJson(res, 400, { error: 'bad-request' })
                }
                switch (url) {
                    case '/register': {
                        const ip = clientIp(req)
                        const email = String(body.email || '').toLowerCase().trim()
                        const password = String(body.password || '')
                        if (!EMAIL_RE.test(email)) {
                            return sendJson(res, 400, { error: 'invalid-email' })
                        }
                        if (password.length < MIN_PASSWORD) {
                            return sendJson(res, 400, { error: 'password-too-weak', min: MIN_PASSWORD })
                        }
                        if (!regAllowed(ip)) {
                            return sendJson(res, 429, { error: 'rate-limited', retryAfter: REG_WINDOW_MS / 1000 })
                        }
                        const existing = findAccount(email)
                        const verifyCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0')
                        if (existing) {
                            if (!existing.verified) {
                                existing.verifyCode = verifyCode
                                saveStore()
                                console.log(`[peershell] verify code for ${email}: ${verifyCode}`)
                            }
                            // anti-enumeration: same response whether new or existing
                            return sendJson(res, 200, { ok: true, needsVerification: true })
                        }
                        const { salt, hash } = hashPassword(password)
                        store.accounts.push({
                            id: crypto.randomUUID(), email, salt, hash,
                            verified: false, verifyCode,
                            totpSecret: null, totpEnabled: false, pendingTotpSecret: null,
                            createdAt: now(), lastLogin: null, revoked: false,
                        })
                        saveStore()
                        console.log(`[peershell] verify code for ${email}: ${verifyCode}`)
                        return sendJson(res, 200, { ok: true, needsVerification: true })
                    }
                    case '/verify-email': {
                        const email = String(body.email || '').toLowerCase().trim()
                        const code = String(body.code || '')
                        const acct = findAccount(email)
                        if (acct && !acct.verified && acct.verifyCode &&
                            code.length === acct.verifyCode.length &&
                            crypto.timingSafeEqual(Buffer.from(code), Buffer.from(acct.verifyCode))) {
                            acct.verified = true
                            acct.verifyCode = null
                            saveStore()
                            return sendJson(res, 200, { ok: true })
                        }
                        return sendJson(res, 400, { error: 'invalid' })
                    }
                    case '/login': {
                        const email = String(body.email || '').toLowerCase().trim()
                        const password = String(body.password || '')
                        const lockUntil = loginLockedUntil(email)
                        if (lockUntil) {
                            return sendJson(res, 429, { error: 'rate-limited', retryAfter: Math.ceil((lockUntil - now()) / 1000) })
                        }
                        const acct = findAccount(email)
                        const ok = acct && verifyPassword(password, acct.salt, acct.hash)
                        if (!ok) {
                            recordLoginFail(email)
                            await failDelay()
                            return sendJson(res, 401, { error: 'invalid-credentials' })
                        }
                        if (!acct.verified) {
                            return sendJson(res, 403, { error: 'needs-verification' })
                        }
                        loginFails.delete(email)
                        acct.lastLogin = now()
                        if (acct.totpEnabled) {
                            const sessionKey = genAuthToken()
                            totpSessions.set(sessionKey, { accountId: acct.id, expiresAt: now() + TOTP_SESSION_TTL_MS, fails: 0 })
                            saveStore()
                            return sendJson(res, 200, { needsTotp: true, sessionKey })
                        }
                        saveStore()
                        const t = issueAuthToken(acct.id)
                        return sendJson(res, 200, { token: t.token, expiresAt: t.expiresAt })
                    }
                    case '/2fa/verify': {
                        const sk = String(body.sessionKey || '')
                        const sess = totpSessions.get(sk)
                        if (!sess || sess.expiresAt < now()) {
                            totpSessions.delete(sk)
                            return sendJson(res, 401, { error: 'expired' })
                        }
                        const acct = store.accounts.find(a => a.id === sess.accountId)
                        if (!acct || !verifyTOTP(acct.totpSecret, body.code, now())) {
                            sess.fails++
                            if (sess.fails >= TOTP_MAX_FAILS) {
                                totpSessions.delete(sk)
                                if (acct) {
                                    recordLoginFail(acct.email)
                                }
                                return sendJson(res, 429, { error: 'too-many-attempts' })
                            }
                            return sendJson(res, 401, { error: 'invalid-code', remaining: TOTP_MAX_FAILS - sess.fails })
                        }
                        totpSessions.delete(sk)
                        const t = issueAuthToken(acct.id)
                        return sendJson(res, 200, { token: t.token, expiresAt: t.expiresAt })
                    }
                    case '/2fa/setup': {
                        const acct = accountFromToken(bearer(req))
                        if (!acct) {
                            return sendJson(res, 401, { error: 'unauthorized' })
                        }
                        const secret = base32Encode(crypto.randomBytes(20))
                        acct.pendingTotpSecret = secret
                        saveStore()
                        const label = encodeURIComponent(`peershell:${acct.email}`)
                        const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=peershell`
                        return sendJson(res, 200, { secret, otpauthUrl })
                    }
                    case '/2fa/enable': {
                        const acct = accountFromToken(bearer(req))
                        if (!acct) {
                            return sendJson(res, 401, { error: 'unauthorized' })
                        }
                        if (!acct.pendingTotpSecret || !verifyTOTP(acct.pendingTotpSecret, body.code, now())) {
                            return sendJson(res, 400, { error: 'invalid-code' })
                        }
                        acct.totpSecret = acct.pendingTotpSecret
                        acct.pendingTotpSecret = null
                        acct.totpEnabled = true
                        saveStore()
                        console.log(`[peershell] 2fa enabled for ${acct.email}`)
                        return sendJson(res, 200, { ok: true })
                    }
                    case '/2fa/disable': {
                        const acct = accountFromToken(bearer(req))
                        if (!acct) {
                            return sendJson(res, 401, { error: 'unauthorized' })
                        }
                        if (!verifyPassword(String(body.password || ''), acct.salt, acct.hash)) {
                            return sendJson(res, 401, { error: 'invalid-credentials' })
                        }
                        acct.totpEnabled = false
                        acct.totpSecret = null
                        acct.pendingTotpSecret = null
                        saveStore()
                        console.log(`[peershell] 2fa disabled for ${acct.email}`)
                        return sendJson(res, 200, { ok: true })
                    }
                    case '/logout': {
                        const token = bearer(req)
                        const th = token && sha256hex(token)
                        const rec = th && store.tokens.find(t => t.tokenHash === th)
                        if (rec) {
                            rec.revokedAt = now()
                            saveStore()
                        }
                        return sendJson(res, 200, { ok: true })
                    }
                    case '/session/refresh': {
                        const token = bearer(req)
                        const acct = accountFromToken(token)
                        if (!acct) {
                            return sendJson(res, 401, { error: 'unauthorized' })
                        }
                        const rec = store.tokens.find(t => t.tokenHash === sha256hex(token))
                        if (rec) {
                            rec.revokedAt = now()
                        }
                        const t = issueAuthToken(acct.id)
                        return sendJson(res, 200, { token: t.token, expiresAt: t.expiresAt })
                    }
                    default:
                        return sendJson(res, 404, { error: 'not-found' })
                }
            })
        }

        const REST_POST = new Set(['/register', '/verify-email', '/login', '/2fa/verify', '/2fa/setup', '/2fa/enable', '/2fa/disable', '/logout', '/session/refresh'])

        const server = http.createServer((req, res) => {
            const url = (req.url || '').split('?')[0]
            const method = req.method || 'GET'
            if ((method === 'GET' && url === '/sessions') || (method === 'POST' && REST_POST.has(url))) {
                return handleRest(req, res)
            }
            if (url === '/health') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, sessions: rooms.size, accounts: store.accounts.length }))
                return
            }
            const m = /^\/s\/([^/?#]+)/.exec(req.url || '')
            if (!m) {
                res.writeHead(200, { 'content-type': 'text/plain' })
                res.end('peershell server\n')
                return
            }
            const room = magicRoom(m[1])
            const entry = room && rooms.get(room)
            if (!entry || !entry.host) {
                res.writeHead(410, { 'content-type': 'text/plain' })
                res.end('link expired or unknown session')
                return
            }
            const reqId = crypto.randomBytes(6).toString('hex')
            pendingHttp.set(reqId, res)
            safeSend(entry.host, j({ t: 'http-get', peerId: 0, reqId, path: '/' }), false)
            const to = setTimeout(() => {
                if (pendingHttp.has(reqId)) {
                    pendingHttp.delete(reqId)
                    res.writeHead(504)
                    res.end('tunnel timeout')
                }
            }, 5000)
            if (typeof to.unref === 'function') {
                to.unref()
            }
        })

        const wss = new WebSocketServer({ server })

        wss.on('connection', (sock, req) => {
            sock._room = null
            sock._peer = null
            sock._kind = 'desktop'
            sock._role = 'guest'
            sock._lastSeen = now()
            // account token (host) rides on the WS upgrade URL query: ?token=<accountToken>
            let acct = null
            try {
                const q = new URL(req.url || '/', 'http://x').searchParams.get('token')
                acct = q ? accountFromToken(q) : null
            } catch { /* ignore */ }
            sock._account = acct

            sock.on('message', (data, isBinary) => {
                sock._lastSeen = now()
                if (isBinary) {
                    if (sock._peer) {
                        safeSend(sock._peer, data, true)
                    }
                    return
                }
                const text = data.toString()
                let msg = null
                try {
                    msg = JSON.parse(text)
                } catch { /* ignore non-JSON text */ }
                if (msg && msg.t === 'ping') {
                    safeSend(sock, j({ t: 'pong' }), false)
                    return
                }
                if (msg && msg.t === 'pong') {
                    return
                }
                if (msg && msg.t === 'http-response') {
                    resolveHttp(msg)
                    return
                }
                if (sock._peer) {
                    safeSend(sock._peer, text, false)
                    return
                }
                if (msg) {
                    handleSignal(sock, msg)
                }
            })

            sock.on('close', () => {
                const room = sock._room
                if (room && rooms.has(room)) {
                    const entry = rooms.get(room)
                    const other = entry.host === sock ? entry.guest : entry.host
                    safeSend(other, j({ t: 'peer-left', reason: 'socket-closed' }), false)
                    if (entry.host === sock) {
                        dropRoom(room)
                    } else {
                        entry.guest = null
                        entry.host._peer = null
                    }
                }
            })
        })

        function handleSignal(sock, msg) {
            switch (msg.t) {
                case 'hello':
                    sock._kind = msg.kind || 'desktop'
                    sock._role = msg.role || 'guest'
                    break
                case 'create-session': {
                    if (requireAuth && !sock._account) {
                        safeSend(sock, j({ t: 'error', code: 'unauthorized', message: 'login required to share' }), false)
                        return
                    }
                    const room = genCode()
                    const token = genToken()
                    const base = publicUrl || `http://127.0.0.1:${boundPort}`
                    const magicLink = `${base}/s/${token}`
                    rooms.set(room, {
                        host: sock, guest: null,
                        accountId: sock._account ? sock._account.id : null,
                        magicLink, createdAt: now(),
                    })
                    magicTokens.set(token, { room, expiresAt: now() + tokenTtlMs })
                    sock._room = room
                    safeSend(sock, j({ t: 'session-created', room, magicLink }), false)
                    break
                }
                case 'join': {
                    const room = msg.room ? String(msg.room).toUpperCase() : (msg.token ? magicRoom(msg.token) : null)
                    const entry = room && rooms.get(room)
                    if (!entry) {
                        safeSend(sock, j({ t: 'error', code: msg.token ? 'link-expired' : 'no-such-room' }), false)
                        return
                    }
                    if (entry.guest) {
                        safeSend(sock, j({ t: 'error', code: 'session-busy' }), false)
                        return
                    }
                    entry.guest = sock
                    sock._room = room
                    sock._peer = entry.host
                    entry.host._peer = sock
                    safeSend(entry.host, j({ t: 'peer-joined', peerId: 0, kind: sock._kind }), false)
                    break
                }
                default:
                    break
            }
        }

        // Reap idle sockets + prune expired auth tokens / totp sessions.
        const reaper = setInterval(() => {
            const cutoff = now() - IDLE_TIMEOUT_MS
            for (const c of wss.clients) {
                if (c._lastSeen < cutoff) {
                    try { c.terminate() } catch { /* ignore */ }
                }
            }
            const before = store.tokens.length
            store.tokens = store.tokens.filter(t => t.expiresAt > now() && !t.revokedAt)
            if (store.tokens.length !== before) {
                saveStore()
            }
            for (const [k, s] of totpSessions) {
                if (s.expiresAt < now()) {
                    totpSessions.delete(k)
                }
            }
        }, 30000)
        if (typeof reaper.unref === 'function') {
            reaper.unref()
        }

        server.listen(port, bindHost, () => {
            boundPort = server.address().port
            if (!publicUrl) {
                publicUrl = `http://${bindHost}:${boundPort}`
            }
            resolve({
                port: boundPort,
                url: `ws://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${boundPort}`,
                publicUrl,
                requireAuth,
                ephemeral,
                close: () => new Promise(res => {
                    clearInterval(reaper)
                    for (const c of wss.clients) {
                        try { c.terminate() } catch { /* ignore */ }
                    }
                    wss.close(() => server.close(() => res()))
                }),
            })
        })
    })
}

module.exports = { startRelay, hashPassword, verifyPassword, base32Encode, base32Decode, totpAt, verifyTOTP }

if (require.main === module) {
    const port = Number(process.env.PORT || 8787)
    const host = process.env.BIND || '0.0.0.0'
    const publicUrl = process.env.PUBLIC_URL || ''
    const tokenTtlMs = process.env.TOKEN_TTL_MS ? Number(process.env.TOKEN_TTL_MS) : undefined
    startRelay(port, { host, publicUrl, tokenTtlMs }).then(s => {
        console.log(`[peershell-server] listening ws://${host}:${s.port}  public=${s.publicUrl || '(none)'}  auth=${s.requireAuth}  ${s.ephemeral ? 'EPHEMERAL' : 'persisted'}`)
    })
}
