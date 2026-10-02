import type { IbdEdge, IbdGraph, IbdNode, IbdPort } from '../diagram/ibd-model.js';
import { IbdMetrics } from '../diagram/ibd-layout.js';
import { helveticaTextWidth } from '../diagram/text-metrics.js';
import { DIAGRAM_CSS } from './diagram-styles.js';
import { behaviorIconPath, compositeIconPath, frameTabPath, ibdRoutePath, portChevron, portClasses, portTooltip } from './ibd-shapes.js';
import { escapeXml, highlightClass, type DiagramTheme, type HighlightKind } from './svg.js';

/*
 * Renders the diagram of a structure file (`layoutStructure`, ibd-layout.ts) as a standalone SVG
 * document without a DOM, with the structure and the CSS classes of the web editor (the `Ibd*View`s of
 * packages/web/src/diagram/ibd-views.tsx) and the shared style sheet, like `renderSvg` for state machines.
 */

export interface IbdSvgOptions {
    /** Default: `'classic'`. */
    theme?: DiagramTheme;
    /**
     * CSS classes of diagram elements by id, e.g. `'on-route'` for the elements of a route
     * (`ibdRouteElements`); with `routeHighlight` the other elements are dimmed.
     */
    highlight?: ReadonlyMap<string, HighlightKind>;
    /** Dim the elements without the class `on-route` (default: false). */
    routeHighlight?: boolean;
    /** Title shown above the diagram (and as `<title>` of the document). */
    title?: string;
    /** Embed the diagram style sheet (default: true). */
    embedStyles?: boolean;
    /** Start with `<?xml …?>` (default: true). */
    xmlDeclaration?: boolean;
}

const M = IbdMetrics;
const TITLE_HEIGHT = 30;

