/** @jsx svg */
import { injectable } from 'inversify';
import { ShapeView, svg, type IView, type RenderingContext } from 'sprotty';
import type { VNode } from 'snabbdom';
import { IbdMetrics as M, behaviorIconPath, compositeIconPath, frameTabPath, ibdRoutePath, portChevron, portTooltip } from 'hsm-language';
import type { IbdConnectorElement, IbdNodeElement, IbdPortElement } from './ibd-model.js';
import type { Issue } from './model.js';

/*
 * Views of the internal block diagram of a structure. They render the same SVG structure and
 * CSS classes as `renderIbdSvg` (packages/language/src/render/ibd-svg.ts), see the notation in
 * docs/structure-language.md#diagram.
 */

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

/** Manual layout: the resize handle of a selected node (bottom right corner). */
function resizeHandle(node: Readonly<IbdNodeElement>): VNode | undefined {
    if (!node.resizable || !node.selected) {
        return undefined;
    }
    const { width, height } = node.size;
    return <rect class-resize-handle={true} x={width - 9} y={height - 9} width={9} height={9}><title>Drag to resize</title></rect>;
}

function nodeClasses(node: Readonly<IbdNodeElement>): Record<string, boolean> {
    return {
        'class-ibd-node': true,
        [`class-ibd-${node.kind}`]: true,
        'class-has-behavior': !!node.behavior,
        'class-composite': !!node.composite,
        'class-selected': node.selected,
        'class-mouseover': node.hoverFeedback,
        'class-on-route': node.onRoute,
        'class-has-error': node.issue?.severity === 'error',
        'class-has-warning': node.issue?.severity === 'warning'
    };
}

/** The frame of the structure with the tab `ibd [system] Name`; boundary ports on its border. */
@injectable()
export class IbdFrameView extends ShapeView {
    render(node: Readonly<IbdNodeElement>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        return <g {...nodeClasses(node)}>
            {node.description ? <title>{node.description}</title> : undefined}
            <rect class-ibd-frame-shape={true} class-ibd-node-shape={true} x={0} y={0} width={width} height={height} />
            <path class-ibd-frame-tab={true} d={frameTabPath(node.tabWidth ?? 120, node.headerHeight)} />
            <text class-ibd-frame-title={true} x={8} y={baseline(0, node.headerHeight, M.tabFont)}>
                <tspan class-ibd-frame-kind={true}>ibd</tspan>
                {` [${node.stereotype ?? 'subsystem'}] `}
                <tspan class-ibd-frame-name={true}>{node.name}</tspan>
            </text>
            {context.renderChildren(node)}
            {issueMarker(node.issue, (node.tabWidth ?? 120) + 10, node.headerHeight / 2)}
            {resizeHandle(node)}
        </g>;
    }
}

/** A thread: a rounded, tinted frame with `«thread» Name` and its settings, enclosing its instances. */
@injectable()
export class IbdThreadView extends ShapeView {
    render(node: Readonly<IbdNodeElement>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        return <g {...nodeClasses(node)}>
            {node.description ? <title>{node.description}</title> : undefined}
            <rect class-ibd-thread-shape={true} class-ibd-node-shape={true} x={0} y={0} rx={6} ry={6} width={width} height={height} />
            <text class-ibd-thread-title={true} x={10} y={baseline(4, M.threadHeaderLine, M.nameFont)}>
                <tspan class-ibd-stereotype={true}>«thread»</tspan>
                {' '}
                <tspan class-ibd-thread-name={true}>{node.name}</tspan>
            </text>
            {node.details
                ? <text class-ibd-thread-details={true} x={10} y={baseline(4 + M.threadHeaderLine, M.threadHeaderLine, M.detailsFont)}>{node.details}</text>
                : undefined}
            {context.renderChildren(node)}
            {issueMarker(node.issue, width - 4, 4)}
            {resizeHandle(node)}
        </g>;
    }
}

