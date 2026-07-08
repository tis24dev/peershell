/**
 * @peershell/server (MVP) — rendezvous + blind relay + reverse HTTP tunnel.
 *
 * Pairs one host + one guest by room-code or magic-link token, then forwards every frame (control
 * text + binary terminal data) verbatim between them. Serves the host-embedded web-client to browsers
 * that open the magic-link (GET /s/<token> -> http-get tunneled to the host -> http-response).
 *
 * MVP scope: no accounts/dashboard yet (Stage 6), no TLS (put cloudflared / a TLS reverse proxy in
 * front for public use). The PIN (validated peer-to-peer) and the magic-link TTL are the guards.
 *
 * Library:   const { startRelay } = require('./index.cjs'); const s = await startRelay(0)
 * Standalone: node server/src/index.cjs   (env: PORT, BIND, PUBLIC_URL, TOKEN_TTL_MS)
 */
const http = require('http')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000
const IDLE_TIMEOUT_MS = 90 * 1000

function genCode(n = 6) {
    const bytes = crypto.randomBytes(n)
    let out = ''
    for (let i = 0; i < n; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    }
    return out
}

const genToken = () => crypto.randomBytes(18).toString('base64url')
const j = obj => JSON.stringify({ v: 1, ...obj })

/**
 * @param {number} port
 * @param {{ host?: string, publicUrl?: string, tokenTtlMs?: number }} [opts]
 */
function startRelay(port = 0, opts = {}) {
    return new Promise(resolve => {
        const bindHost = opts.host || '127.0.0.1'
        const tokenTtlMs = opts.tokenTtlMs || DEFAULT_TOKEN_TTL_MS
        let boundPort = port
        let publicUrl = opts.publicUrl || ''

        const rooms = new Map() // room -> { host, guest }
        const tokens = new Map() // token -> { room, expiresAt }
        const pendingHttp = new Map() // reqId -> http res

        const now = () => Date.now()

        function tokenRoom(token) {
            const rec = tokens.get(token)
            if (!rec) {
                return null
            }
            if (rec.expiresAt < now()) {
                tokens.delete(token)
                return null
            }
            return rec.room
        }

        function dropRoom(room) {
            rooms.delete(room)
            for (const [tok, rec] of tokens) {
                if (rec.room === room) {
                    tokens.delete(tok)
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

        const server = http.createServer((req, res) => {
            if (req.url === '/health') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, sessions: rooms.size }))
                return
            }
            const m = /^\/s\/([^/?#]+)/.exec(req.url || '')
            if (!m) {
                res.writeHead(200, { 'content-type': 'text/plain' })
                res.end('peershell server\n')
                return
            }
            const room = tokenRoom(m[1])
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

        wss.on('connection', sock => {
            sock._room = null
            sock._peer = null
            sock._kind = 'desktop'
            sock._lastSeen = now()

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
                } catch {
                    /* ignore non-JSON text */
                }
                // Keepalive + relay-directed frames are handled here, never forwarded.
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
                        dropRoom(room) // host gone: tear the session down
                    } else {
                        entry.guest = null
                        entry.host._peer = null // free the guest slot for a retry within TTL
                    }
                }
            })
        })

        function handleSignal(sock, msg) {
            switch (msg.t) {
                case 'hello':
                    sock._kind = msg.kind || 'desktop'
                    break
                case 'create-session': {
                    const room = genCode()
                    const token = genToken()
                    rooms.set(room, { host: sock, guest: null })
                    tokens.set(token, { room, expiresAt: now() + tokenTtlMs })
                    sock._room = room
                    const base = publicUrl || `http://127.0.0.1:${boundPort}`
                    safeSend(sock, j({ t: 'session-created', room, magicLink: `${base}/s/${token}` }), false)
                    break
                }
                case 'join': {
                    const room = msg.room ? String(msg.room).toUpperCase() : (msg.token ? tokenRoom(msg.token) : null)
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

        // Reap idle sockets (half-open connections the keepalive did not keep warm).
        const reaper = setInterval(() => {
            const cutoff = now() - IDLE_TIMEOUT_MS
            for (const c of wss.clients) {
                if (c._lastSeen < cutoff) {
                    try { c.terminate() } catch { /* ignore */ }
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

module.exports = { startRelay }

if (require.main === module) {
    const port = Number(process.env.PORT || 8787)
    const host = process.env.BIND || '0.0.0.0'
    const publicUrl = process.env.PUBLIC_URL || ''
    const tokenTtlMs = process.env.TOKEN_TTL_MS ? Number(process.env.TOKEN_TTL_MS) : undefined
    startRelay(port, { host, publicUrl, tokenTtlMs }).then(s => {
        console.log(`[peershell-server] listening ws://${host}:${s.port}  public=${s.publicUrl || '(none)'}`)
    })
}
