export type WorkspacePanel = 'device' | 'settings';

/** Owns only the overlay: the recording workspace is never hidden or remounted. */
export class WorkspaceOverlay {
  current: WorkspacePanel | null = null;
  private trigger?: HTMLElement;
  readonly dialog: HTMLDialogElement;
  private changed: () => void;
  constructor(dialog: HTMLDialogElement, changed: () => void) {
    this.dialog = dialog; this.changed = changed;
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    dialog.addEventListener('close', () => { if (this.current) this.finishClose(); });
    dialog.querySelector('[data-overlay-close]')?.addEventListener('click', () => this.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
    });
  }
  open(panel: WorkspacePanel) {
    if (!this.current) this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.current = panel; this.dialog.dataset.panel = panel;
    // Render the requested content before the native dialog chooses initial focus.
    this.changed();
    const content = this.dialog.querySelector<HTMLElement>('.flow-root'); if (content) content.scrollTop = 0;
    if (!this.dialog.open) this.dialog.showModal();
  }
  close() {
    if (!this.current) return;
    this.finishClose(); this.dialog.close();
  }
  private finishClose() {
    this.current = null; this.changed();
    this.trigger?.focus(); this.trigger = undefined;
  }
}
