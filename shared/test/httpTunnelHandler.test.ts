import {
    HttpTunnelHandler, SessionTransport, ControlMessage, BinaryPayload, Channel, TransportState, base64ToUtf8,
} from '../src'

class MockTransport implements SessionTransport {
    sentControl: ControlMessage[] = []
    private controlCb?: (m: ControlMessage) => void

    connect(): Promise<void> {
        return Promise.resolve()
    }
    sendControl(m: ControlMessage): void {
        this.sentControl.push(m)
    }
    sendData(_p: number, _c: Channel, _d: Uint8Array): void { /* unused */ }
    close(): void { /* unused */ }
    onControl(cb: (m: ControlMessage) => void): void {
        this.controlCb = cb
    }
    onBinary(_cb: (f: BinaryPayload) => void): void { /* unused */ }
    onState(_cb: (s: TransportState) => void): void { /* unused */ }

    emitControl(m: ControlMessage): void {
        this.controlCb?.(m)
    }
}

const HTML = '<!doctype html><title>peershell</title>'

it('serves the embedded HTML for the root path', () => {
    const t = new MockTransport()
    // eslint-disable-next-line no-new
    new HttpTunnelHandler(t, () => HTML)

    t.emitControl({ t: 'http-get', peerId: 0, reqId: 'r1', path: '/' })
    const res = t.sentControl.find(m => m.t === 'http-response') as Extract<ControlMessage, { t: 'http-response' }>
    expect(res.status).toBe(200)
    expect(res.reqId).toBe('r1')
    expect(base64ToUtf8(res.bodyBase64)).toBe(HTML)
})

it('rejects traversal / SSRF paths with 403', () => {
    const t = new MockTransport()
    // eslint-disable-next-line no-new
    new HttpTunnelHandler(t, () => HTML)

    for (const path of ['/../../etc/passwd', '/%2e%2e/x', 'http://169.254.169.254/', '/secret']) {
        t.sentControl.length = 0
        t.emitControl({ t: 'http-get', peerId: 0, reqId: 'r', path })
        const res = t.sentControl.find(m => m.t === 'http-response') as Extract<ControlMessage, { t: 'http-response' }>
        expect(res.status).toBe(403)
    }
})
