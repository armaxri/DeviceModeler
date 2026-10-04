import { HOVER_DELAY, isWarm, placeTooltip, type Box, type TooltipPlacement } from './tooltip-position.js';

/*
 * Custom tooltips for the elements with a `title` (or `data-tooltip`) attribute and for SVG elements
 * with a `<title>` child (the diagram). Native tooltips are not shown reliably in VS Code webviews
 * (macOS) and embedded browsers (SWT Browser, JCEF); this shows the same texts in a styled box
 * (styles/tooltips.css) in every host.
 *
 * Delegated listeners on the document, so that dynamically created elements and changed titles work
 * without registration. On the first hover (or focus) the `title` attribute is moved to `data-tooltip`
 * so that the native tooltip does not show as well; elements whose only accessible name was the title
 * get it as `aria-label`. Placement: right of the elements of the palette (left edge of the diagram),
 * below everything else, at the pointer for diagram elements; flipped and clamped to the viewport.
 */

const TOOLTIP_ATTRIBUTE = 'data-tooltip';
/** Elements (and their contents) which show their own hovers. */
const EXCLUDED = '.monaco-editor, select option';

let installed = false;

/** Installs the tooltips for the whole document (idempotent). */
export function installTooltips(doc: Document = document): void {
    if (installed) {
        return;
    }
    installed = true;
    new TooltipController(doc).install();
}

/** The element with a tooltip at or above the target, or undefined. */
export function tooltipTarget(target: EventTarget | null): Element | undefined {
    let element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    while (element) {
        if (element.closest(EXCLUDED)) {
            return undefined;
        }
        if (element.hasAttribute('title') || element.hasAttribute(TOOLTIP_ATTRIBUTE) || svgTitle(element)) {
            // (an empty title suppresses the tooltips of the ancestors, as for native tooltips)
            return tooltipText(element) ? element : undefined;
        }
        element = element.parentElement;
    }
    return undefined;
}

/**
 * The tooltip text of an element. Moves a `title` attribute to `data-tooltip` (keeping the accessible
 * name) and the text of an SVG `<title>` child to its `data-tooltip` attribute: the native tooltip
 * shows nothing then.
 */
export function tooltipText(element: Element): string {
    const title = element.getAttribute('title');
    if (title !== null) {
        keepAccessibleText(element, title);
        element.setAttribute(TOOLTIP_ATTRIBUTE, title);
        element.removeAttribute('title');
        return title;
    }
    const svg = svgTitle(element);
    if (svg) {
        // the <title> element stays (it belongs to the virtual DOM of the diagram); its text is emptied
        // and kept in an attribute, the diagram sets the text again when it changes
        const text = svg.textContent ?? '';
        if (text) {
            svg.setAttribute(TOOLTIP_ATTRIBUTE, text);
            svg.textContent = '';
        }
        return svg.getAttribute(TOOLTIP_ATTRIBUTE) ?? '';
    }
    return element.getAttribute(TOOLTIP_ATTRIBUTE) ?? '';
}

/**
 * Restores the titles moved by the tooltips in a copy of the DOM (the exported SVG of the diagram has
 * native `<title>` tooltips).
 */
