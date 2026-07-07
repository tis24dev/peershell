/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { ConfigProvider, ToolbarButtonProvider, TabContextMenuItemProvider } from 'tabby-core'

import { PROTOCOL_VERSION } from '@peershell/protocol'
import { PeershellConfigProvider } from './config'
import { PeershellService } from './services/peershell.service'
import { PeershellToolbarButtonProvider } from './providers/toolbarButtonProvider'
import { PeershellContextMenu } from './providers/tabContextMenu'

@NgModule({
    providers: [
        { provide: ConfigProvider, useClass: PeershellConfigProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: PeershellToolbarButtonProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: PeershellContextMenu, multi: true },
    ],
})
export default class PeershellModule {
    constructor (_peershell: PeershellService) {
        // eslint-disable-next-line no-console
        console.log(`[peershell] plugin loaded — protocol v${PROTOCOL_VERSION}`)
    }
}

export { PeershellService }
