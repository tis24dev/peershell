/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/**
 * Host side of the reverse HTTP tunnel. The server forwards a browser's page request as an
 * `http-get` frame over the host's outbound WS; the host answers with `http-response` carrying the
 * embedded web-client HTML. NOT a real HTTP server (the renderer opens no port), just frame handling.
 *
 * Strictly whitelists the path (only `/`) to prevent path-traversal / SSRF via a malicious guest.
 */
import { ControlMessage } from './protocol'
import { SessionTransport, isAllowedTunnelPath } from './api'
import { utf8ToBase64 } from './base64'

export class HttpTunnelHandler {
    constructor(
        private readonly transport: SessionTransport,
        private readonly serveHtml: () => string,
    ) {
        this.transport.onControl(m => {
            if (m.t === 'http-get') {
                this.handle(m)
            }
        })
    }

    private handle(m: Extract<ControlMessage, { t: 'http-get' }>): void {
        const allowed = isAllowedTunnelPath(m.path)
        const body = allowed ? this.serveHtml() : 'Forbidden'
        this.transport.sendControl({
            t: 'http-response',
            peerId: m.peerId,
            reqId: m.reqId,
            status: allowed ? 200 : 403,
            headers: { 'content-type': allowed ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' },
            bodyBase64: utf8ToBase64(body),
        })
    }
}
