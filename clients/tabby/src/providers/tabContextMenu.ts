/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

import { Injectable } from '@angular/core'
import { BaseTabComponent, TabContextMenuItemProvider, MenuItemOptions } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

import { PeershellService } from '../services/peershell.service'

@Injectable()
export class PeershellContextMenu extends TabContextMenuItemProvider {
    weight = 5

    constructor(private readonly peershell: PeershellService) {
        super()
    }

    async getItems(tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tabHeader || !(tab instanceof BaseTerminalTabComponent)) {
            return []
        }
        if (this.peershell.isSharing(tab)) {
            return [{
                label: 'Stop sharing (peershell)',
                click: () => this.peershell.stopSharing(tab),
            }]
        }
        return [{
            label: 'Share this terminal (peershell)',
            click: () => {
                void this.peershell.startSharing(tab)
            },
        }]
    }
}
