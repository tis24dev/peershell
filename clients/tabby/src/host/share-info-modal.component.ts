/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/** Persistent, copyable display of a live share's magic-link + PIN (shown when sharing starts). */
@Component({
    template: `
        <div class="modal-header"><h4 class="modal-title">peershell: sharing this terminal</h4></div>
        <div class="modal-body">
            <p class="mb-2">Send the guest <strong>both</strong> the link and the PIN. They need the PIN to connect.</p>

            <div class="form-group">
                <label>Magic link</label>
                <div class="input-group">
                    <input class="form-control" [value]="magicLink" readonly (focus)="$any($event.target).select()">
                    <button class="btn btn-outline-secondary" type="button" (click)="copy(magicLink, 'Link')">Copy</button>
                </div>
            </div>

            <div class="form-group">
                <label>PIN</label>
                <div class="input-group">
                    <input class="form-control" [value]="pin" readonly (focus)="$any($event.target).select()">
                    <button class="btn btn-outline-secondary" type="button" (click)="copy(pin, 'PIN')">Copy</button>
                </div>
            </div>

            <div *ngIf="copied" class="text-success"><small>{{ copied }} copied to clipboard.</small></div>
            <p class="text-muted mt-2"><small>The link expires in ~15 minutes and the PIN gates every join. Keep
                this terminal tab open. Sharing stops when you close it or pick "Stop sharing".</small></p>
        </div>
        <div class="modal-footer">
            <button class="btn btn-primary" type="button" (click)="modal.close()">Done</button>
        </div>
    `,
})
export class ShareInfoModalComponent {
    magicLink = ''
    pin = ''
    copied = ''

    constructor(public readonly modal: NgbActiveModal) {}

    copy(text: string, what: string): void {
        if (navigator.clipboard) {
            // Only show the confirmation if the write actually succeeded.
            navigator.clipboard.writeText(text).then(() => { this.copied = what }).catch(() => { /* no-op */ })
            return
        }
        this.copied = what // no async clipboard: readonly inputs auto-select on focus for manual copy
    }
}
