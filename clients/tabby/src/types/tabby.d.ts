/**
 * Minimal ambient type shims for the Tabby host packages we import. Lets the plugin build
 * without compiling Tabby's full source tree (or installing all of Tabby's deps): the real
 * implementations are provided by Tabby at runtime (these modules are webpack externals).
 * Extend these declarations as later stages use more of the Tabby API.
 */
declare module '*.html' {
    const content: string
    export default content
}

declare module 'tabby-core' {
    import { Observable } from 'rxjs'

    const _default: any
    export default _default

    export type Logger = any

    export class LogService {
        create(name: string): Logger
    }

    export abstract class BaseTabComponent {
        get destroyed$(): Observable<void>
        subscribeUntilDestroyed<T>(observable: Observable<T>, callback: (value: T) => void): void
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

    export interface NewTabParameters<T> {
        type: any
        inputs?: Record<string, any>
    }

    export class AppService {
        get activeTab(): BaseTabComponent | null
        openNewTab<T>(params: NewTabParameters<T>): T
    }

    export class NotificationsService {
        notice(text: string): void
        info(text: string, details?: string): void
        error(text: string, details?: string): void
    }

    export class PromptModalComponent {
        prompt: string
        value: string
        password: boolean
    }
}

declare module 'tabby-terminal' {
    import { Observable } from 'rxjs'
    import { BaseTabComponent } from 'tabby-core'

    const _default: any
    export default _default

    export interface ResizeEvent { columns: number, rows: number }

    export class UTF8SplitterMiddleware {
        constructor()
    }

    export abstract class BaseSession {
        open: boolean
        readonly middleware: { push(middleware: unknown): void }
        constructor(logger: unknown)
        protected emitOutput(data: Buffer): void
        feedFromTerminal(data: Buffer): void
        releaseInitialDataBuffer(): void
        destroy(): Promise<void>
        get closed$(): Observable<void>
        get destroyed$(): Observable<void>
        abstract start(options: unknown): Promise<void>
        abstract resize(columns: number, rows: number): void
        abstract write(data: Buffer): void
        abstract kill(signal?: string): void
        abstract gracefullyKillProcess(): Promise<void>
        abstract supportsWorkingDirectory(): boolean
        abstract getWorkingDirectory(): Promise<string | null>
    }

    export abstract class BaseTerminalTabComponent<P = any> extends BaseTabComponent {
        static template: any
        static styles: any
        static animations: any
        protected injector: any
        profile: P
        session: BaseSession | null
        size: ResizeEvent
        frontend?: any
        protected log: { create(name: string): any }
        protected logger: any
        protected config: { store: any }
        constructor(injector: any)
        setSession(session: BaseSession | null, destroyOnSessionClose?: boolean): void
        sendInput(data: string | Buffer): void
        get binaryOutput$(): Observable<Buffer>
        get resize$(): Observable<ResizeEvent>
        protected onFrontendReady(): void
        ngOnInit(): void
        ngOnDestroy(): void
    }
}
