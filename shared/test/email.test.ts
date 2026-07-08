/** Stage 7: verification-code delivery (Brevo relay) with a mock-log fallback. No network. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('../../server/src/index.cjs') as {
    deliverVerifyCode: (email: string, code: string, cfg?: any) => Promise<{ delivered: string }>
}

describe('deliverVerifyCode', () => {
    let logSpy: jest.SpyInstance
    let warnSpy: jest.SpyInstance
    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => { logSpy.mockRestore(); warnSpy.mockRestore() })

    it('logs the code when no API key is configured', async () => {
        const r = await server.deliverVerifyCode('a@example.com', '123456', {})
        expect(r.delivered).toBe('log')
        expect(logSpy.mock.calls.some(c => String(c[0]).includes('verify code for a@example.com') && String(c[0]).includes('123456'))).toBe(true)
    })

    it('sends via the injected mailer when an API key is configured', async () => {
        const sent: any[] = []
        const sendFn = async (opts: any) => { sent.push(opts) }
        const r = await server.deliverVerifyCode('b@example.com', '654321', { apiKey: 'k', from: 'noreply@peershell.dev', sendFn })
        expect(r.delivered).toBe('email')
        expect(sent).toHaveLength(1)
        expect(sent[0].to).toBe('b@example.com')
        expect(sent[0].apiKey).toBe('k')
        expect(sent[0].text).toContain('654321')
        // the code must NOT be logged when it went out by email
        expect(logSpy.mock.calls.some(c => String(c[0]).includes('654321'))).toBe(false)
    })

    it('falls back to logging the code when the mailer fails', async () => {
        const sendFn = async () => { throw new Error('brevo 401') }
        const r = await server.deliverVerifyCode('c@example.com', '999000', { apiKey: 'k', sendFn })
        expect(r.delivered).toBe('log-fallback')
        expect(warnSpy).toHaveBeenCalled()
        expect(logSpy.mock.calls.some(c => String(c[0]).includes('verify code for c@example.com') && String(c[0]).includes('999000'))).toBe(true)
    })
})
