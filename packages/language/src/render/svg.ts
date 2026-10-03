import type { DiagramEdge, DiagramGraph, DiagramNode, Point } from '../diagram/diagram-model.js';
import { DiagramMetrics, submachinePointPositions } from '../diagram/layout.js';
import { helveticaTextWidth } from '../diagram/text-metrics.js';
import { DIAGRAM_CSS } from './diagram-styles.js';

/*
 * Renders a laid out diagram (`layoutStateMachine`) as a standalone SVG document without a DOM, so it
 * works in Node.js (CLI, CI, documentation) as well as in the browser. The output has the structure and
 * the CSS classes of the diagram of the web editor (packages/web/src/diagram/views.tsx) and uses the
 * same style sheet (`DIAGRAM_CSS`), so it looks like an SVG exported from the editor.
 */

export type DiagramTheme = 'classic' | 'modern' | 'dark';

export const DIAGRAM_THEMES: readonly DiagramTheme[] = ['classic', 'modern', 'dark'];

/**
 * Highlight of a diagram element: `'covered'` (CSS class `devm-covered`), `'uncovered'` (`devm-uncovered`),
 * `'active'` (`active`, the look of active states in the simulation) or any other CSS class name(s).
 */
export type HighlightKind = 'covered' | 'uncovered' | 'active' | (string & {});

export interface LegendEntry {
    /** Highlight kind or CSS class of the sample shapes. */
    kind: HighlightKind;
    label: string;
}

export interface SvgRenderOptions {
    /** Default: `'classic'`. */
    theme?: DiagramTheme;
    /**
     * Highlights of states, pseudo states and transitions by diagram element id (the ids of
     * `LayoutResult.ids`, e.g. `layout.ids.get(stateNode)`). The class is added to the `<g>` element
     * of the node (class `devm-node`) or transition (class `transition`).
     */
    highlight?: ReadonlyMap<string, HighlightKind>;
    /** Title shown above the diagram (and as `<title>` of the document). */
    title?: string;
    /**
     * Legend below the diagram: `true` shows the used highlight kinds `covered`, `uncovered` and `active`,
     * or explicit entries. Default: no legend.
     */
    legend?: boolean | LegendEntry[];
    /**
     * Embed the diagram style sheet (default: true). Without it the document relies on `DIAGRAM_CSS`
     * being present in the embedding page (e.g. several SVGs inlined into one HTML page).
     */
    embedStyles?: boolean;
    /** Start with `<?xml …?>` (default: true; set to false to inline the SVG into HTML). */
    xmlDeclaration?: boolean;
}

const m = DiagramMetrics;
const TITLE_HEIGHT = 30;
const LEGEND_ROW_HEIGHT = 22;

/** Maps a highlight kind to the CSS class(es) added to the element. */
export function highlightClass(kind: HighlightKind): string {
    switch (kind) {
        case 'covered':
            return 'devm-covered';
        case 'uncovered':
            return 'devm-uncovered';
        default:
            return kind.split(/\s+/).filter(c => /^-?[_a-zA-Z][\w-]*$/.test(c)).join(' ');
    }
}

const DEFAULT_LEGEND_LABELS: Record<string, string> = {
    covered: 'covered',
    uncovered: 'not covered',
    active: 'active'
};

/**
 * Renders the diagram as a standalone SVG document with the look of the web editor.
 * Pure function: no DOM, no I/O.
 */
