/**
 * Manual layouts of structure diagrams stored as layout annotations in the `.dmf` text (the same
 * concept and syntax as the layout annotations of state machines, see docs/manual-layout.md):
 *
 * - `@at(x, y)`: position of the frame (before `system` / `subsystem`), a thread, an instance, a
 *   component block (before `component`, in the overview of the component types) or a type box (before
 *   `struct` / `interface`), relative to its parent node (the frame, a thread; the canvas)
 * - `@size(width, height)`: explicit (minimum) size of the same nodes, only if the user resized them
 * - `@via(x1, y1, x2, y2, …)`: waypoints of a connection / delegation, relative to its frame (the innermost
 *   node containing the nodes of both ports, so the waypoints move with a thread)
 * - `@port(name, side, offset)`: side (`left`, `right`, `top`, `bottom`) and offset of the center of the
 *   port along the side (from the top / left corner) – on an instance for the ports of its type, on the
 *   subsystem / system for its boundary ports; the offset is optional.
 *
 * Only the annotations of the elements shown in the diagram are read and written (another subsystem of
 * the same file has its own diagram); the structs and interfaces of the file are shown in every diagram
 * of the file and have one position for all of them.
 */
import { AstUtils, type AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import type { TextEdit } from '../edit/model-edits.js';
import type { IbdLayoutResult, IbdNode, IbdPortSide } from './ibd-model.js';
import { createIbdLayout, type IbdManualLayout } from './ibd-manual-layout.js';
import {
    annotationDeletionEdits, annotationSlotEdits, insertAnnotations, type AnnotationSlot, type LayoutArgument, type WantedAnnotation, type WrittenAnnotation
} from './layout-core/annotation-edits.js';

/** The layout annotations of structure files. */
export const IBD_LAYOUT_ANNOTATIONS: readonly string[] = ['at', 'size', 'via', 'port'];

/** The elements with a node in a structure diagram (they can have `@at` and `@size`). */
export const IBD_NODE_ELEMENTS: readonly string[] = ['Structure', 'Thread', 'ComponentInstance', 'Component', 'StructDeclaration', 'PortInterface'];
/** The elements with a connector (`@via`). */
export const IBD_EDGE_ELEMENTS: readonly string[] = ['Connection', 'Delegation'];
/** The elements whose ports are placed by `@port` (instances: the ports of their type; subsystems / systems: their boundary ports). */
export const IBD_PORT_OWNERS: readonly string[] = ['ComponentInstance', 'Structure'];

/** Side names of `@port` and the sides of the diagram model. */
export const PORT_SIDE_NAMES: Readonly<Record<string, IbdPortSide>> = { left: 'WEST', right: 'EAST', top: 'NORTH', bottom: 'SOUTH' };
const SIDE_NAME: Record<IbdPortSide, string> = { WEST: 'left', EAST: 'right', NORTH: 'top', SOUTH: 'bottom' };

export function isIbdLayoutAnnotation(annotation: ast.DmfAnnotation): boolean {
    return IBD_LAYOUT_ANNOTATIONS.includes(annotation.name);
}

type Annotated = AstNode & { annotations: ast.DmfAnnotation[] };

function isAnnotated(node: AstNode | undefined): node is Annotated {
    return !!node && Array.isArray((node as Partial<Annotated>).annotations);
}

/** The value of an annotation argument: a number (also with a sign or hex), a string or a name. */
function argumentValue(argument: ast.AnnotationArgument): LayoutArgument | undefined {
    if (argument.number !== undefined) {
        if (argument.unit) {
            return undefined;
        }
        const negative = argument.number.startsWith('-');
        const digits = negative ? argument.number.slice(1) : argument.number;
        const value = /^0[xX]/.test(digits) ? parseInt(digits, 16) : Number(digits);
        return Number.isFinite(value) ? (negative ? -value : value) : undefined;
    }
    if (argument.text !== undefined) {
        return argument.text;
    }
    return argument.name !== undefined ? { name: argument.name } : undefined;
}

/** The arguments of an annotation, undefined if one cannot be read. */
export function dmfAnnotationArguments(annotation: ast.DmfAnnotation): LayoutArgument[] | undefined {
    const result: LayoutArgument[] = [];
    for (const argument of annotation.arguments) {
        const value = argumentValue(argument);
        if (value === undefined) {
            return undefined;
        }
        result.push(value);
    }
    return result;
}

/** The numbers of an annotation (all arguments must be numbers without unit). */
function numbers(annotation: ast.DmfAnnotation | undefined, count?: number): number[] | undefined {
    const values = annotation ? dmfAnnotationArguments(annotation) : undefined;
    if (!values || values.some(v => typeof v !== 'number') || (count !== undefined && values.length !== count)) {
        return undefined;
    }
    return values as number[];
}

/** `@port(name, side[, offset])`: the port name, the side and the offset (undefined if invalid). */
export function portAnnotation(annotation: ast.DmfAnnotation): { port: string, side: IbdPortSide, offset?: number } | undefined {
    const values = dmfAnnotationArguments(annotation);
    if (!values || values.length < 2 || values.length > 3) {
        return undefined;
    }
    const [port, side, offset] = values;
    const sideName = typeof side === 'object' ? side.name : typeof side === 'string' ? side : undefined;
    const portName = typeof port === 'object' ? port.name : typeof port === 'string' ? port : undefined;
    if (!portName || !sideName || !PORT_SIDE_NAMES[sideName] || (offset !== undefined && typeof offset !== 'number')) {
        return undefined;
    }
    return { port: portName, side: PORT_SIDE_NAMES[sideName], ...(offset !== undefined ? { offset } : {}) };
}

/** The key of a layout annotation in its slot (`@port` once per port). */
function annotationKey(annotation: ast.DmfAnnotation): string {
    if (annotation.name === 'port') {
        const first = annotation.arguments[0];
        return `port:${first?.name ?? first?.text ?? ''}`;
    }
    return annotation.name;
}

/** The elements of the diagram which can have layout annotations, with their diagram ids, in text order. */
function diagramElements(model: ast.DmfModel, result: IbdLayoutResult): Array<{ id: string, element: Annotated }> {
    const seen = new Set<AstNode>();
    const elements: Array<{ id: string, element: Annotated }> = [];
    for (const [id, element] of result.elements) {
        if (seen.has(element) || ast.isPort(element) || !isAnnotated(element)) {
            continue;
        }
        if (!IBD_NODE_ELEMENTS.includes(element.$type) && !IBD_EDGE_ELEMENTS.includes(element.$type)) {
            continue;
        }
        // only elements of the file (the diagram may show imported elements)
        if (element.$cstNode === undefined || AstUtils.findRootNode(element) !== model) {
            continue;
        }
        seen.add(element);
        elements.push({ id, element });
    }
    return elements.sort((a, b) => a.element.$cstNode!.offset - b.element.$cstNode!.offset);
}

/** Node id -> port name -> port id, of all nodes of the diagram. */
function portIds(result: IbdLayoutResult): Map<string, Map<string, string>> {
    const map = new Map<string, Map<string, string>>();
    const visit = (node: IbdNode) => {
        map.set(node.id, new Map(node.ports.map(p => [p.name, p.id])));
        node.children.forEach(visit);
    };
    result.graph.children.forEach(visit);
    return map;
}

/**
 * The manual layout described by the layout annotations of the elements shown in a structure diagram,
 * undefined if none of them has a layout annotation (the diagram is laid out automatically). Invalid
 * annotations and annotations of ports which do not exist are ignored.
 */
export function ibdLayoutFromModel(model: ast.DmfModel, result: IbdLayoutResult): IbdManualLayout | undefined {
    const layout = createIbdLayout();
    const ports = portIds(result);
    let found = false;
    for (const { id, element } of diagramElements(model, result)) {
        const annotations = element.annotations.filter(isIbdLayoutAnnotation);
        if (annotations.length === 0) {
            continue;
        }
        found = true;
        const first = (name: string) => annotations.find(a => a.name === name);
        if (IBD_EDGE_ELEMENTS.includes(element.$type)) {
            const via = numbers(first('via'));
            if (via && via.length >= 2 && via.length % 2 === 0) {
                layout.edges[id] = { bends: [] };
                for (let i = 0; i < via.length; i += 2) {
                    layout.edges[id].bends!.push({ x: via[i], y: via[i + 1] });
                }
            }
            continue;
        }
        const at = numbers(first('at'), 2);
        const size = numbers(first('size'), 2);
        // (a size without position is ignored: the node is placed automatically)
        if (at) {
            layout.nodes[id] = {
                x: at[0], y: at[1],
                ...(size && size[0] > 0 ? { width: size[0] } : {}),
                ...(size && size[1] > 0 ? { height: size[1] } : {})
            };
        }
        if (IBD_PORT_OWNERS.includes(element.$type)) {
            for (const annotation of annotations.filter(a => a.name === 'port')) {
                const port = portAnnotation(annotation);
                const portId = port ? ports.get(id)?.get(port.port) : undefined;
                if (port && portId && !layout.ports[portId]) {
                    layout.ports[portId] = { side: port.side, ...(port.offset !== undefined ? { offset: port.offset } : {}) };
                }
            }
        }
    }
    return found ? layout : undefined;
}

/** Whether an element of the diagram has a layout annotation (the diagram is arranged by hand). */
export function hasIbdLayoutAnnotations(model: ast.DmfModel, result: IbdLayoutResult): boolean {
    return diagramElements(model, result).some(({ element }) => element.annotations.some(isIbdLayoutAnnotation));
}

/** The layout annotations an element should have according to the layout. */
function wantedAnnotations(id: string, element: Annotated, layout: IbdManualLayout | undefined, ports: Map<string, Map<string, string>>): WantedAnnotation[] {
    if (!layout) {
        return [];
    }
    const result: WantedAnnotation[] = [];
    if (IBD_EDGE_ELEMENTS.includes(element.$type)) {
        const bends = layout.edges[id]?.bends;
        if (bends?.length) {
            result.push({ name: 'via', args: bends.flatMap(p => [p.x, p.y]) });
        }
        return result;
    }
    const node = layout.nodes[id];
    if (node) {
        result.push({ name: 'at', args: [node.x, node.y] });
        if (node.width !== undefined || node.height !== undefined) {
            result.push({ name: 'size', args: [node.width ?? 0, node.height ?? 0] });
        }
    }
    if (IBD_PORT_OWNERS.includes(element.$type)) {
        for (const [name, portId] of ports.get(id) ?? []) {
            const port = layout.ports[portId];
            if (port) {
                result.push({
                    name: 'port', key: `port:${name}`,
                    args: [{ name }, { name: SIDE_NAME[port.side] }, ...(port.offset !== undefined ? [port.offset] : [])]
                });
            }
        }
    }
    return result;
}

/** Offset of the element after its annotations (where new annotations are inserted). */
function elementStart(element: Annotated, text: string): number {
    const cst = element.$cstNode!;
    const last = element.annotations.map(a => a.$cstNode?.end).filter((e): e is number => e !== undefined).pop();
    if (last === undefined) {
        return cst.offset;
    }
    let offset = last;
    while (offset < cst.end && /\s/.test(text[offset])) {
        offset++;
    }
    return offset;
}

/** Threads, subsystems / systems and type declarations have their annotations on the line before them (formatter). */
function annotationsOnOwnLine(element: Annotated): boolean {
    return ast.isThread(element) || ast.isStructure(element) || ast.isComponent(element) || ast.isStructDeclaration(element) || ast.isPortInterface(element);
}

/**
 * The text edits which make the layout annotations of the elements shown in a structure diagram equal
 * to the layout (minimal edits, see {@link annotationSlotEdits}); `layout` undefined removes all of them
 * (automatic layout). Other annotations (`@priority`, …) and the annotations of elements of other
 * diagrams are not changed. New annotations of threads, subsystems / systems, components and types are
 * written on the line before them, those of instances, connections and delegations in front of them on
 * the same line (as the formatter writes them).
 */
export function ibdLayoutTextEdits(model: ast.DmfModel, result: IbdLayoutResult, text: string, layout: IbdManualLayout | undefined): TextEdit[] {
    const ports = portIds(result);
    const slots: AnnotationSlot[] = diagramElements(model, result).map(({ id, element }) => ({
        written: element.annotations.filter(a => a.$cstNode).map((a): WrittenAnnotation => ({
            name: a.name, key: annotationKey(a), layout: isIbdLayoutAnnotation(a), args: dmfAnnotationArguments(a),
            offset: a.$cstNode!.offset, end: a.$cstNode!.end
        })),
        wanted: wantedAnnotations(id, element, layout, ports),
        insert: added => insertAnnotations(elementStart(element, text), text, added, annotationsOnOwnLine(element))
    }));
    return annotationSlotEdits(text, slots);
}

/** The text of a structure file without any layout annotation (the input of the automatic layout). */
export function withoutIbdLayoutAnnotations(model: ast.DmfModel, text: string): string {
    const deletions = AstUtils.streamAst(model).filter(ast.isDmfAnnotation).filter(isIbdLayoutAnnotation)
        .map(a => a.$cstNode).filter(c => c !== undefined).map(c => ({ offset: c!.offset, end: c!.end })).toArray();
    const edits = annotationDeletionEdits(text, deletions).sort((a, b) => b.offset - a.offset);
    let result = text;
    for (const edit of edits) {
        result = result.substring(0, edit.offset) + edit.text + result.substring(edit.offset + edit.length);
    }
    return result;
}
