/** @jsx svg */
import { injectable } from 'inversify';
import { ShapeView, svg, type IView, type RenderingContext } from 'sprotty';
import type { VNode } from 'snabbdom';
import { DiagramMetrics, type Point } from 'hsm-language';
import type { Issue, TransitionEdge, VertexNode } from './model.js';

const m = DiagramMetrics;

/** Baseline of a text line with the given font size inside a box starting at `top` with `height`. */
function baseline(top: number, height: number, fontSize: number): number {
    return top + height / 2 + fontSize * 0.35;
}

function issueMarker(issue: Issue | undefined, x: number, y: number): VNode | undefined {
    if (!issue) {
        return undefined;
    }
    return <g class-issue={true} class-issue-error={issue.severity === 'error'} class-issue-warning={issue.severity === 'warning'}
        transform={`translate(${x}, ${y})`}>
        <title>{issue.messages.join('\n')}</title>
        <circle r={7} cx={0} cy={0} />
        <text x={0} y={4}>!</text>
    </g>;
}

function vertexClasses(node: Readonly<VertexNode>): Record<string, boolean> {
    return {
        'class-hsm-node': true,
        'class-selected': node.selected,
        'class-mouseover': node.hoverFeedback,
        'class-pending-source': node.pendingSource,
        'class-has-error': node.issue?.severity === 'error',
        'class-has-warning': node.issue?.severity === 'warning'
    };
}

/**
 * A state in the style of PlantUML: a rounded box with the name in the header compartment,
 * a separator line and the body compartment with description, actions and internal transitions.
 * Sub states are rendered inside the body of composite states.
 */
@injectable()
export class StateView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        const header = node.headerHeight;
        const lineHeight = m.lineHeight.body;
        return <g {...vertexClasses(node)} class-state={true} class-composite={node.composite}>
            <rect class-state-shape={true} x={0} y={0} rx={12.5} ry={12.5} width={width} height={height} />
            <text class-state-name={true} x={width / 2} y={baseline(0, header, m.fontSize.name)}>{node.name ?? ''}</text>
            <line class-state-separator={true} x1={0} y1={header} x2={width} y2={header} />
            {...node.body.map((line, i) =>
                <text class-state-body={true} x={m.bodyPadding} y={baseline(header + m.bodyPadding + i * lineHeight, lineHeight, m.fontSize.body)}>{line}</text>)}
            {context.renderChildren(node)}
            {issueMarker(node.issue, width - 4, 4)}
        </g>;
    }
}

/** Orthogonal region: separated from its predecessor by a dashed line. */
@injectable()
export class RegionView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        const vertical = node.separator === 'top';
        return <g {...vertexClasses(node)} class-region={true}>
            <rect class-region-shape={true} x={0} y={0} width={width} height={height} />
            {node.regionIndex > 0
                ? (vertical
                    ? <line class-region-separator={true} x1={0} y1={0} x2={width} y2={0} />
                    : <line class-region-separator={true} x1={0} y1={0} x2={0} y2={height} />)
                : undefined}
            {node.name ? <text class-region-name={true} x={6} y={m.regionPadding + 2}>{node.name}</text> : undefined}
            {context.renderChildren(node)}
            {issueMarker(node.issue, width - 10, 10)}
        </g>;
    }
}

@injectable()
export class InitialView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const r = node.size.width / 2;
        return <g {...vertexClasses(node)} class-initial={true}>
            <circle class-initial-shape={true} cx={r} cy={r} r={r} />
            {issueMarker(node.issue, 2 * r, 0)}
        </g>;
    }
}

@injectable()
export class FinalView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const r = node.size.width / 2;
        return <g {...vertexClasses(node)} class-final={true}>
            <circle class-final-outer={true} cx={r} cy={r} r={r - 0.5} />
            <circle class-final-inner={true} cx={r} cy={r} r={r - 5} />
        </g>;
    }
}

@injectable()
export class ChoiceView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width: w, height: h } = node.size;
        return <g {...vertexClasses(node)} class-choice={true}>
            <title>{node.name ?? ''}</title>
            <polygon class-choice-shape={true} points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
            {issueMarker(node.issue, w, 0)}
        </g>;
    }
}

@injectable()
export class JunctionView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const r = node.size.width / 2;
        return <g {...vertexClasses(node)} class-junction={true}>
            <title>{node.name ?? ''}</title>
            <circle class-junction-shape={true} cx={r} cy={r} r={r} />
            {issueMarker(node.issue, 2 * r, 0)}
        </g>;
    }
}

@injectable()
export class HistoryView extends ShapeView {
    render(node: Readonly<VertexNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const r = node.size.width / 2;
        return <g {...vertexClasses(node)} class-history={true}>
            <title>{node.name ?? ''}</title>
            <circle class-history-shape={true} cx={r} cy={r} r={r - 0.5} />
            <text class-history-text={true} x={r} y={r + 4.5}>{node.kind === 'deephistory' ? 'H*' : 'H'}</text>
            {issueMarker(node.issue, 2 * r, 0)}
        </g>;
    }
}

/** Renders a transition along the route computed by ELK, with a PlantUML like arrow head. */
@injectable()
export class TransitionView implements IView {
    render(edge: Readonly<TransitionEdge>, _context: RenderingContext): VNode | undefined {
        const points = edge.points;
        if (points.length < 2) {
            return undefined;
        }
        const path = routePath(points, edge.routing === 'spline');
        const end = points[points.length - 1];
        // direction of the last segment: for splines the last control point
        let previous = points[points.length - 2];
        for (let i = points.length - 2; i >= 0 && distance(points[i], end) < 0.5; i--) {
            previous = points[i];
        }
        const label = edge.label;
        return <g class-transition={true} class-selected={edge.selected} class-mouseover={edge.hoverFeedback}
            class-has-error={edge.issue?.severity === 'error'} class-has-warning={edge.issue?.severity === 'warning'}>
            <path class-transition-hit={true} d={path} />
            <path class-transition-line={true} d={path} />
            <path class-transition-arrow={true} d={arrowHead(previous, end)} />
            {label
                ? <g class-transition-label={true}>
                    <rect class-transition-label-hit={true} x={label.x} y={label.y} width={label.width} height={label.height} />
                    <text x={label.x + 2} y={baseline(label.y, label.height, m.fontSize.label)}>{label.text}</text>
                </g>
                : undefined}
            {issueMarker(edge.issue, label ? label.x + label.width + 8 : (points[0].x + end.x) / 2, label ? label.y + label.height / 2 : (points[0].y + end.y) / 2)}
        </g>;
    }
}

function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function routePath(points: Point[], spline: boolean): string {
    const p = (point: Point) => `${round(point.x)},${round(point.y)}`;
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
    const pt = (dx: number, dy: number) => `${round(to.x + dx * cos - dy * sin)},${round(to.y + dx * sin + dy * cos)}`;
    return `M ${pt(0, 0)} L ${pt(-length, -halfWidth)} L ${pt(-length + notch, 0)} L ${pt(-length, halfWidth)} Z`;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
