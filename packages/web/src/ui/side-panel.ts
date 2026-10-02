import { h } from './dom.js';
import { clampPanelWidth, isSectionCollapsed, normalizePanelState, withSection, SIDE_PANEL_MIN_WIDTH, type SidePanelState } from './side-panel-state.js';

export type { SidePanelState } from './side-panel-state.js';

/**
 * The side panel right of the diagram (properties of the selection, simulation), shared by the web app
 * (standalone, desktop and embedded in Eclipse) and the diagram webview of the VS Code extension. It behaves
 * like the side bars of VS Code:
 *
 * - the whole panel can be collapsed to a narrow strip (toolbar button, the button in its title row or the
 *   strip, optional shortcut Ctrl+Alt+B / ⌘⌥B like VS Code's secondary side bar),
 * - its width is changed by dragging its left edge (or with the arrow keys when the edge has the focus;
 *   a double-click restores the default width),
 * - its content consists of collapsible sections ({@link panelSection}): a header row with a chevron.
 *
 * The state (collapsed panel, width, collapsed sections) is persisted by a {@link SidePanelStore} of the
 * application, e.g. its settings.
 */

export interface SidePanelStore {
    load(): SidePanelState | undefined;
    save(state: SidePanelState): void;
}

export interface SidePanelOptions {
    store?: SidePanelStore;
    /** Registers the keyboard shortcut Ctrl+Alt+B (⌘⌥B) that toggles the panel. */
    shortcut?: boolean;
    /** Called when the panel was collapsed or expanded by the user. */
    collapsedChanged?(collapsed: boolean): void;
}

/** The event a section dispatches when it was toggled by the user. */
const SECTION_TOGGLE_EVENT = 'hsm-section-toggle';

let sectionIds = 0;

export interface PanelSectionOptions {
    /** Collapsed unless the user expanded it (default: expanded). */
    collapsed?: boolean;
    /** Tooltip of the header. */
    hint?: string;
    /** Additional class of the section. */
    class?: string;
}

/**
 * A collapsible section of the side panel, like a view of VS Code's side bar: a header row (a button with a
 * chevron, toggled by click, Enter or Space) and the content. The {@link SidePanel} applies the persisted
 * state of the section (by its key) when it is added to the panel and persists changes.
 */
export function panelSection(key: string, title: string, content: Array<HTMLElement | string | undefined | false>, options: PanelSectionOptions = {}): HTMLElement {
    const id = `side-section-${++sectionIds}`;
    const header = h('button', {
        type: 'button',
        class: 'side-section-header',
        id: `${id}-header`,
        'aria-controls': `${id}-body`,
        title: options.hint
    }, h('span', { class: 'side-section-chevron', 'aria-hidden': 'true' }), h('span', { class: 'side-section-title' }, title));
    const body = h('div', { class: 'side-section-body', id: `${id}-body`, role: 'region', 'aria-labelledby': header.id }, ...content);
    const section = h('section', { class: `side-section${options.class ? ` ${options.class}` : ''}`, 'data-section': key },
        h('h3', { class: 'side-section-heading' }, header), body);
    setSectionCollapsed(section, !!options.collapsed);
    header.addEventListener('click', () => {
        const collapsed = !section.classList.contains('collapsed');
        setSectionCollapsed(section, collapsed);
        section.dispatchEvent(new CustomEvent(SECTION_TOGGLE_EVENT, { bubbles: true, detail: { key, collapsed } }));
    });
    return section;
}

function setSectionCollapsed(section: Element, collapsed: boolean): void {
    section.classList.toggle('collapsed', collapsed);
    section.querySelector(':scope > .side-section-heading > .side-section-header')?.setAttribute('aria-expanded', String(!collapsed));
    const body = section.querySelector<HTMLElement>(':scope > .side-section-body');
    if (body) {
        body.hidden = collapsed;
    }
}

const PANEL_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/>'
    + '<rect class="panel-icon-fill" x="10" y="3" width="4" height="10" fill="currentColor"/><line x1="9.5" y1="3" x2="9.5" y2="13" stroke="currentColor"/></svg>';
const HIDE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const SHOW_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M11 3L6 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/**
 * The side panel: wraps the content element (`#properties`, whose children are rendered by the diagram
 * controller) into an `aside#side-panel` with a title row, a resize edge and the strip shown when collapsed.
 */
export class SidePanel {

