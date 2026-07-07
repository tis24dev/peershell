/**
 * Portable base64 (btoa/atob are globals in browsers, Electron renderer, and Node >= 16).
 * Used for the VT snapshot payload in the `snapshot` control message.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i])
    }
    return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i)
    }
    return out
}

export const utf8ToBase64 = (s: string): string => bytesToBase64(new TextEncoder().encode(s))
export const base64ToUtf8 = (b64: string): string => new TextDecoder().decode(base64ToBytes(b64))
