type Child = Node | string | undefined | null | false;

/** Minimal helper to create DOM elements. */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Record<string, unknown> = {},
    ...children: Array<Child | Child[]>
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.substring(2).toLowerCase(), value as EventListener);
        } else if (key === 'class') {
            element.className = String(value);
        } else if (key === 'html') {
            element.innerHTML = String(value);
        } else if (key === 'value' && 'value' in element) {
            (element as HTMLInputElement).value = String(value);
        } else if (value === true) {
            element.setAttribute(key, '');
        } else {
            element.setAttribute(key, String(value));
        }
    }
    for (const child of children.flat()) {
        if (child === undefined || child === null || child === false) {
            continue;
        }
        element.append(child);
    }
    return element;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element #${id}`);
    }
    return element as T;
}

export function download(fileName: string, content: string | Blob, type: string): void {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
