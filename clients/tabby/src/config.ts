/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

import { ConfigProvider } from 'tabby-core'

export class PeershellConfigProvider extends ConfigProvider {
    defaults = {
        peershell: {
            serverUrl: 'wss://panel.peershell.dev',
            magicLinkTtlMinutes: 15,
            disclaimerAck: false,
            account: null,
            pin: null,
        },
    }

    platformDefaults = {}
}