/** An instance (`door : DoorController`) or a component block, with the behavior or composite icon. */
@injectable()
export class IbdInstanceView extends ShapeView {
    render(node: Readonly<IbdNodeElement>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        const icon = node.behavior || node.composite ? M.iconWidth : 0;
        const center = (width - icon) / 2;
        const behaviorIcon = node.behavior && !node.composite ? behaviorIconPath(width - M.iconWidth - 2, node.headerHeight / 2) : undefined;
        return <g {...nodeClasses(node)}>
            {node.description ? <title>{node.description}</title> : undefined}
            <rect class-ibd-instance-shape={true} class-ibd-node-shape={true} x={0} y={0} rx={2} ry={2} width={width} height={height} />
            <text class-ibd-stereotype={true} class-ibd-block-stereotype={true} x={center} y={baseline(4, 15, M.stereotypeFont)}>{`«${node.stereotype ?? 'component'}»`}</text>
            {node.typeName !== undefined
                ? <text class-ibd-instance-name={true} x={center} y={baseline(18, 18, M.nameFont)}>
                    <tspan class-ibd-instance-label={true}>{node.name}</tspan>
                    {' : '}
                    <tspan class-ibd-instance-type={true}><title>{`${node.typeName} – double-click to open the type`}</title>{node.typeName}</tspan>
                </text>
                : <text class-ibd-instance-name={true} x={center} y={baseline(18, 18, M.nameFont)}>{node.name}</text>}
            <line class-ibd-instance-separator={true} x1={0} y1={node.headerHeight} x2={width} y2={node.headerHeight} />
            {node.composite
                ? <g class-ibd-icon={true} class-ibd-composite-icon={true}>
                    <title>{`Subsystem ${node.composite.structure} (has an internal block diagram) – double-click to open it`}</title>
                    <path d={compositeIconPath(width - M.iconWidth - 2, node.headerHeight / 2)} />
                </g>
                : undefined}
            {behaviorIcon
                ? <g class-ibd-icon={true} class-ibd-behavior-icon={true}>
                    <title>{`Behavior: state machine ${node.behavior?.machine ?? '?'}`}</title>
                    {...behaviorIcon.states.map(s => <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={2} ry={2} />)}
                    <path d={behaviorIcon.line} />
                </g>
                : undefined}
            {context.renderChildren(node)}
            {issueMarker(node.issue, width - 4, 4)}
            {resizeHandle(node)}
        </g>;
    }
}

/**
 * A struct or interface of the file: a value type box «struct» / «interface» with the name and the fields
 * / events; never connected (ports show their type in their label).
 */
@injectable()
export class IbdTypeView extends ShapeView {
    render(node: Readonly<IbdNodeElement>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        const center = width / 2;
        const members = node.members ?? [];
        const row = (i: number) => baseline(node.headerHeight + 5 + i * M.memberRow, M.memberRow, M.memberFont);
        return <g {...nodeClasses(node)}>
            <title>{node.description ? `${node.description}\n` : ''}{`${node.stereotype ?? 'struct'} ${node.name} – click to show the declaration`}</title>
            <rect class-ibd-type-shape={true} class-ibd-node-shape={true} x={0} y={0} width={width} height={height} />
            <rect class-ibd-type-header={true} x={0.6} y={0.6} width={width - 1.2} height={node.headerHeight - 0.6} />
            <text class-ibd-stereotype={true} class-ibd-type-stereotype={true} x={center} y={baseline(4, 15, M.stereotypeFont)}>{`«${node.stereotype ?? 'struct'}»`}</text>
            <text class-ibd-type-name={true} x={center} y={baseline(18, 18, M.nameFont)}>{node.name}</text>
            <line class-ibd-type-separator={true} x1={0} y1={node.headerHeight} x2={width} y2={node.headerHeight} />
            {...members.map((member, i) => <text class-ibd-type-member={true} x={M.instancePadding} y={row(i)}>
                {member.prefix ? <tspan class-ibd-type-keyword={true}>{member.prefix.trim()}</tspan> : undefined}
                {member.prefix ? ' ' : undefined}
                <tspan class-ibd-type-member-name={true}>{member.name}</tspan>
                {member.type ? ' : ' : undefined}
                {member.type ? <tspan class-ibd-type-member-type={true}>{member.type}</tspan> : undefined}
            </text>)}
            {members.length === 0
                ? <text class-ibd-type-member={true} class-ibd-type-empty={true} x={M.instancePadding} y={row(0)}>{node.stereotype === 'interface' ? 'no events' : 'no fields'}</text>
                : undefined}
            {issueMarker(node.issue, width - 4, 4)}
            {resizeHandle(node)}
        </g>;
    }
}

