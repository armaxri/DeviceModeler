import { byId, h } from './dom.js';

export interface BreadcrumbItem {
    label: string;
    title?: string;
    /** Items with an action are links. */
    onClick?: () => void;
}

/**
 * The breadcrumb at the top left of the diagram: where the shown diagram is used (the structure path
 * of a composite part, the instances using a state machine). Empty items hide it.
 */
export function renderBreadcrumb(items: readonly BreadcrumbItem[], prefix?: string, separator = '›'): void {
    let element = document.getElementById('diagram-breadcrumb');
    if (!element) {
        element = h('nav', { id: 'diagram-breadcrumb', 'aria-label': 'Where the diagram is used' });
        byId('diagram-area').append(element);
    }
    element.hidden = items.length === 0;
    const children: Array<HTMLElement | string> = [];
    if (prefix) {
        children.push(h('span', { class: 'breadcrumb-prefix' }, prefix));
    }
    items.forEach((item, i) => {
        if (i > 0) {
            children.push(h('span', { class: 'breadcrumb-separator' }, separator));
        }
        children.push(item.onClick
            ? h('a', { href: '#', title: item.title ?? '', onClick: (event: Event) => { event.preventDefault(); item.onClick!(); } }, item.label)
            : h('span', { class: 'breadcrumb-current', title: item.title ?? '' }, item.label));
    });
    element.replaceChildren(...children);
}
