/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'
import TabbyCorePlugin, { ConfigProvider, ToolbarButtonProvider, TabContextMenuItemProvider } from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'

import { PROTOCOL_VERSION } from '@peershell/protocol'
import { PeershellConfigProvider } from './config'
import { PeershellService } from './services/peershell.service'
import { PeershellToolbarButtonProvider } from './providers/toolbarButtonProvider'
import { PeershellContextMenu } from './providers/tabContextMenu'
import { MirrorTabComponent } from './guest/mirrorTab.component'
import { LoginModalComponent } from './account/login-modal.component'
import { ShareInfoModalComponent } from './host/share-info-modal.component'
import { PeershellSettingsTabProvider } from './settings/settings-tab.provider'
import { PeershellSettingsTabComponent } from './settings/settings-tab.component'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        ToastrModule,
        TabbyCorePlugin,
        TabbyTerminalModule,
    ],
    providers: [
        { provide: ConfigProvider, useClass: PeershellConfigProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: PeershellToolbarButtonProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: PeershellContextMenu, multi: true },
        { provide: SettingsTabProvider, useClass: PeershellSettingsTabProvider, multi: true },
    ],
    declarations: [
        MirrorTabComponent,
        LoginModalComponent,
        ShareInfoModalComponent,
        PeershellSettingsTabComponent,
    ],
})
export default class PeershellModule {
    constructor (_peershell: PeershellService) {
        // eslint-disable-next-line no-console
        console.log(`[peershell] plugin loaded, protocol v${PROTOCOL_VERSION}`)
    }
}

export { PeershellService }
