/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'

import { PROTOCOL_VERSION } from '@peershell/protocol'

/**
 * Stage 0 skeleton. Verifies the plugin builds (self-contained toolchain), bundles
 * @peershell/protocol, and is discovered + instantiated by Tabby. Real providers
 * (share/join, transport, session mirror, settings) land in later stages.
 */
@NgModule({})
export default class PeershellModule {
    constructor () {
        // eslint-disable-next-line no-console
        console.log(`[peershell] plugin loaded — protocol v${PROTOCOL_VERSION} (Stage 0 skeleton)`)
    }
}
