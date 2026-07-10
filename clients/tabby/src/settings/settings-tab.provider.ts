/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { PeershellSettingsTabComponent } from './settings-tab.component'

@Injectable()
export class PeershellSettingsTabProvider extends SettingsTabProvider {
    id = 'peershell'
    icon = 'share-nodes'
    title = 'peershell'

    getComponentType(): any {
        return PeershellSettingsTabComponent
    }
}
