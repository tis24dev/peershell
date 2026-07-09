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
const https = require('https')
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
// Auth credential carried in the WS handshake as Sec-WebSocket-Protocol: peershell.bearer.<base64url>,
// with the non-secret sentinel peershell.v1 echoed back. Keeps the token out of the logged URL query.
const AUTH_SENTINEL = 'peershell.v1'
const BEARER_PREFIX = 'peershell.bearer.'

/** Decode the account token from the Sec-WebSocket-Protocol header, or null if absent/malformed. */
function bearerFromProtocolHeader(header) {
    if (!header) {
        return null
    }
    for (const part of String(header).split(',')) {
        const v = part.trim()
        if (v.startsWith(BEARER_PREFIX)) {
            const b64 = v.slice(BEARER_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
            try {
                return Buffer.from(b64, 'base64').toString('utf8') || null
            } catch {
                return null
            }
        }
    }
    return null
}
const TOTP_SESSION_TTL_MS = 5 * 60 * 1000
const TOTP_MAX_FAILS = 3
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function genCode(n = 6) {
    let out = ''
    for (let i = 0; i < n; i++) {
        // crypto.randomInt is unbiased (rejection sampling); avoids the modulo bias of randomBytes % len.
        out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)]
    }
    return out
}
const genToken = () => crypto.randomBytes(18).toString('base64url')
const genAuthToken = () => crypto.randomBytes(32).toString('base64url')
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex')
const j = obj => JSON.stringify({ v: 1, ...obj })

// --- email delivery (Brevo transactional API; stdlib https, zero deps) ---
// We relay through Brevo (not direct VM SMTP) so mail is DKIM/SPF-authoritative for the domain and
// the VM IP is never in the sending path (no blacklist risk). No key configured -> log the code.
function brevoSend(opts) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            sender: { email: opts.from, name: opts.fromName || 'peershell' },
            to: [{ email: opts.to }],
            subject: opts.subject,
            textContent: opts.text,
        })
        const req = https.request({
            hostname: 'api.brevo.com',
            path: '/v3/smtp/email',
            method: 'POST',
            headers: {
                'api-key': opts.apiKey,
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
        }, res => {
            let b = ''
            res.on('data', c => { b += c })
            res.on('end', () => {
                if ((res.statusCode || 500) < 300) {
                    resolve({ status: res.statusCode, body: b })
                } else {
                    reject(new Error(`brevo ${res.statusCode}: ${b.slice(0, 200)}`))
                }
            })
        })
        req.on('error', reject)
        req.setTimeout(10000, () => req.destroy(new Error('brevo timeout')))
        req.write(payload)
        req.end()
    })
}

async function deliverVerifyCode(email, code, cfg = {}, kind = 'verification') {
    const isReset = kind === 'reset'
    const subject = isReset ? 'Your peershell password reset code' : 'Your peershell verification code'
    const text = isReset
        ? `Your peershell password reset code is: ${code}\n\nEnter it in the app to set a new password.\nIf you did not request this, you can ignore this email.`
        : `Your peershell verification code is: ${code}\n\nEnter it in the app to finish creating your account.\nIf you did not request this, you can ignore this email.`
    const label = isReset ? 'reset code' : 'verify code'
    if (cfg.apiKey) {
        const send = cfg.sendFn || brevoSend
        try {
            await send({
                apiKey: cfg.apiKey,
                from: cfg.from || 'noreply@peershell.dev',
                fromName: cfg.fromName || 'peershell',
                to: email,
                subject,
                text,
            })
            return { delivered: 'email' }
        } catch (e) {
            console.warn(`[peershell] ${label} email to ${email} failed (${e.message}); logging as fallback`)
            console.log(`[peershell] ${label} for ${email}: ${code}`)
            return { delivered: 'log-fallback' }
        }
    }
    console.log(`[peershell] ${label} for ${email}: ${code}`)
    return { delivered: 'log' }
}

