/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

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
        try {
            return decodeURIComponent(m[1])
        } catch {
            return null // malformed %-escape -> treat as missing token
        }
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
    // True once live output has flowed (i.e. the PIN was accepted). Gates cachedPin reuse so a wrong
    // PIN is re-prompted on the host's re-challenge instead of silently replayed until retries run out.
    let sessionEstablished = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectDeadline = 0
    const RECONNECT_WINDOW_MS = 12000 // survive brief drops; a bit beyond the host's ~10s grace

    const sink: MirrorSink = {
        // Reassemble multibyte UTF-8 split across frames before writing to xterm.
        // Live/snapshot output only flows after pin-ok, so this marks the session as established.
        emit: data => { sessionEstablished = true; term.write(splitter.write(data)) },
        // Adopt the host's size (tmate model); the browser window does not drive the size.
        hostResize: (cols, rows) => term.resize(cols, rows),
        ended: reason => {
            stopped = true
            sessionEstablished = false
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
        // Only reuse the cached PIN for a genuine reconnect (session was live); on a re-challenge
        // within the same attempt (wrong PIN) re-prompt instead of replaying the bad PIN.
        if (sessionEstablished && cachedPin) {
            return cachedPin
        }
        cachedPin = await askPin()
        return cachedPin
    }
    const controller = new MirrorController(transport, sink, pinProvider)

    // --- input + mobile extra-keys bar ---
    const sendSeq = (s: string): void => controller.writeInput(encoder.encode(s))
    let ctrlArmed = false
    let altArmed = false
    const updateMods = (): void => {
        document.querySelectorAll<HTMLElement>('#keybar button[data-mod]').forEach(b => {
            const on = (b.dataset.mod === 'ctrl' && ctrlArmed) || (b.dataset.mod === 'alt' && altArmed)
            b.classList.toggle('armed', on)
        })
    }
    // Type input (soft keyboard or a literal key button), applying an armed modifier to the first char
    // (Ctrl -> control char, Alt -> ESC prefix), then disarm.
    const typed = (data: string): void => {
        if (!ctrlArmed && !altArmed) {
            sendSeq(data)
            return
        }
        let first = data[0] ?? ''
        if (ctrlArmed && first) {
            const u = first.toUpperCase().charCodeAt(0)
            if (u >= 0x40 && u <= 0x5f) {
                first = String.fromCharCode(u & 0x1f)
            }
        }
        if (altArmed && first) {
            first = `\x1b${first}`
        }
        ctrlArmed = false
        altArmed = false
        updateMods()
        sendSeq(first + data.slice(1))
    }
    // Cursor keys respect DECCKM (application mode sends ESC O x instead of ESC [ x).
    const ck = (c: string): string => `${term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${c}`
    const keySeq = (k: string): string | undefined => ({
        esc: '\x1b', tab: '\t', cc: '\x03',
        up: ck('A'), down: ck('B'), right: ck('C'), left: ck('D'),
        home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
    } as Record<string, string>)[k]

    term.onData(typed)

    const keybar = el('keybar')
    keybar.addEventListener('pointerdown', (e: Event) => {
        const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
        if (!btn) {
            return
        }
        e.preventDefault() // keep the terminal focused so the soft keyboard stays open
        const { k, mod, lit } = btn.dataset
        if (mod === 'ctrl') {
            ctrlArmed = !ctrlArmed
            updateMods()
        } else if (mod === 'alt') {
            altArmed = !altArmed
            updateMods()
        } else if (lit !== undefined) {
            typed(lit)
        } else if (k) {
            const seq = keySeq(k)
            if (seq !== undefined) {
                sendSeq(seq)
            }
        }
        term.focus()
    })

    // Keep the terminal sized above the bar and above the on-screen keyboard (VisualViewport).
    const toggle = el('kbtoggle')
    const termEl = el('terminal')
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    let barVisible = isTouch
    keybar.classList.toggle('hidden', !barVisible)
    const layout = (): void => {
        const vv = window.visualViewport
        const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
        const barH = barVisible ? keybar.offsetHeight : 0
        keybar.style.bottom = `${kb}px`
        termEl.style.bottom = `${kb + barH}px`
        fit.fit()
    }
    toggle.addEventListener('click', () => {
        barVisible = !barVisible
        keybar.classList.toggle('hidden', !barVisible)
        layout()
    })
    window.visualViewport?.addEventListener('resize', layout)
    window.visualViewport?.addEventListener('scroll', layout)
    setTimeout(layout, 50)

    // Reduce mobile IME weirdness (predictive text / autocapitalize) on the xterm input.
    const helper = document.querySelector('.xterm-helper-textarea')
    if (helper) {
        helper.setAttribute('autocorrect', 'off')
        helper.setAttribute('autocapitalize', 'off')
        helper.setAttribute('autocomplete', 'off')
        helper.setAttribute('spellcheck', 'false')
    }

    const connectAndJoin = async (): Promise<void> => {
        // Connect without a credential on the handshake: the magic-link token is delivered in the `join`
        // control frame below (WS payload, never logged), so it must not ride the URL query.
        await transport.connect(wsUrl())
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