/** Renders the diagram of a structure as a standalone SVG document with the look of the web editor. */
export function renderIbdSvg(graph: IbdGraph, options: IbdSvgOptions = {}): string {
    const theme = options.theme ?? 'classic';
    const top = options.title ? TITLE_HEIGHT : 0;
    const titleWidth = options.title ? Math.ceil(helveticaTextWidth(options.title, 16) * 1.1) + 40 : 0;
    const width = Math.max(Math.ceil(graph.width), titleWidth, 1);
    const height = Math.max(Math.ceil(graph.height) + top, 1);
    const out: string[] = [];
    if (options.xmlDeclaration ?? true) {
        out.push('<?xml version="1.0" encoding="UTF-8"?>');
    }
    const rootClasses = ['sprotty-graph', `theme-${theme}`, 'hsm-export', 'ibd-diagram', ...(options.routeHighlight ? ['route-highlight'] : [])];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="${rootClasses.join(' ')}" width="${width}" height="${height}" `
        + `viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`);
    out.push(`<title>${escapeXml(options.title ?? graph.name)}</title>`);
    if (options.embedStyles ?? true) {
        out.push(`<style><![CDATA[${DIAGRAM_CSS}]]></style>`);
    }
    out.push('<rect class="export-background" width="100%" height="100%"/>');
    if (options.title) {
        out.push(`<text class="hsm-title" x="20" y="${TITLE_HEIGHT - 6}">${escapeXml(options.title)}</text>`);
    }
    const writer = new IbdSvgWriter(options.highlight ?? new Map());
    out.push(top > 0 ? `<g transform="translate(0, ${top})">` : '<g>');
    graph.children.forEach(node => writer.node(node, out));
    graph.edges.forEach(edge => writer.edge(edge, out));
    out.push('</g>');
    out.push('</svg>');
    return out.join('\n') + '\n';
}

class IbdSvgWriter {

    constructor(private readonly highlight: ReadonlyMap<string, HighlightKind>) { }

    private classes(base: string[], id: string): string {
        const kind = this.highlight.get(id);
        return [...base, kind !== undefined ? highlightClass(kind) : ''].filter(c => c).join(' ');
    }

    node(node: IbdNode, out: string[]): void {
        const classes = ['ibd-node', `ibd-${node.kind}`, ...(node.behavior ? ['has-behavior'] : []), ...(node.composite ? ['composite'] : [])];
        out.push(`<g class="${this.classes(classes, node.id)}" transform="translate(${fmt(node.x)}, ${fmt(node.y)})">`);
        if (node.description) {
            out.push(`<title>${escapeXml(node.description)}</title>`);
        }
        switch (node.kind) {
            case 'frame':
                out.push(`<rect class="ibd-frame-shape" x="0" y="0" width="${fmt(node.width)}" height="${fmt(node.height)}"/>`);
                out.push(`<path class="ibd-frame-tab" d="${frameTabPath(node.tabWidth ?? 120, node.headerHeight)}"/>`);
                out.push(`<text class="ibd-frame-title" x="8" y="${fmt(baseline(0, node.headerHeight, M.tabFont))}">`
                    + `<tspan class="ibd-frame-kind">ibd</tspan> [${escapeXml(node.stereotype ?? 'structure')}] `
                    + `<tspan class="ibd-frame-name">${escapeXml(node.name)}</tspan></text>`);
                break;
            case 'thread':
                out.push(`<rect class="ibd-thread-shape" x="0" y="0" rx="6" ry="6" width="${fmt(node.width)}" height="${fmt(node.height)}"/>`);
                out.push(`<text class="ibd-thread-title" x="10" y="${fmt(baseline(4, M.threadHeaderLine, M.nameFont))}">`
                    + `<tspan class="ibd-stereotype">«thread»</tspan> <tspan class="ibd-thread-name">${escapeXml(node.name)}</tspan></text>`);
                if (node.details) {
                    out.push(`<text class="ibd-thread-details" x="10" y="${fmt(baseline(4 + M.threadHeaderLine, M.threadHeaderLine, M.detailsFont))}">${escapeXml(node.details)}</text>`);
                }
                break;
            default:
                this.block(node, out);
        }
        node.children.forEach(child => this.node(child, out));
        node.ports.forEach(port => this.port(port, out));
        out.push('</g>');
    }

    private block(node: IbdNode, out: string[]): void {
        const icon = node.behavior || node.composite ? M.iconWidth : 0;
        const center = (node.width - icon) / 2;
        const name = node.typeName !== undefined ? `${node.name} : ${node.typeName}` : node.name;
        out.push(`<rect class="ibd-instance-shape" x="0" y="0" rx="2" ry="2" width="${fmt(node.width)}" height="${fmt(node.height)}"/>`);
        out.push(`<text class="ibd-stereotype ibd-block-stereotype" x="${fmt(center)}" y="${fmt(baseline(4, 15, M.stereotypeFont))}">«${escapeXml(node.stereotype ?? 'component')}»</text>`);
        out.push(`<text class="ibd-instance-name" x="${fmt(center)}" y="${fmt(baseline(18, 18, M.nameFont))}">${escapeXml(name)}</text>`);
        out.push(`<line class="ibd-instance-separator" x1="0" y1="${fmt(node.headerHeight)}" x2="${fmt(node.width)}" y2="${fmt(node.headerHeight)}"/>`);
        if (node.composite) {
            out.push(`<g class="ibd-icon ibd-composite-icon"><title>${escapeXml(`Composite: structure ${node.composite.structure}`)}</title>`
                + `<path d="${compositeIconPath(node.width - M.iconWidth - 2, node.headerHeight / 2)}"/></g>`);
        } else if (node.behavior) {
            const icon = behaviorIconPath(node.width - M.iconWidth - 2, node.headerHeight / 2);
            out.push(`<g class="ibd-icon ibd-behavior-icon"><title>${escapeXml(`Behavior: state machine ${node.behavior.machine ?? '?'}`)}</title>`
                + icon.states.map(s => `<rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${s.width}" height="${s.height}" rx="2" ry="2"/>`).join('')
                + `<path d="${icon.line}"/></g>`);
        }
    }

    private port(port: IbdPort, out: string[]): void {
        out.push(`<g class="${this.classes(portClasses(port), port.id)}">`);
        out.push(`<title>${escapeXml(portTooltip(port))}</title>`);
        out.push(`<rect class="ibd-port-shape" x="${fmt(port.x)}" y="${fmt(port.y)}" width="${port.size}" height="${port.size}"/>`);
        const chevron = portChevron(port);
        if (chevron) {
            out.push(`<path class="ibd-port-chevron" transform="translate(${fmt(port.x)}, ${fmt(port.y)})" d="${chevron}"/>`);
        }
        out.push(`<text class="ibd-port-label" x="${fmt(port.label.x)}" y="${fmt(baseline(port.label.y, port.label.height, M.portFont))}">${escapeXml(port.label.text)}</text>`);
        out.push('</g>');
    }

    edge(edge: IbdEdge, out: string[]): void {
        if (edge.points.length < 2) {
            return;
        }
        const classes = ['ibd-connector', edge.kind === 'delegate' ? 'delegation' : 'connection', ...(edge.crossThread ? ['cross-thread'] : [])];
        out.push(`<g class="${this.classes(classes, edge.id)}"><title>${escapeXml(edge.title)}</title>`
            + `<path class="ibd-connector-line" d="${ibdRoutePath(edge.points)}"/></g>`);
    }
}


function baseline(top: number, height: number, fontSize: number): number {
    return top + height / 2 + fontSize * 0.35;
}

function fmt(value: number): string {
    const rounded = Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
    return String(Object.is(rounded, -0) ? 0 : rounded);
}