// Passwords are stored ONLY as a salted, one-way scrypt hash (memory-hard) — never plaintext, and not
// recoverable by anyone (including us). Self-describing format: scrypt$N$r$p$saltHex$hashHex. Legacy
// pbkdf2 accounts (salt+hash fields) still verify and are upgraded to scrypt on next successful login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
function hashPassword(password) {
    const salt = crypto.randomBytes(16)
    const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`
}
function verifyPassword(account, password) {
    const stored = account && account.pwhash
    if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
        const parts = stored.split('$')
        if (parts.length !== 6) {
            return false
        }
        const expected = Buffer.from(parts[5], 'hex')
        let derived
        try {
            derived = crypto.scryptSync(password, Buffer.from(parts[4], 'hex'), expected.length,
                { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) })
        } catch {
            return false
        }
        return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
    }
    // legacy pbkdf2 (salt + base64 hash)
    if (account && account.salt && account.hash) {
        const h = crypto.pbkdf2Sync(password, account.salt, PBKDF2_ITERS, 32, 'sha256').toString('base64')
        const a = Buffer.from(h)
        const b = Buffer.from(account.hash)
        return a.length === b.length && crypto.timingSafeEqual(a, b)
    }
    return false
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
    // No padding strip needed: non-base32 chars (incl. '=') are skipped below (idx < 0).
    for (const c of String(str).toUpperCase()) {
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

// Minimal account dashboard served at GET / (same-origin -> no CORS). Login/register/recover, then a
// top bar (email + logout) and the account's sessions (live + closed/expired) with times and link.
const DASHBOARD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>peershell</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#111;background:#fff}
#bar{display:none;background:#111;color:#fff;padding:10px 14px;align-items:center;justify-content:space-between}
#bar.on{display:flex}
#app{padding:16px;max-width:720px;display:none}
#login{display:none;position:fixed;inset:0;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
#settings{padding:16px;max-width:720px;display:none}
.card{width:300px;max-width:92%}
code{background:#eee;padding:2px 6px;word-break:break-all}
input{display:block;margin:6px 0;padding:9px;width:280px;max-width:92%;box-sizing:border-box}
button{padding:8px 12px;margin:3px 3px 3px 0}
#msg{color:#a00;margin-top:8px}
table{border-collapse:collapse;width:100%;margin-top:12px}
th,td{border:1px solid #ccc;padding:7px;text-align:left;font-size:14px}
.live{color:#0a0;font-weight:bold}.dead{color:#999}
</style></head><body>
<div id="bar"><span id="who"></span><span><button onclick="openSettings()">settings</button><button onclick="logout()">logout</button></span></div>
<div id="login"><div class="card">
<h3>peershell</h3>
<input id="email" type="email" placeholder="email" autocomplete="username">
<input id="pass" type="password" placeholder="password" autocomplete="current-password">
<div><button onclick="login()">Log in</button><button onclick="register()">Register</button><button onclick="recover()">Recover password</button></div>
<div id="msg"></div>
</div></div>
<div id="app">
<h3>Your sessions</h3><button onclick="load()">Refresh</button>
<table><thead><tr><th>Status</th><th>Opened</th><th>Closed</th><th>Link</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<div id="settings">
<h3>Settings</h3><button onclick="showApp()">Back to sessions</button>
<div id="smenu" style="margin:12px 0"><p><button onclick="stab('pw')">Change password</button></p><p><button onclick="stab('2fa')">2FA</button></p></div>
<div id="pwPanel" style="display:none">
<p><button onclick="showMenu()">&larr; back</button></p>
<h4>Change password</h4>
<input id="cur" type="password" placeholder="current password" autocomplete="current-password">
<input id="np" type="password" placeholder="new password" autocomplete="new-password">
<div><button onclick="changePw()">Change password</button></div>
</div>
<div id="twoPanel" style="display:none">
<p><button onclick="showMenu()">&larr; back</button></p>
<h4>Two-factor authentication</h4>
<div id="twofa"></div>
</div>
</div>
<script src="/qrcode.js"></script>
<script>
var T=localStorage.getItem('ps_token')||'',EM=localStorage.getItem('ps_email')||'',TOTP=false,TOTPAT=0;
function $(i){return document.getElementById(i)}
function msg(t){$('msg').textContent=t||''}
function api(m,p,b,a){var h={'content-type':'application/json'};if(a&&T)h.authorization='Bearer '+T;
return fetch(p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j._s=r.status;return j})})}
function show(on){$('login').style.display=on?'none':'flex';$('app').style.display=on?'block':'none';$('settings').style.display='none';$('bar').className=on?'on':'';if(on){$('who').textContent=EM;load()}}
function save(e,t){T=t;EM=e;localStorage.setItem('ps_token',t);localStorage.setItem('ps_email',e);show(true)}
function login(){var e=$('email').value.trim().toLowerCase(),p=$('pass').value;api('POST','/login',{email:e,password:p}).then(function(r){
if(r.needsTotp){var c=prompt('Two-factor code:');if(!c)return;api('POST','/2fa/verify',{sessionKey:r.sessionKey,code:c}).then(function(x){x.token?save(e,x.token):msg('Invalid two-factor code')});return}
if(r.token){save(e,r.token);return}
if(r.error==='needs-verification'){verify(e,p);return}
msg(r.error==='invalid-credentials'?'Email or password is not valid':(r.error||'Error'))})}
function verify(e,p){var c=prompt('Verification code (from email or the server log):');if(!c)return;api('POST','/verify-email',{email:e,code:c}).then(function(r){r._s===200?api('POST','/login',{email:e,password:p}).then(function(x){x.token?save(e,x.token):msg('Login failed')}):msg('Invalid code')})}
function register(){var e=$('email').value.trim().toLowerCase(),p=$('pass').value;api('POST','/register',{email:e,password:p}).then(function(r){
if(r.token){save(e,r.token);return}
if(r.needsVerification){verify(e,p);return}
if(r.alreadyRegistered){msg('That email is already registered. Log in.');return}
msg(r.error==='password-too-weak'?'Password: at least 8 characters':(r.error==='invalid-email'?'Invalid email':(r.error||'Error')))})}
function recover(){var e=$('email').value.trim().toLowerCase();if(!e){msg('Enter your email');return}api('POST','/request-password-reset',{email:e}).then(function(){
var c=prompt('Reset code (from email or the server log):');if(!c)return;var np=prompt('New password (min 8):');if(!np)return;
api('POST','/reset-password',{email:e,code:c,newPassword:np}).then(function(r){msg(r._s===200?'Password changed. Log in.':'Reset failed')})})}
function logout(){api('POST','/logout',{},true).finally(function(){T='';localStorage.removeItem('ps_token');show(false)})}
function fmt(t){return t?new Date(t).toLocaleString():'-'}
function load(){api('GET','/sessions',null,true).then(function(r){if(r._s===401){logout();return}if(r.account){TOTP=!!r.account.totpEnabled;TOTPAT=r.account.totpEnabledAt||0}var b=$('rows');b.innerHTML='';
(r.sessions||[]).forEach(function(s){var tr=document.createElement('tr');
tr.innerHTML='<td class="'+(s.live?'live':'dead')+'">'+(s.live?'live':'ended')+'</td><td>'+fmt(s.createdAt)+'</td><td>'+fmt(s.endedAt)+'</td><td>'+(s.live?'<a href="'+s.magicLink+'" target="_blank">open</a>':'-')+'</td>';b.appendChild(tr)});
if(!(r.sessions||[]).length)b.innerHTML='<tr><td colspan="4">No sessions yet.</td></tr>'})}
function openSettings(){$('app').style.display='none';$('settings').style.display='block';showMenu()}
function showMenu(){$('smenu').style.display='block';$('pwPanel').style.display='none';$('twoPanel').style.display='none'}
function stab(w){$('smenu').style.display='none';$('pwPanel').style.display=w==='pw'?'block':'none';$('twoPanel').style.display=w==='2fa'?'block':'none';if(w==='2fa')renderTwofa()}
function showApp(){$('settings').style.display='none';$('app').style.display='block';load()}
function changePw(){var c=$('cur').value,n=$('np').value;api('POST','/change-password',{currentPassword:c,newPassword:n},true).then(function(r){alert(r._s===200?'Password changed':(r.error==='invalid-credentials'?'Current password is wrong':(r.error==='password-too-weak'?'New password: at least 8 characters':'Error')));if(r._s===200){$('cur').value='';$('np').value=''}})}
function renderTwofa(){$('twofa').innerHTML=TOTP?'<p>Status: <b>active</b>'+(TOTPAT?' (enabled on '+fmt(TOTPAT)+')':'')+'</p><input id="dpw" type="password" placeholder="password"><button onclick="disable2fa()">Disable 2FA</button>':'<p>Status: <b>not active</b></p><button onclick="setup2fa()">Enable 2FA</button>'}
function setup2fa(){api('POST','/2fa/setup',{},true).then(function(r){if(r._s!==200){alert('Error');return}var q='';try{var qr=qrcode(0,'M');qr.addData(r.otpauthUrl);qr.make();q=qr.createImgTag(5,8)}catch(e){}$('twofa').innerHTML='<p>Scan this QR with your authenticator app, then enter the 6-digit code:</p>'+q+'<p><small>Or enter the key manually: <code>'+r.secret+'</code></small></p><input id="ec" placeholder="6-digit code" inputmode="numeric"><button onclick="enable2fa()">Confirm</button>'})}
function enable2fa(){var c=($('ec').value||'').trim();api('POST','/2fa/enable',{code:c},true).then(function(r){if(r._s===200){TOTP=true;TOTPAT=Date.now();alert('2FA enabled');renderTwofa()}else alert('Invalid code')})}
function disable2fa(){var p=$('dpw').value;api('POST','/2fa/disable',{password:p},true).then(function(r){if(r._s===200){TOTP=false;TOTPAT=0;alert('2FA disabled');renderTwofa()}else alert('Wrong password')})}
show(!!T);
</script></body></html>`

// QR code generator (qrcode-generator, MIT, zero-dep) served at GET /qrcode.js so the dashboard can
// render the 2FA QR locally in the browser (the TOTP secret never leaves us for a third-party service).
let QRCODE_JS = ''
try {
    QRCODE_JS = fs.readFileSync(path.join(__dirname, 'qrcode.js'), 'utf8')
} catch { /* QR is optional; the dashboard falls back to the text key */ }

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
        const emailCfg = opts.email || {
            apiKey: process.env.BREVO_API_KEY || '',
            from: process.env.EMAIL_FROM || 'noreply@peershell.dev',
            fromName: process.env.EMAIL_FROM_NAME || 'peershell',
        }
        let boundPort = port
        let publicUrl = opts.publicUrl || ''

        // CSWSH defense: reject cross-origin browser WS upgrades. Non-browser clients (Node, the Tabby
        // Electron renderer whose origin is file://) send no browser origin and are allowed; the web
        // guest is same-origin as publicUrl. '*' in opts.allowedOrigins disables the check (escape hatch).
        const allowedOrigins = new Set((opts.allowedOrigins || []).map(String))
        try {
            if (publicUrl) {
                allowedOrigins.add(new URL(publicUrl).origin)
            }
        } catch { /* ignore malformed publicUrl */ }
        const originAllowed = origin => {
            if (allowedOrigins.has('*')) {
                return true
            }
            if (!origin || origin === 'null' || origin === 'file://') {
                return true // non-browser client or file:// (Electron renderer) — not a CSWSH vector
            }
            if (allowedOrigins.has(origin)) {
                return true
            }
            try {
                return !!publicUrl && new URL(publicUrl).origin === origin // picks up a post-bind publicUrl
            } catch {
                return false
            }
        }

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
        let store = { accounts: [], tokens: [], shares: [] }
        let ephemeral = !!opts.ephemeral
        if (!ephemeral) {
            try {
                const raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'))
                store = { accounts: raw.accounts || [], tokens: raw.tokens || [], shares: raw.shares || [] }
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
            endShare(room)
            rooms.delete(room)
            for (const [tok, rec] of magicTokens) {
                if (rec.room === room) {
                    magicTokens.delete(tok)
                }
            }
        }
        // Persisted share history for the dashboard: one record per created session, closed on host exit.
        function recordShare(room, accountId, magicLink) {
            store.shares.push({ room, accountId: accountId || null, magicLink, createdAt: now(), endedAt: null })
            if (store.shares.length > 1000) {
                store.shares = store.shares.slice(-1000)
            }
            saveStore()
        }
        function endShare(room) {
            for (let i = store.shares.length - 1; i >= 0; i--) {
                if (store.shares[i].room === room && !store.shares[i].endedAt) {
                    store.shares[i].endedAt = now()
                    saveStore()
                    return
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
                const sessions = store.shares
                    .filter(s => s.accountId === acct.id)
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map(s => {
                        const live = !s.endedAt && rooms.has(s.room)
                        return {
                            room: s.room,
                            magicLink: s.magicLink,
                            createdAt: s.createdAt,
                            endedAt: s.endedAt,
                            live,
                            hasGuest: live ? !!rooms.get(s.room).guest : false,
                        }
                    })
                return sendJson(res, 200, {
                    account: { email: acct.email, totpEnabled: !!acct.totpEnabled, totpEnabledAt: acct.totpEnabledAt || null },
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
                        if (existing) {
                            if (existing.verified) {
                                return sendJson(res, 200, { ok: true, alreadyRegistered: true })
                            }
                            existing.verifyCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0')
                            saveStore()
                            await deliverVerifyCode(email, existing.verifyCode, emailCfg)
                            return sendJson(res, 200, { ok: true, needsVerification: true })
                        }
                        const verifyCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0')
                        const acct = {
                            id: crypto.randomUUID(), email, pwhash: hashPassword(password),
                            verified: false, verifyCode,
                            totpSecret: null, totpEnabled: false, pendingTotpSecret: null,
                            createdAt: now(), lastLogin: null, revoked: false,
                        }
                        store.accounts.push(acct)
                        const d = await deliverVerifyCode(email, verifyCode, emailCfg)
                        if (d.delivered === 'email') {
                            saveStore()
                            return sendJson(res, 200, { ok: true, needsVerification: true })
                        }
                        // Email not deliverable (no SMTP / send failed): don't strand the user behind a
                        // code they can't receive — auto-verify and log them in immediately.
                        acct.verified = true
                        acct.verifyCode = null
                        acct.lastLogin = now()
                        const t = issueAuthToken(acct.id)
                        return sendJson(res, 200, { token: t.token, expiresAt: t.expiresAt, autoVerified: true })
                    }
                    case '/verify-email': {
                        const email = String(body.email || '').toLowerCase().trim()
                        const code = String(body.code || '')
                        // Rate-limit code guessing (6-digit code = 10^6 space): same per-email lockout as /login.
                        const lockUntil = loginLockedUntil(email)
                        if (lockUntil) {
                            return sendJson(res, 429, { error: 'rate-limited', retryAfter: Math.ceil((lockUntil - now()) / 1000) })
                        }
                        const acct = findAccount(email)
                        if (acct && !acct.verified && acct.verifyCode &&
                            code.length === acct.verifyCode.length &&
                            crypto.timingSafeEqual(Buffer.from(code), Buffer.from(acct.verifyCode))) {
                            acct.verified = true
                            acct.verifyCode = null
                            loginFails.delete(email)
                            saveStore()
                            return sendJson(res, 200, { ok: true })
                        }
                        recordLoginFail(email)
                        await failDelay()
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
                        const ok = !!acct && verifyPassword(acct, password)
                        if (!ok) {
                            recordLoginFail(email)
                            await failDelay()
                            return sendJson(res, 401, { error: 'invalid-credentials' })
                        }
                        if (!acct.verified) {
                            return sendJson(res, 403, { error: 'needs-verification' })
                        }
                        loginFails.delete(email)
                        if (typeof acct.pwhash !== 'string' || !acct.pwhash.startsWith('scrypt$')) { // upgrade a legacy pbkdf2 hash to scrypt on login
                            acct.pwhash = hashPassword(password)
                            delete acct.salt
                            delete acct.hash
                        }
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
                        acct.totpEnabledAt = now()
                        saveStore()
                        console.log(`[peershell] 2fa enabled for ${acct.email}`)
                        return sendJson(res, 200, { ok: true })
                    }
                    case '/2fa/disable': {
                        const acct = accountFromToken(bearer(req))
                        if (!acct) {
                            return sendJson(res, 401, { error: 'unauthorized' })
                        }
                        if (!verifyPassword(acct, String(body.password || ''))) {
                            return sendJson(res, 401, { error: 'invalid-credentials' })
                        }
                        acct.totpEnabled = false
                        acct.totpSecret = null
                        acct.pendingTotpSecret = null
                        acct.totpEnabledAt = null
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
                    case '/request-password-reset': {
                        const email = String(body.email || '').toLowerCase().trim()
                        const acct = findAccount(email)
                        if (acct && acct.verified) {
                            acct.resetCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0')
                            acct.resetExpiresAt = now() + 15 * 60 * 1000
                            saveStore()
                            await deliverVerifyCode(email, acct.resetCode, emailCfg, 'reset')
                        }
                        // anti-enumeration: always the same response
                        return sendJson(res, 200, { ok: true })
                    }
                    case '/reset-password': {
                        const email = String(body.email || '').toLowerCase().trim()
                        const code = String(body.code || '')
                        const newPassword = String(body.newPassword || '')
                        if (newPassword.length < MIN_PASSWORD) {
                            return sendJson(res, 400, { error: 'password-too-weak', min: MIN_PASSWORD })
                        }
                        // Rate-limit code guessing (6-digit code = 10^6 space): same per-email lockout as /login.
                        const lockUntil = loginLockedUntil(email)
                        if (lockUntil) {
                            return sendJson(res, 429, { error: 'rate-limited', retryAfter: Math.ceil((lockUntil - now()) / 1000) })
                        }
                        const acct = findAccount(email)
                        if (acct && acct.resetCode && acct.resetExpiresAt > now() &&
                            code.length === acct.resetCode.length &&
                            crypto.timingSafeEqual(Buffer.from(code), Buffer.from(acct.resetCode))) {
                            acct.pwhash = hashPassword(newPassword)
                            delete acct.salt
                            delete acct.hash
                            acct.resetCode = null
                            acct.resetExpiresAt = null
                            acct.verified = true
                            loginFails.delete(email)
                            saveStore()
                            return sendJson(res, 200, { ok: true })
                        }
                        recordLoginFail(email)
                        await failDelay()
                        return sendJson(res, 400, { error: 'invalid' })
                    }
                    case '/change-password': {
                        const acct = accountFromToken(bearer(req))
                        if (!acct) {
                            return sendJson(res, 401, { error: 'unauthorized' })
                        }
                        if (!verifyPassword(acct, String(body.currentPassword || ''))) {
                            return sendJson(res, 401, { error: 'invalid-credentials' })
                        }
                        const np = String(body.newPassword || '')
                        if (np.length < MIN_PASSWORD) {
                            return sendJson(res, 400, { error: 'password-too-weak', min: MIN_PASSWORD })
                        }
                        acct.pwhash = hashPassword(np)
                        delete acct.salt
                        delete acct.hash
                        saveStore()
                        return sendJson(res, 200, { ok: true })
                    }
                    default:
                        return sendJson(res, 404, { error: 'not-found' })
                }
            })
        }

        const REST_POST = new Set(['/register', '/verify-email', '/login', '/2fa/verify', '/2fa/setup', '/2fa/enable', '/2fa/disable', '/logout', '/session/refresh', '/request-password-reset', '/reset-password', '/change-password'])

        const server = http.createServer((req, res) => {
            const url = (req.url || '').split('?')[0]
            const method = req.method || 'GET'
            // CORS: the account REST API is called cross-origin from the Tabby/Electron renderer (and
            // the browser web-client). No cookies are used (bearer token in a header), so '*' is safe.
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            if (method === 'OPTIONS') {
                res.writeHead(204)
                res.end()
                return
            }
            if ((method === 'GET' && url === '/sessions') || (method === 'POST' && REST_POST.has(url))) {
                return handleRest(req, res)
            }
            if (url === '/health') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, sessions: rooms.size, accounts: store.accounts.length }))
                return
            }
            if (method === 'GET' && url === '/qrcode.js') {
                res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=86400' })
                res.end(QRCODE_JS)
                return
            }
            const m = /^\/s\/([^/?#]+)/.exec(req.url || '')
            if (!m) {
                if (method === 'GET' && (url === '/' || url === '/index.html')) {
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                    res.end(DASHBOARD_HTML)
                } else {
                    res.writeHead(404, { 'content-type': 'text/plain' })
                    res.end('not found\n')
                }
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

        const wss = new WebSocketServer({
            server,
            // Reject cross-origin browser upgrades before the socket opens (CSWSH). Note: verifyClient is
            // a browser-only defense (non-browser clients can forge Origin); the PIN gate is the real lock.
            verifyClient: (info, cb) => {
                if (originAllowed(info.origin)) {
                    cb(true)
                } else {
                    console.log(`[peershell] rejected WS upgrade from disallowed origin: ${info.origin}`)
                    cb(false, 403, 'Forbidden')
                }
            },
            // Echo ONLY the non-secret sentinel, never the credential-bearing subprotocol. The ws default
            // echoes the FIRST offered protocol (= the token here), which would re-leak it in the 101.
            handleProtocols: protocols => (protocols.has(AUTH_SENTINEL) ? AUTH_SENTINEL : false),
        })

        wss.on('connection', (sock, req) => {
            sock._room = null
            sock._peer = null
            sock._kind = 'desktop'
            sock._role = 'guest'
            sock._lastSeen = now()
            // Account token (host) rides in the Sec-WebSocket-Protocol handshake header as
            // peershell.bearer.<base64url>. One-release fallback: the legacy ?token= query param.
            let acct = null
            try {
                const fromHeader = bearerFromProtocolHeader(req.headers['sec-websocket-protocol'])
                const raw = fromHeader || new URL(req.url || '/', 'http://x').searchParams.get('token')
                acct = raw ? accountFromToken(raw) : null
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
                    recordShare(room, sock._account ? sock._account.id : null, magicLink)
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

module.exports = { startRelay, hashPassword, verifyPassword, base32Encode, base32Decode, totpAt, verifyTOTP, brevoSend, deliverVerifyCode }

if (require.main === module) {
    const port = Number(process.env.PORT || 8787)
    const host = process.env.BIND || '0.0.0.0'
    const publicUrl = process.env.PUBLIC_URL || ''
    const tokenTtlMs = process.env.TOKEN_TTL_MS ? Number(process.env.TOKEN_TTL_MS) : undefined
    startRelay(port, { host, publicUrl, tokenTtlMs }).then(s => {
        console.log(`[peershell-server] listening ws://${host}:${s.port}  public=${s.publicUrl || '(none)'}  auth=${s.requireAuth}  ${s.ephemeral ? 'EPHEMERAL' : 'persisted'}`)
    })
}
