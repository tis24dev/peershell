/**
 * Minimal ambient type shims for the Tabby host packages we import. Lets the plugin build
 * without compiling Tabby's full source tree (or installing all of Tabby's deps): the real
 * implementations are provided by Tabby at runtime (these modules are webpack externals).
 * Extend these declarations as later stages use more of the Tabby API.
 */
declare module 'tabby-core' {
    import { Observable } from 'rxjs'

    export abstract class BaseTabComponent {
        get destroyed$(): Observable<void>
    }

    export interface ToolbarButton {
        icon?: string
        title: string
        weight?: number
        click?: () => void
        submenu?: () => Promise<ToolbarButton[]>
    }

    export abstract class ToolbarButtonProvider {
        abstract provide(): ToolbarButton[]
    }

    export interface MenuItemOptions {
        label?: string
        click?: () => void
        type?: string
        enabled?: boolean
        submenu?: MenuItemOptions[]
    }

    export abstract class TabContextMenuItemProvider {
        weight: number
        abstract getItems(tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]>
    }

    export abstract class ConfigProvider {
        defaults?: unknown
        platformDefaults?: unknown
    }

    export class ConfigService {
        store: any
        save(): Promise<void>
    }

    export class AppService {
        get activeTab(): BaseTabComponent | null
    }

    export class NotificationsService {
        notice(text: string): void
        info(text: string, details?: string): void
        error(text: string, details?: string): void
    }
}

declare module 'tabby-terminal' {
    import { Observable } from 'rxjs'
    import { BaseTabComponent } from 'tabby-core'

    export interface ResizeEvent { columns: number, rows: number }

    export abstract class BaseSession {
        get closed$(): Observable<void>
    }

    export abstract class BaseTerminalTabComponent<P = any> extends BaseTabComponent {
        session: BaseSession | null
        size: ResizeEvent
        frontend?: { saveState(): any }
        get binaryOutput$(): Observable<Buffer>
        get resize$(): Observable<ResizeEvent>
        sendInput(data: string | Buffer): void
    }
}
