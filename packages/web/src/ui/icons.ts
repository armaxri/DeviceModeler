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
    delete: svg('<path d="M6 7 H18 M9 7 V4.5 H15 V7 M7.5 7 L8.5 20 H15.5 L16.5 7" class="icon-edge"/>'),
    fit: svg('<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15" class="icon-edge"/>')
};
