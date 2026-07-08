/**
 * Throwaway dev rendezvous + blind relay (precursor of the real @peershell/server, Stage 5).
 * Pairs one host + one guest by room/token, then forwards EVERY frame (text control + binary)
 * verbatim between them. No auth, no TLS, no HTTP tunnel yet — just enough to exercise the wire.
 *
 *   const { startRelay } = require('./dev-relay.cjs')
 *   const relay = await startRelay(0)   // ephemeral port -> { port, url, close }
 *
 * Or run standalone:  node server/dev-relay.cjs   (PORT env, default 8787)
 */
const http = require('http')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

function genCode(n = 6) {
    const bytes = crypto.randomBytes(n)
    let out = ''
    for (let i = 0; i < n; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    }
    return out
}

const genToken = () => crypto.randomBytes(18).toString('base64url')

function startRelay(port = 0) {
    return new Promise(resolve => {
        let boundPort = port
        const rooms = new Map() // room -> { host, guest }
        const tokens = new Map() // token -> room
        const pendingHttp = new Map() // reqId -> http res (browser waiting for the tunneled page)

        function resolveHttp(msg) {
            const res = pendingHttp.get(msg.reqId)
            if (res) {
                pendingHttp.delete(msg.reqId)
                res.writeHead(msg.status || 200, msg.headers || {})
                res.end(Buffer.from(msg.bodyBase64 || '', 'base64'))
            }
        }

        // Reverse HTTP tunnel: GET /s/<token> is forwarded to the host as an http-get frame; the
        // host answers with http-response (intercepted below) which we return to the browser.
        const server = http.createServer((req, res) => {
            const m = /^\/s\/([^/?#]+)/.exec(req.url || '')
            if (!m) {
                res.writeHead(200, { 'content-type': 'text/plain' })
                res.end('peershell dev relay\n')
                return
            }
            const room = tokens.get(m[1])
            const entry = room && rooms.get(room)
            if (!entry || !entry.host) {
                res.writeHead(404)
                res.end('unknown session')
                return
            }
            const reqId = crypto.randomBytes(6).toString('hex')
            pendingHttp.set(reqId, res)
            entry.host.send(JSON.stringify({ v: 1, t: 'http-get', peerId: 0, reqId, path: '/' }))
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

        function safeSend(sock, data, binary) {
            if (sock && sock.readyState === sock.OPEN) {
                sock.send(data, { binary: !!binary })
            }
        }

        wss.on('connection', sock => {
            sock._role = null
            sock._room = null
            sock._peer = null

            sock.on('message', (data, isBinary) => {
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
                // http-response is relay-directed (answers a tunneled page request), never forwarded.
                if (msg && msg.t === 'http-response') {
                    resolveHttp(msg)
                    return
                }
                // Once paired, the relay is blind: forward everything else to the peer.
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
                    safeSend(other, JSON.stringify({ v: 1, t: 'peer-left', reason: 'socket-closed' }), false)
                    rooms.delete(room)
                    for (const [tok, r] of tokens) {
                        if (r === room) {
                            tokens.delete(tok)
                        }
                    }
                }
            })
        })

        function handleSignal(sock, msg) {
            switch (msg.t) {
                case 'hello':
                    sock._role = msg.role
                    sock._kind = msg.kind || 'desktop'
                    break
                case 'create-session': {
                    const room = genCode()
                    const token = genToken()
                    rooms.set(room, { host: sock, guest: null })
                    tokens.set(token, room)
                    sock._room = room
                    const magicLink = `http://127.0.0.1:${boundPort}/s/${token}`
                    safeSend(sock, JSON.stringify({ v: 1, t: 'session-created', room, magicLink }), false)
                    break
                }
                case 'join': {
                    const room = msg.room ? String(msg.room).toUpperCase() : tokens.get(msg.token)
                    const entry = room && rooms.get(room)
                    if (!entry) {
                        safeSend(sock, JSON.stringify({ v: 1, t: 'error', code: 'no-such-room' }), false)
                        return
                    }
                    if (entry.guest) {
                        safeSend(sock, JSON.stringify({ v: 1, t: 'error', code: 'session-busy' }), false)
                        return
                    }
                    entry.guest = sock
                    sock._room = room
                    sock._peer = entry.host
                    entry.host._peer = sock
                    safeSend(entry.host, JSON.stringify({ v: 1, t: 'peer-joined', peerId: 0, kind: sock._kind }), false)
                    break
                }
                default:
                    break
            }
        }

        server.listen(port, '127.0.0.1', () => {
            boundPort = server.address().port
            resolve({
                port: boundPort,
                url: `ws://127.0.0.1:${boundPort}`,
                close: () => new Promise(res => {
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
    startRelay(port).then(r => console.log(`[dev-relay] listening on ${r.url}`))
}