/** A port: a square on the border (filled: provided, hollow: required), a chevron for async ports, the label. */
@injectable()
export class IbdPortView extends ShapeView {
    render(port: Readonly<IbdPortElement>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(port, context)) {
            return undefined;
        }
        const size = port.size.width;
        const chevron = portChevron({ direction: port.direction, kind: port.kind, side: port.side, size });
        const label = port.label;
        return <g class-ibd-port={true} class-provided={port.direction === 'provides'} class-required={port.direction === 'requires'}
            class-sync={port.kind === 'sync'} class-async={port.kind === 'async'}
            class-selected={port.selected} class-mouseover={port.hoverFeedback} class-on-route={port.onRoute}
            class-has-error={port.issue?.severity === 'error'} class-has-warning={port.issue?.severity === 'warning'}
            class-connect-ok={port.connect === 'ok'} class-connect-problem={port.connect === 'problem'} class-connect-invalid={port.connect === 'invalid'}
            class-connect-source={port.connectSource} class-movable={port.movable}>
            <title>{portTooltip({ title: port.title, direction: port.direction, kind: port.kind })}</title>
            <rect class-ibd-port-shape={true} x={0} y={0} width={size} height={size} />
            {chevron ? <path class-ibd-port-chevron={true} d={chevron} /> : undefined}
            {label
                ? <text class-ibd-port-label={true} x={label.x} y={baseline(label.y, label.height, M.portFont)}>
                    {port.typeName !== undefined
                        ? [<tspan class-ibd-port-name={true}>{port.portName}</tspan>, ' : ',
                            <tspan class-ibd-port-type={true}><title>{`${port.typeName} – double-click to open the type`}</title>{port.typeName}</tspan>]
                        : label.text}
                </text>
                : undefined}
        </g>;
    }
}

/** A connector (connection or delegation) along its orthogonal route; dashed if it crosses threads. */
@injectable()
export class IbdConnectorView implements IView {
    render(edge: Readonly<IbdConnectorElement>, _context: RenderingContext): VNode | undefined {
        if (edge.points.length < 2) {
            return undefined;
        }
        const path = ibdRoutePath(edge.points);
        const middle = edge.points[Math.floor((edge.points.length - 1) / 2)];
        const next = edge.points[Math.floor((edge.points.length - 1) / 2) + 1] ?? middle;
        return <g class-ibd-connector={true} class-connection={edge.kind === 'connect'} class-delegation={edge.kind === 'delegate'}
            class-cross-thread={edge.crossThread} class-selected={edge.selected} class-mouseover={edge.hoverFeedback} class-on-route={edge.onRoute}
            class-has-error={edge.issue?.severity === 'error'} class-has-warning={edge.issue?.severity === 'warning'}>
            <title>{edge.title + (edge.crossThread ? '\n(crosses threads)' : '')}</title>
            <path class-ibd-connector-hit={true} d={path} />
            <path class-ibd-connector-line={true} d={path} />
            {edge.editable && edge.selected
                ? <g class-bend-handles={true}>
                    {...edge.waypoints.map(p => <circle class-bend-handle={true} cx={p.x} cy={p.y} r={4.5}>
                        <title>Drag to move the waypoint, double-click to remove it</title>
                    </circle>)}
                </g>
                : undefined}
            {issueMarker(edge.issue, (middle.x + next.x) / 2, (middle.y + next.y) / 2)}
        </g>;
    }
}

/** The invisible node covering the whole diagram (see `IbdTypes.canvas`). */
@injectable()
export class IbdCanvasView extends ShapeView {
    render(node: Readonly<IbdNodeElement>, _context: RenderingContext): VNode | undefined {
        return <g class-ibd-canvas={true}>
            <rect x={0} y={0} width={node.size.width} height={node.size.height} style={{ fill: 'none', pointerEvents: 'none' }} />
        </g>;
    }
}