export function renderSvg(graph: DiagramGraph, options: SvgRenderOptions = {}): string {
    const theme = options.theme ?? 'classic';
    const highlight = options.highlight ?? new Map<string, HighlightKind>();
    const legend = legendEntries(options.legend, highlight);
    const top = options.title ? TITLE_HEIGHT : 0;
    const diagramWidth = Math.ceil(num(graph.width));
    const diagramHeight = Math.ceil(num(graph.height));
    const legendWidth = legend.length > 0 ? Math.ceil(Math.max(...legend.map(e => helveticaTextWidth(e.label, 12))) + 90) : 0;
    const legendHeight = legend.length > 0 ? legend.length * LEGEND_ROW_HEIGHT + 16 : 0;
    const titleWidth = options.title ? Math.ceil(helveticaTextWidth(options.title, 16) * 1.1) + 40 : 0;
    const width = Math.max(diagramWidth, legendWidth + 40, titleWidth, 1);
    const height = Math.max(top + diagramHeight + legendHeight + (legend.length > 0 ? 20 : 0), 1);

    const out: string[] = [];
    if (options.xmlDeclaration ?? true) {
        out.push('<?xml version="1.0" encoding="UTF-8"?>');
    }
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="sprotty-graph theme-${theme} devm-export" width="${width}" height="${height}" `
        + `viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`);
    out.push(`<title>${escapeXml(options.title ?? graph.name)}</title>`);
    if (options.embedStyles ?? true) {
        out.push(`<style><![CDATA[${DIAGRAM_CSS}]]></style>`);
    }
    out.push('<rect class="export-background" width="100%" height="100%"/>');
    if (options.title) {
        out.push(`<text class="devm-title" x="20" y="${TITLE_HEIGHT - 6}">${escapeXml(options.title)}</text>`);
    }
    const renderer = new SvgWriter(highlight, graph.direction);
    out.push(top > 0 ? `<g transform="translate(0, ${top})">` : '<g>');
    for (const node of graph.children) {
        renderer.node(node, out);
    }
    for (const edge of graph.edges) {
        renderer.edge(edge, out);
    }
    out.push('</g>');
    if (legend.length > 0) {
        renderLegend(legend, 20, top + diagramHeight + 10, legendWidth, legendHeight, out);
    }
    out.push('</svg>');
    return out.join('\n') + '\n';
}

function legendEntries(legend: SvgRenderOptions['legend'], highlight: ReadonlyMap<string, HighlightKind>): LegendEntry[] {
    if (Array.isArray(legend)) {
        return legend;
    }
    if (!legend) {
        return [];
    }
    const used = new Set(highlight.values());
    return Object.keys(DEFAULT_LEGEND_LABELS).filter(kind => used.has(kind)).map(kind => ({ kind, label: DEFAULT_LEGEND_LABELS[kind] }));
}

function renderLegend(entries: LegendEntry[], x: number, y: number, width: number, height: number, out: string[]): void {
    out.push(`<g class="devm-legend" transform="translate(${x}, ${y})">`);
    out.push(`<rect class="devm-legend-frame" x="0" y="0" width="${width}" height="${height}" rx="3" ry="3"/>`);
    entries.forEach((entry, i) => {
        const cls = highlightClass(entry.kind);
        const rowY = 8 + i * LEGEND_ROW_HEIGHT;
        out.push(`<g class="devm-node state ${cls}" transform="translate(10, ${rowY + 3})">`
            + '<rect class="state-shape" x="0" y="0" rx="5" ry="5" width="26" height="14"/></g>');
        const line: Point[] = [{ x: 44, y: rowY + 10 }, { x: 72, y: rowY + 10 }];
        out.push(`<g class="transition ${cls}"><path class="transition-line" d="${routePath(line, false)}"/>`
            + `<path class="transition-arrow" d="${arrowHead(line[0], line[1])}"/></g>`);
        out.push(`<text class="devm-legend-label" x="80" y="${rowY + 14}">${escapeXml(entry.label)}</text>`);
    });
    out.push('</g>');
}

class SvgWriter {

    constructor(private readonly highlight: ReadonlyMap<string, HighlightKind>, private readonly direction: DiagramGraph['direction']) { }

    private classes(base: string[], id: string): string {
        const kind = this.highlight.get(id);
        const extra = kind !== undefined ? highlightClass(kind) : '';
        return [...base, extra].filter(c => c).join(' ');
    }

    node(node: DiagramNode, out: string[]): void {
        const x = num(node.x);
        const y = num(node.y);
        const width = num(node.width);
        const height = num(node.height);
        const open = (kindClasses: string[]) =>
            out.push(`<g class="${this.classes(['devm-node', ...kindClasses], node.id)}" transform="translate(${fmt(x)}, ${fmt(y)})">`);
        const title = (text: string) => out.push(`<title>${escapeXml(text)}</title>`);
        switch (node.kind) {
            case 'state': {
                open(node.composite ? ['state', 'composite'] : ['state']);
                const header = num(node.headerHeight ?? m.headerHeight);
                out.push(`<rect class="state-shape" x="0" y="0" rx="12.5" ry="12.5" width="${fmt(width)}" height="${fmt(height)}"/>`);
                const submachine = node.submachine;
                const name = submachine ? `${node.name ?? ''} : ${submachine.machine}` : node.name ?? '';
                out.push(text('state-name', (width - (submachine ? m.submachineIconWidth : 0)) / 2, baseline(0, header, m.fontSize.name), name));
                out.push(`<line class="state-separator" x1="0" y1="${fmt(header)}" x2="${fmt(width)}" y2="${fmt(header)}"/>`);
                (node.body ?? []).forEach((line, i) => {
                    const lineY = baseline(header + m.bodyPadding + i * m.lineHeight.body, m.lineHeight.body, m.fontSize.body);
                    out.push(text(submachine?.line === i ? 'state-body submachine-instance' : 'state-body', m.bodyPadding, lineY, preserveIndent(line), node.bodyTitles?.[i]));
                });
                if (submachine) {
                    out.push(submachineIcon(width - m.submachineIconWidth + 2, header / 2));
                    for (const point of submachinePointPositions(node, this.direction)) {
                        out.push(submachinePoint(point, this.direction));
                    }
                }
                node.children.forEach(child => this.node(child, out));
                break;
            }
            case 'region': {
                open(['region']);
                out.push(`<rect class="region-shape" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}"/>`);
                if ((node.index ?? 0) > 0) {
                    // regions are stacked in the layout direction, the separator faces the previous region
                    out.push(this.direction !== 'RIGHT'
                        ? `<line class="region-separator" x1="0" y1="0" x2="${fmt(width)}" y2="0"/>`
                        : `<line class="region-separator" x1="0" y1="0" x2="0" y2="${fmt(height)}"/>`);
                }
                if (node.name) {
                    out.push(text('region-name', 6, m.regionPadding + 2, node.name));
                }
                node.children.forEach(child => this.node(child, out));
                break;
            }
            case 'initial': {
                const r = width / 2;
                open(['initial']);
                out.push(`<circle class="initial-shape" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r)}"/>`);
                break;
            }
            case 'final': {
                const r = width / 2;
                open(['final']);
                out.push(`<circle class="final-outer" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r - 0.5)}"/>`);
                out.push(`<circle class="final-inner" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r - 5)}"/>`);
                break;
            }
            case 'choice':
                open(['choice']);
                title(node.name ?? '');
                out.push(`<polygon class="choice-shape" points="${fmt(width / 2)},0 ${fmt(width)},${fmt(height / 2)} ${fmt(width / 2)},${fmt(height)} 0,${fmt(height / 2)}"/>`);
                break;
            case 'junction': {
                const r = width / 2;
                open(['junction']);
                title(node.name ?? '');
                out.push(`<circle class="junction-shape" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r)}"/>`);
                break;
            }
            case 'history':
            case 'deephistory': {
                const r = width / 2;
                open(['history']);
                title(node.name ?? '');
                out.push(`<circle class="history-shape" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r - 0.5)}"/>`);
                out.push(text('history-text', r, r + 4.5, node.kind === 'deephistory' ? 'H*' : 'H'));
                break;
            }
            case 'sync':
                open(['sync']);
                title(node.name ?? '');
                out.push(`<rect class="sync-shape" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" rx="1.5" ry="1.5"/>`);
                break;
            case 'entry': {
                const r = width / 2;
                open(['entry-point']);
                title(`Entry point ${node.name ?? ''}`);
                out.push(`<circle class="entry-shape" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r - 0.75)}"/>`);
                this.nodeLabel(node, out);
                break;
            }
            case 'exit': {
                const r = width / 2;
                const d = (r - 0.75) * Math.SQRT1_2;
                open(['exit-point']);
                title(`Exit node ${node.name ?? ''}`);
                out.push(`<circle class="exit-shape" cx="${fmt(r)}" cy="${fmt(r)}" r="${fmt(r - 0.75)}"/>`);
                out.push(`<path class="exit-cross" d="M ${fmt(r - d)},${fmt(r - d)} L ${fmt(r + d)},${fmt(r + d)} M ${fmt(r - d)},${fmt(r + d)} L ${fmt(r + d)},${fmt(r - d)}"/>`);
                this.nodeLabel(node, out);
                break;
            }
            case 'definition': {
                open(['definition']);
                const header = num(node.headerHeight ?? m.headerHeight);
                out.push(`<rect class="definition-shape" x="0" y="0" rx="3" ry="3" width="${fmt(width)}" height="${fmt(height)}"/>`);
                out.push(`<text class="definition-header" x="${fmt(m.bodyPadding + 2)}" y="${fmt(baseline(0, header, m.fontSize.name))}">`
                    + `<tspan class="definition-name">${escapeXml(node.name ?? '')}</tspan>`
                    + '<tspan class="definition-kind" dx="6">definitions</tspan></text>');
                out.push(`<line class="definition-separator" x1="0" y1="${fmt(header)}" x2="${fmt(width)}" y2="${fmt(header)}"/>`);
                (node.body ?? []).forEach((line, i) => {
                    const lineY = baseline(header + m.bodyPadding + i * m.lineHeight.code, m.lineHeight.code, m.fontSize.code);
                    const cls = line.startsWith(' ') ? 'definition-line' : 'definition-line definition-scope';
                    out.push(text(cls, m.bodyPadding + 2, lineY, preserveIndent(line), node.bodyTitles?.[i]));
                });
                break;
            }
            default:
                open([node.kind]);
                node.children.forEach(child => this.node(child, out));
        }
        out.push('</g>');
    }

    private nodeLabel(node: DiagramNode, out: string[]): void {
        const label = node.label;
        if (label) {
            out.push(text('node-label', num(label.x) + 1, baseline(num(label.y), num(label.height), m.fontSize.label), label.text));
        }
    }

    edge(edge: DiagramEdge, out: string[]): void {
        const points = edge.points.map(p => ({ x: num(p.x), y: num(p.y) }));
        if (points.length < 2) {
            return;
        }
        const path = routePath(points, edge.routing === 'spline');
        const end = points[points.length - 1];
        // direction of the last segment: for splines the last control point
        let previous = points[points.length - 2];
        for (let i = points.length - 2; i >= 0 && distance(points[i], end) < 0.5; i--) {
            previous = points[i];
        }
        out.push(`<g class="${this.classes(['transition'], edge.id)}">`);
        out.push(`<path class="transition-line" d="${path}"/>`);
        out.push(`<path class="transition-arrow" d="${arrowHead(previous, end)}"/>`);
        const label = edge.label;
        if (label) {
            out.push('<g class="transition-label">');
            out.push(text(undefined, num(label.x) + 2, baseline(num(label.y), num(label.height), m.fontSize.label), label.text, label.title));
            out.push('</g>');
        }
        out.push('</g>');
    }
}