export function restoreNativeTitles(root: Element): void {
    for (const element of root.querySelectorAll(`[${TOOLTIP_ATTRIBUTE}]`)) {
        const text = element.getAttribute(TOOLTIP_ATTRIBUTE) ?? '';
        if (element.tagName.toLowerCase() === 'title' && element.namespaceURI === SVG_NS) {
            if (!element.textContent) {
                element.textContent = text;
            }
        } else if (!element.hasAttribute('title')) {
            element.setAttribute('title', text);
        }
        element.removeAttribute(TOOLTIP_ATTRIBUTE);
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Which ARIA attribute the tooltips set from the title (`label` or `description`; updated with the title). */
const ARIA_OWNER = 'data-tooltip-aria';

/**
 * Keeps the text of a title available to assistive technology after the attribute is removed: as the
 * accessible name of an element without one (e.g. an icon button), otherwise as its description.
 */
function keepAccessibleText(element: Element, title: string): void {
    const owned = element.getAttribute(ARIA_OWNER);
    if (owned) {
        element.setAttribute(`aria-${owned}`, title);
        return;
    }
    if (!title) {
        return;
    }
    const tag = element.tagName.toLowerCase();
    const named = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby')
        || !!element.textContent?.trim() || tag === 'select' || tag === 'input' || tag === 'textarea';
    if (!named) {
        element.setAttribute('aria-label', title);
        element.setAttribute(ARIA_OWNER, 'label');
    } else if (element.getAttribute('aria-label') !== title && !element.hasAttribute('aria-describedby') && !element.hasAttribute('aria-description')) {
        element.setAttribute('aria-description', title);
        element.setAttribute(ARIA_OWNER, 'description');
    }
}

function svgTitle(element: Element): Element | undefined {
    if (element.namespaceURI !== SVG_NS) {
        return undefined;
    }
    for (const child of element.children) {
        if (child.tagName.toLowerCase() === 'title') {
            return child;
        }
    }
    return undefined;
}

class TooltipController {
    private readonly box: HTMLElement;
    private anchor?: Element;
    private pointer?: { x: number; y: number };
    private showTimer?: ReturnType<typeof setTimeout>;
    private lastHidden?: number;
    private observer?: MutationObserver;

    constructor(private readonly doc: Document) {
        this.box = doc.createElement('div');
        this.box.className = 'hsm-tooltip';
        this.box.setAttribute('role', 'tooltip');
        this.box.hidden = true;
    }

    install(): void {
        const doc = this.doc;
        const view = doc.defaultView ?? window;
        // pointer events are dispatched for disabled buttons as well (unlike the mouse events)
        doc.addEventListener('pointerover', event => this.pointerOver(event), true);
        doc.addEventListener('pointermove', event => this.pointerMove(event), true);
        doc.addEventListener('pointerout', event => this.pointerOut(event), true);
        doc.addEventListener('pointerdown', () => this.hide(false), true);
        doc.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.anchor) {
                this.hide(false);
            }
        }, true);
        doc.addEventListener('focusin', event => this.focusIn(event));
        doc.addEventListener('focusout', event => {
            if (this.anchor && event.target === this.anchor && !this.pointer) {
                this.hide(false);
            }
        });
        doc.addEventListener('scroll', event => {
            // (not for other scrolling areas, e.g. a log which scrolls while running a simulation)
            const scrolled = event.target;
            if (this.anchor && (!(scrolled instanceof Node) || scrolled === doc || scrolled.contains(this.anchor))) {
                this.hide(false);
            }
        }, true);
        doc.addEventListener('wheel', () => this.hide(false), { capture: true, passive: true });
        view.addEventListener('blur', () => this.hide(false));
        view.addEventListener('resize', () => this.hide(false));
    }

    private pointerOver(event: PointerEvent): void {
        if (event.pointerType === 'touch' || event.buttons !== 0) {
            return;
        }
        const target = tooltipTarget(event.target);
        if (target === this.anchor) {
            return;
        }
        if (!target) {
            if (this.anchor) {
                this.hide(true);
            }
            return;
        }
        this.schedule(target, { x: event.clientX, y: event.clientY });
    }

    private pointerMove(event: PointerEvent): void {
        if (this.anchor && this.box.hidden && event.buttons === 0) {
            // the pointer position of the diagram elements (shown at the pointer)
            this.pointer = { x: event.clientX, y: event.clientY };
        }
    }

    private pointerOut(event: PointerEvent): void {
        if (!this.anchor || event.pointerType === 'touch') {
            return;
        }
        const next = event.relatedTarget;
        if (next instanceof Node && this.anchor.contains(next)) {
            return;
        }
        if (!next || !tooltipTarget(next)) {
            this.hide(true);
        }
    }

    private focusIn(event: FocusEvent): void {
        const target = event.target;
        if (!(target instanceof Element) || !safeMatches(target, ':focus-visible')) {
            return;
        }
        const anchor = tooltipTarget(target);
        if (anchor === target) {
            this.schedule(anchor, undefined);
        }
    }

    private schedule(anchor: Element, pointer: { x: number; y: number } | undefined): void {
        const wasShown = !this.box.hidden;
        this.hide(wasShown);
        this.anchor = anchor;
        this.pointer = pointer;
        const delay = wasShown || isWarm(Date.now(), this.lastHidden) ? 0 : HOVER_DELAY;
        this.showTimer = setTimeout(() => this.show(), delay);
    }

    private show(): void {
        const anchor = this.anchor;
        if (!anchor || !anchor.isConnected) {
            this.hide(false);
            return;
        }
        const text = tooltipText(anchor);
        if (!text) {
            this.hide(false);
            return;
        }
        if (!this.box.isConnected) {
            this.doc.body.append(this.box);
        }
        this.box.textContent = text;
        this.box.hidden = false;
        this.position();
        // titles which change while shown (e.g. "Positions: …")
        this.observer = new MutationObserver(() => {
            if (this.anchor === anchor) {
                const changed = tooltipText(anchor);
                if (!changed) {
                    this.hide(false);
                } else if (changed !== this.box.textContent) {
                    this.box.textContent = changed;
                    this.position();
                }
            }
        });
        this.observer.observe(anchor, { attributes: true, attributeFilter: ['title'], childList: true, characterData: true, subtree: anchor.namespaceURI === SVG_NS });
    }

    private position(): void {
        const anchor = this.anchor;
        if (!anchor) {
            return;
        }
        const view = this.doc.defaultView ?? window;
        const rect = anchor.getBoundingClientRect();
        let box: Box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        let preferred: TooltipPlacement = 'below';
        const configured = anchor.closest('[data-tooltip-placement]')?.getAttribute('data-tooltip-placement');
        if (anchor.closest('#palette')) {
            preferred = 'right';
        } else if (anchor.namespaceURI === SVG_NS && this.pointer) {
            // diagram elements: at the pointer (an element may be large)
            box = { left: this.pointer.x, top: this.pointer.y, width: 0, height: 12 };
        }
        if (configured === 'right' || configured === 'left' || configured === 'below' || configured === 'above') {
            preferred = configured;
        }
        const size = this.box.getBoundingClientRect();
        const placed = placeTooltip(box, { width: size.width, height: size.height },
            { width: view.innerWidth, height: view.innerHeight }, preferred);
        this.box.style.left = `${placed.left}px`;
        this.box.style.top = `${placed.top}px`;
        this.box.dataset.placement = placed.placement;
    }

    /** Hides the tooltip; `moving`: the pointer moved on (the next tooltip shows without delay). */
    private hide(moving: boolean): void {
        clearTimeout(this.showTimer);
        this.showTimer = undefined;
        this.observer?.disconnect();
        this.observer = undefined;
        if (!this.box.hidden) {
            this.box.hidden = true;
            this.lastHidden = moving ? Date.now() : undefined;
        } else if (!moving) {
            this.lastHidden = undefined;
        }
        this.anchor = undefined;
        this.pointer = undefined;
    }
}

function safeMatches(element: Element, selector: string): boolean {
    try {
        return element.matches(selector);
    } catch {
        return false;
    }
}
