import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
    WebSocketTransport, MirrorController, MirrorSink, Utf8Splitter, PinProvider,
} from '@peershell/protocol'

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const setStatus = (s: string): void => { el('status').textContent = s }

/** Token from the magic-link path (/s/<token>) or ?token= query. */
function getToken(): string | null {
    const m = /\/s\/([^/?#]+)/.exec(location.pathname)
    if (m) {
        return decodeURIComponent(m[1])
    }
    return new URLSearchParams(location.search).get('token')
}

function wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}`
}

/** PIN overlay -> resolves the entered PIN (or null if cancelled). */
function askPin(): Promise<string | null> {
    return new Promise(resolve => {
        const overlay = el('overlay')
        const input = el('overlay-input') as HTMLInputElement
        const ok = el('overlay-ok')
        overlay.classList.remove('hidden')
        input.value = ''
        input.focus()
        const done = (value: string | null): void => {
            overlay.classList.add('hidden')
            ok.removeEventListener('click', onOk)
            input.removeEventListener('keydown', onKey)
            resolve(value)
        }
        const onOk = (): void => done(input.value.trim() || null)
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Enter') {
                onOk()
            } else if (e.key === 'Escape') {
                done(null)
            }
        }
        ok.addEventListener('click', onOk)
        input.addEventListener('keydown', onKey)
    })
}

async function main(): Promise<void> {
    const token = getToken()
    if (!token) {
        setStatus('Missing session token in the URL.')
        return
    }

    const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        theme: { background: '#000000' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el('terminal'))
    fit.fit()

    const splitter = new Utf8Splitter()
    const encoder = new TextEncoder()
    const transport = new WebSocketTransport() // browser global WebSocket

    let stopped = false // host ended the session (or wrong PIN / cancelled) -> do not reconnect
    let cachedPin: string | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectDeadline = 0
    const RECONNECT_WINDOW_MS = 12000 // survive brief drops; a bit beyond the host's ~10s grace

    const sink: MirrorSink = {
        // Reassemble multibyte UTF-8 split across frames before writing to xterm.
        emit: data => term.write(splitter.write(data)),
        // Adopt the host's size (tmate model); the browser window does not drive the size.
        hostResize: (cols, rows) => term.resize(cols, rows),
        ended: reason => {
            stopped = true
            if (reconnectTimer) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }
            term.write(`\r\n[peershell] ${reason}\r\n`)
            setStatus(reason)
        },
    }
    // Cache the PIN so a reconnect re-authenticates without re-prompting the user.
    const pinProvider: PinProvider = async () => {
        if (cachedPin) {
            return cachedPin
        }
        cachedPin = await askPin()
        return cachedPin
    }
    const controller = new MirrorController(transport, sink, pinProvider)
    term.onData(d => controller.writeInput(encoder.encode(d)))

    const connectAndJoin = async (): Promise<void> => {
        await transport.connect(wsUrl(), token)
        setStatus('')
        controller.join({ token, kind: 'web' })
    }

    const scheduleReconnect = (): void => {
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            if (stopped) {
                return
            }
            if (Date.now() > reconnectDeadline) {
                setStatus('disconnected')
                return
            }
            setStatus('reconnecting…')
            connectAndJoin().catch(() => {
                if (!stopped && !reconnectTimer && Date.now() <= reconnectDeadline) {
                    scheduleReconnect()
                }
            })
        }, 1500)
    }

    transport.onState(s => {
        if (s === 'open') {
            reconnectDeadline = 0
            if (reconnectTimer) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }
        } else if (s === 'closed' && !stopped) {
            if (reconnectDeadline === 0) {
                reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS
            }
            if (!reconnectTimer) {
                scheduleReconnect()
            }
        }
    })

    try {
        await connectAndJoin()
    } catch {
        setStatus('Could not connect to the server.')
    }
}

void main().catch(err => setStatus(`error: ${String(err)}`))