/** The submachine icon ("rake": two linked states) with its left edge at `x`, vertically centered at `y`. */
export function submachineIcon(x: number, y: number): string {
    return `<g class="submachine-icon"><title>Submachine state</title>`
        + `<rect x="${fmt(x)}" y="${fmt(y - 3)}" width="6" height="6" rx="1.5" ry="1.5"/>`
        + `<rect x="${fmt(x + 10)}" y="${fmt(y - 3)}" width="6" height="6" rx="1.5" ry="1.5"/>`
        + `<line x1="${fmt(x + 6)}" y1="${fmt(y)}" x2="${fmt(x + 10)}" y2="${fmt(y)}"/></g>`;
}

/** An entry point / exit node of a submachine instance on the border of its state, with its name outside the state. */
export function submachinePoint(point: { kind: 'entry' | 'exit', name: string, x: number, y: number }, direction: 'DOWN' | 'RIGHT'): string {
    const r = m.submachinePointRadius;
    const { x, y } = point;
    const d = r * Math.SQRT1_2;
    const cross = point.kind === 'exit'
        ? `<path class="exit-cross" d="M ${fmt(x - d)},${fmt(y - d)} L ${fmt(x + d)},${fmt(y + d)} M ${fmt(x - d)},${fmt(y + d)} L ${fmt(x + d)},${fmt(y - d)}"/>` : '';
    const label = direction === 'DOWN'
        ? `<text class="submachine-point-label" x="${fmt(x + r + 2)}" y="${fmt(point.kind === 'entry' ? y - r - 1 : y + r + 10)}">${escapeXml(point.name)}</text>`
        : `<text class="submachine-point-label" x="${fmt(point.kind === 'entry' ? x - r - 2 : x + r + 2)}" y="${fmt(y - r - 1)}" text-anchor="${point.kind === 'entry' ? 'end' : 'start'}">${escapeXml(point.name)}</text>`;
    return `<g class="submachine-point ${point.kind}-point"><title>${point.kind === 'entry' ? 'Entry point' : 'Exit node'} ${escapeXml(point.name)} of the submachine</title>`
        + `<circle class="${point.kind}-shape" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}"/>${cross}${label}</g>`;
}

