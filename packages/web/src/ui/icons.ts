/** Palette icons, drawn in the style of the diagram elements. */
const svg = (content: string) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${content}</svg>`;

export const Icons = {
    select: svg('<path d="M6 3 L6 19 L10 15 L13 21 L15.5 20 L12.6 14 L18 14 Z" class="icon-fill-dark"/>'),
    state: svg('<rect x="2.5" y="5" width="19" height="14" rx="4" class="icon-state"/><line x1="2.5" y1="10.5" x2="21.5" y2="10.5" class="icon-stroke"/>'),
    region: svg('<rect x="2.5" y="3" width="19" height="18" rx="4" class="icon-state"/><line x1="2.5" y1="8" x2="21.5" y2="8" class="icon-stroke"/><line x1="2.5" y1="14.5" x2="21.5" y2="14.5" class="icon-stroke" stroke-dasharray="2.5 2"/>'),
    choice: svg('<polygon points="12,3 21,12 12,21 3,12" class="icon-state"/>'),
    junction: svg('<circle cx="12" cy="12" r="5" class="icon-fill-dark"/>'),
    history: svg('<circle cx="12" cy="12" r="9" class="icon-state"/><text x="12" y="16.3" text-anchor="middle" font-size="11" font-family="sans-serif" class="icon-text">H</text>'),
    deephistory: svg('<circle cx="12" cy="12" r="9" class="icon-state"/><text x="12" y="16.3" text-anchor="middle" font-size="10" font-family="sans-serif" class="icon-text">H*</text>'),
    sync: svg('<rect x="3" y="10" width="18" height="4.5" rx="1" class="icon-fill-dark"/><path d="M8 3.5 V9 M16 3.5 V9 M12 15.5 V21" class="icon-edge"/>'),
    entry: svg('<circle cx="8" cy="12" r="5" class="icon-state"/><path d="M15 12 H21" class="icon-edge"/>'),
    exit: svg('<circle cx="8" cy="12" r="5" class="icon-state"/><path d="M4.8 8.8 L11.2 15.2 M4.8 15.2 L11.2 8.8" class="icon-stroke"/><path d="M15 12 H21" class="icon-edge"/>'),
    definition: svg('<rect x="3" y="3.5" width="18" height="17" rx="1.5" class="icon-state"/><path d="M6 8.5 H14 M8 12 H18 M8 15.5 H16" class="icon-stroke"/>'),
    initial: svg('<circle cx="12" cy="12" r="7" class="icon-fill-dark"/>'),
    final: svg('<circle cx="12" cy="12" r="8.5" class="icon-final"/><circle cx="12" cy="12" r="5" class="icon-fill-dark"/>'),
    transition: svg('<path d="M4 19 C 8 8, 14 6, 19 6" class="icon-edge"/><path d="M21 5.5 L 15.5 3 L 16.5 6.2 L 15.8 9.3 Z" class="icon-arrow"/>'),
    // structure diagrams
    thread: svg('<rect x="2.5" y="4" width="19" height="16" rx="3.5" class="icon-thread"/><path d="M5.5 8.2 H13" class="icon-stroke"/>'),
    instance: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="1" class="icon-state"/><line x1="3.5" y1="10.5" x2="20.5" y2="10.5" class="icon-stroke"/><path d="M7 8 H17" class="icon-stroke" stroke-width="1.2"/>'),
    providedSync: svg('<path d="M3 12 H9" class="icon-edge"/><rect x="9" y="7" width="10" height="10" class="icon-port-provided"/>'),
    providedAsync: svg('<path d="M3 12 H9" class="icon-edge"/><rect x="9" y="7" width="10" height="10" class="icon-port-provided"/><path d="M12 9.5 L15.5 12 L12 14.5" class="icon-chevron-light"/>'),
    requiredSync: svg('<rect x="5" y="7" width="10" height="10" class="icon-port-required"/><path d="M15 12 H21" class="icon-edge"/>'),
    requiredAsync: svg('<rect x="5" y="7" width="10" height="10" class="icon-port-required"/><path d="M8.5 9.5 L12 12 L8.5 14.5" class="icon-chevron"/><path d="M15 12 H21" class="icon-edge"/>'),
    connector: svg('<rect x="2" y="9" width="6" height="6" class="icon-port-required"/><rect x="16" y="9" width="6" height="6" class="icon-port-provided"/><path d="M8 12 H16" class="icon-edge"/>'),
    delete: svg('<path d="M6 7 H18 M9 7 V4.5 H15 V7 M7.5 7 L8.5 20 H15.5 L16.5 7" class="icon-edge"/>'),
    fit: svg('<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15" class="icon-edge"/>'),
    relayout: svg('<path d="M19 12 A7 7 0 1 1 16.5 6.6 M17 3 V7 H13" class="icon-edge"/>')
};
