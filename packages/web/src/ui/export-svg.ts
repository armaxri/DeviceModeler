import { DIAGRAM_CSS } from 'devm-language';
import { restoreNativeTitles } from './tooltips.js';

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
    svg.classList.add(themeClass, 'devm-export');
    const viewport = svg.querySelector(':scope > g');
    viewport?.removeAttribute('transform');
    for (const element of svg.querySelectorAll('.selected, .mouseover, .pending-source, .on-route')) {
        element.classList.remove('selected', 'mouseover', 'pending-source', 'on-route');
    }
    for (const element of svg.querySelectorAll('[id]')) {
        element.removeAttribute('id');
    }
    restoreNativeTitles(svg);
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = DIAGRAM_CSS;
    svg.insertBefore(style, svg.firstChild);
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('class', 'export-background');
    background.setAttribute('width', '100%');
    background.setAttribute('height', '100%');
    svg.insertBefore(background, style.nextSibling);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}

/**
 * Renders an SVG document (see {@link exportSvg}) into a PNG image. `scale` 2 gives sharp images on
 * high resolution screens and in documents.
 */
export function svgToPng(svg: string, scale = 2): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        image.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext('2d');
            if (!context) {
                reject(new Error('The PNG image could not be created (no canvas).'));
                return;
            }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The PNG image could not be created.')), 'image/png');
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('The SVG of the diagram could not be rendered.'));
        };
        image.src = url;
    });
}
