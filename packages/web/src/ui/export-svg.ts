import diagramCss from '../styles/diagram.css?raw';

/**
 * Creates a standalone SVG document of the rendered diagram: the viewport transformation is
 * removed, selection feedback is stripped and the diagram style sheet is embedded.
 */
export function exportSvg(container: HTMLElement, width: number, height: number, themeClass: string): string {
    const source = container.querySelector('svg');
    if (!source) {
        throw new Error('The diagram has not been rendered yet.');
    }
    const svg = source.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
    svg.setAttribute('width', `${Math.ceil(width)}`);
    svg.setAttribute('height', `${Math.ceil(height)}`);
    svg.removeAttribute('style');
    svg.removeAttribute('id');
    svg.removeAttribute('tabindex');
    svg.classList.add(themeClass, 'hsm-export');
    const viewport = svg.querySelector(':scope > g');
    viewport?.removeAttribute('transform');
    for (const element of svg.querySelectorAll('.selected, .mouseover, .pending-source')) {
        element.classList.remove('selected', 'mouseover', 'pending-source');
    }
    for (const element of svg.querySelectorAll('[id]')) {
        element.removeAttribute('id');
    }
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = diagramCss;
    svg.insertBefore(style, svg.firstChild);
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('class', 'export-background');
    background.setAttribute('width', '100%');
    background.setAttribute('height', '100%');
    svg.insertBefore(background, style.nextSibling);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}