function text(cls: string | undefined, x: number, y: number, content: string, title?: string): string {
    const classAttribute = cls ? ` class="${cls}"` : '';
    const titleElement = title ? `<title>${escapeXml(title)}</title>` : '';
    return `<text${classAttribute} x="${fmt(x)}" y="${fmt(y)}">${escapeXml(content)}${titleElement}</text>`;
}

/** Baseline of a text line with the given font size inside a box starting at `top` with `height`. */
function baseline(top: number, height: number, fontSize: number): number {
    return top + height / 2 + fontSize * 0.35;
}

/** SVG collapses white space: leading blanks (indentation of wrapped lines) become non-breaking spaces. */
function preserveIndent(line: string): string {
    return line.replace(/^ +/, match => ' '.repeat(match.length));
}

function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** SVG path of a route: cubic bezier segments for splines, a polyline otherwise. */
export function routePath(points: Point[], spline: boolean): string {
    const p = (point: Point) => `${fmt(point.x)},${fmt(point.y)}`;
    let d = `M ${p(points[0])}`;
    if (spline) {
        for (let i = 1; i + 2 < points.length; i += 3) {
            d += ` C ${p(points[i])} ${p(points[i + 1])} ${p(points[i + 2])}`;
        }
    } else {
        for (let i = 1; i < points.length; i++) {
            d += ` L ${p(points[i])}`;
        }
    }
    return d;
}

/** Filled arrow head with a slight notch, similar to the arrows of PlantUML / Graphviz. */
export function arrowHead(from: Point, to: Point): string {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const length = 10;
    const halfWidth = 4.5;
    const notch = 3;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pt = (dx: number, dy: number) => `${fmt(to.x + dx * cos - dy * sin)},${fmt(to.y + dx * sin + dy * cos)}`;
    return `M ${pt(0, 0)} L ${pt(-length, -halfWidth)} L ${pt(-length + notch, 0)} L ${pt(-length, halfWidth)} Z`;
}

/** A finite number (0 otherwise). */
function num(value: number | undefined): number {
    return value !== undefined && Number.isFinite(value) ? value : 0;
}

/** Number with at most two decimals. */
function fmt(value: number): string {
    const rounded = Math.round(num(value) * 100) / 100;
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Escapes text for XML content and attribute values and removes characters not allowed in XML. */
export function escapeXml(value: string): string {
    return value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