    readonly element: HTMLElement;
    /** The button that toggles the panel, to be placed into the toolbar of the application. */
    readonly toggleButton: HTMLButtonElement;
    private state: SidePanelState;
    private readonly title = h('span', { class: 'side-panel-title' });
    private readonly stripLabel = h('span', { class: 'side-panel-strip-label' });
    private readonly sash: HTMLElement;
    private readonly hideButton: HTMLButtonElement;
    private readonly stripButton: HTMLButtonElement;
    /** The key of the section whose header had the focus (restored when the content is rendered again). */
    private focusedSection?: string;

    constructor(readonly content: HTMLElement, private readonly options: SidePanelOptions = {}) {
        this.state = normalizePanelState(options.store?.load());
        const shortcut = this.shortcutHint;
        this.hideButton = h('button', { type: 'button', class: 'side-panel-action', title: `Hide the side panel${shortcut}`, 'aria-label': 'Hide the side panel', html: HIDE_ICON });
        this.hideButton.addEventListener('click', () => this.toggle(true));
        this.stripButton = h('button', { type: 'button', class: 'side-panel-strip', title: `Show the side panel${shortcut}`, 'aria-label': 'Show the side panel' },
            h('span', { class: 'side-panel-strip-icon', html: SHOW_ICON }), this.stripLabel);
        this.stripButton.addEventListener('click', () => this.toggle(false));
        this.sash = h('div', {
            class: 'side-panel-sash',
            role: 'separator',
            tabindex: '0',
            'aria-orientation': 'vertical',
            'aria-label': 'Width of the side panel',
            'aria-valuemin': String(SIDE_PANEL_MIN_WIDTH),
            title: 'Drag to resize the side panel (double-click: default width)'
        });
        this.toggleButton = h('button', { type: 'button', id: 'btn-side-panel', class: 'side-panel-toggle', html: PANEL_ICON });
        this.toggleButton.addEventListener('click', () => this.toggle());

        content.classList.add('side-panel-content');
        this.element = h('aside', { id: 'side-panel', 'aria-label': 'Side panel' });
        content.replaceWith(this.element);
        this.element.append(
            this.sash,
            h('div', { class: 'side-panel-header' }, this.title, this.hideButton),
            content,
            this.stripButton);

        if (this.state.width !== undefined) {
            this.element.style.setProperty('--side-panel-width', `${this.state.width}px`);
        }
        this.bindSash();
        this.bindSections();
        if (options.shortcut) {
            document.addEventListener('keydown', event => {
                if (event.code === 'KeyB' && event.altKey && !event.shiftKey && (isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.toggle();
                }
            }, { capture: true });
        }
        this.applySections(content);
        this.updateTitle();
        this.applyCollapsed();
    }

    private get shortcutHint(): string {
        return this.options.shortcut ? ` (${isMac() ? '⌥⌘B' : 'Ctrl+Alt+B'})` : '';
    }

    get collapsed(): boolean {
        return !!this.state.collapsed;
    }

    /** Collapses or expands the panel (toggles it without argument). */
    toggle(collapsed = !this.collapsed): void {
        if (collapsed === this.collapsed) {
            return;
        }
        // the focus stays in the panel (on the button that toggles it back)
        const hadFocus = this.element.contains(document.activeElement);
        this.setCollapsed(collapsed);
        this.options.collapsedChanged?.(collapsed);
        if (hadFocus) {
            (collapsed ? this.stripButton : this.hideButton).focus();
        }
    }

    /** Sets the collapsed state, e.g. from a setting of the application, and persists it. */
    setCollapsed(collapsed: boolean): void {
        if (collapsed === this.collapsed) {
            return;
        }
        this.state = { ...this.state, collapsed };
        this.applyCollapsed();
        this.save();
    }

    private applyCollapsed(): void {
        const collapsed = this.collapsed;
        this.element.classList.toggle('collapsed', collapsed);
        this.content.hidden = collapsed;
        this.toggleButton.setAttribute('aria-pressed', String(!collapsed));
        this.toggleButton.title = `${collapsed ? 'Show' : 'Hide'} the side panel${this.shortcutHint}`;
        this.toggleButton.setAttribute('aria-label', 'Side panel');
    }

    private save(): void {
        this.options.store?.save(this.state);
    }

    private updateTitle(): void {
        const simulation = this.content.classList.contains('simulation');
        this.element.classList.toggle('simulation', simulation);
        const title = simulation ? 'Simulation' : 'Properties';
        if (this.title.textContent !== title) {
            this.title.textContent = title;
            this.stripLabel.textContent = title;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Sections

    private bindSections(): void {
        this.content.addEventListener(SECTION_TOGGLE_EVENT, event => {
            const { key, collapsed } = (event as CustomEvent<{ key: string, collapsed: boolean }>).detail;
            this.state = withSection(this.state, key, collapsed);
            // the same section may be shown more than once (not now, but keep them consistent)
            for (const section of this.sectionsOf(this.content, key)) {
                setSectionCollapsed(section, collapsed);
            }
            this.save();
        });
        this.content.addEventListener('focusin', event => {
            const header = (event.target as Element).closest?.('.side-section-header');
            this.focusedSection = header?.closest<HTMLElement>('.side-section')?.dataset.section;
        });
        // the content is rendered by others: apply the persisted states to new sections (before they are painted)
        new MutationObserver(records => {
            let removedFocus = false;
            for (const record of records) {
                if (record.type === 'attributes') {
                    continue;
                }
                for (const node of record.addedNodes) {
                    if (node instanceof HTMLElement) {
                        this.applySections(node);
                    }
                }
                removedFocus ||= [...record.removedNodes].some(node => node instanceof HTMLElement && node.querySelector('.side-section-header') && !this.content.contains(document.activeElement));
            }
            this.updateTitle();
            if (removedFocus && this.focusedSection && (document.activeElement === document.body || !document.activeElement)) {
                // keyboard users keep the focus on the header after the content was rendered again
                [...this.sectionsOf(this.content, this.focusedSection)][0]?.querySelector<HTMLElement>('.side-section-header')?.focus();
            }
        }).observe(this.content, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    private *sectionsOf(root: HTMLElement, key?: string): Iterable<HTMLElement> {
        if (root.matches('.side-section') && (key === undefined || root.dataset.section === key)) {
            yield root;
        }
        for (const section of root.querySelectorAll<HTMLElement>('.side-section')) {
            if (key === undefined || section.dataset.section === key) {
                yield section;
            }
        }
    }

    private applySections(root: HTMLElement): void {
        for (const section of this.sectionsOf(root)) {
            // the stored state, otherwise the default of the section (as rendered)
            setSectionCollapsed(section, isSectionCollapsed(this.state, section.dataset.section ?? '', section.classList.contains('collapsed')));
        }
    }

    // -----------------------------------------------------------------------------------------
    // Width

    private availableWidth(): number {
        const pane = this.element.parentElement;
        const palette = pane?.querySelector<HTMLElement>('#palette');
        return (pane?.clientWidth ?? window.innerWidth) - (palette?.offsetWidth ?? 0);
    }

    private setWidth(width: number | undefined, persist: boolean): void {
        if (width === undefined) {
            this.element.style.removeProperty('--side-panel-width');
            this.state = { ...this.state, width: undefined };
        } else {
            width = clampPanelWidth(width, this.availableWidth());
            this.element.style.setProperty('--side-panel-width', `${width}px`);
            this.state = { ...this.state, width };
        }
        this.sash.setAttribute('aria-valuenow', String(Math.round(this.element.getBoundingClientRect().width)));
        if (persist) {
            this.save();
        }
    }

    private bindSash(): void {
        const sash = this.sash;
        sash.addEventListener('pointerdown', event => {
            if (this.collapsed || event.button !== 0) {
                return;
            }
            event.preventDefault();
            sash.setPointerCapture(event.pointerId);
            sash.classList.add('dragging');
            this.element.classList.add('resizing');
            const right = this.element.getBoundingClientRect().right;
            const move = (e: PointerEvent) => this.setWidth(right - e.clientX, false);
            const up = () => {
                sash.classList.remove('dragging');
                this.element.classList.remove('resizing');
                sash.removeEventListener('pointermove', move);
                sash.removeEventListener('pointerup', up);
                sash.removeEventListener('pointercancel', up);
                this.save();
            };
            sash.addEventListener('pointermove', move);
            sash.addEventListener('pointerup', up);
            sash.addEventListener('pointercancel', up);
        });
        sash.addEventListener('dblclick', () => this.setWidth(undefined, true));
        sash.addEventListener('keydown', event => {
            const step = event.shiftKey ? 64 : 16;
            const width = this.element.getBoundingClientRect().width;
            if (event.key === 'ArrowLeft') {
                this.setWidth(width + step, true);
            } else if (event.key === 'ArrowRight') {
                this.setWidth(width - step, true);
            } else if (event.key === 'Home' || event.key === 'Enter') {
                this.setWidth(undefined, true);
            } else {
                return;
            }
            event.preventDefault();
        });
    }
}

function isMac(): boolean {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
