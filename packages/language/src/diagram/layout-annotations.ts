/**
 * Manual diagram layouts stored as layout annotations in the model text (see model-annotations.ts for
 * the syntax): reading them into a {@link ManualLayout} and computing the text edits which make the
 * annotations of a model equal to a given layout.
 *
 * The coordinates are the ones of the `.devm.layout` files: positions relative to the content area of the
 * parent node, waypoints relative to the frame of the transition (the innermost node containing both end
 * points), label positions as offsets from the computed position. They are written as integers (rounded).
 */
import * as ast from '../generated/ast.js';
import type { TextEdit } from '../edit/model-edits.js';
import {
    CONTAINER_LAYOUT_ANNOTATIONS, ELEMENT_LAYOUT_ANNOTATIONS, containerAnnotations, elementAnnotations, isAnnotatedElement, isElementAnnotation, isLayoutAnnotation,
    type AnnotatedElement, type AnnotationContainer
} from '../model-annotations.js';
import { diagramElementIds } from './diagram-ids.js';
import { DEFINITION_ID } from './layout.js';
import { createManualLayout, type EdgeLayout, type ManualLayout, type NodeLayout } from './manual-layout.js';
import {
    annotationSlotEdits, insertAnnotations, type LayoutArgument, type AnnotationSlot, type WantedAnnotation, type WrittenAnnotation
} from './layout-core/annotation-edits.js';

/** A layout annotation value: numbers, or the orientation of `@regions`. */
type Value = number[] | string;

/** The numbers of a layout annotation (number literals, optionally negated); undefined if an argument is not a number. */
export function annotationNumbers(annotation: ast.Annotation): number[] | undefined {
    const result: number[] = [];
    for (const argument of annotation.arguments) {
        const value = numberValue(argument);
        if (value === undefined) {
            return undefined;
        }
        result.push(value);
    }
    return result;
}

function numberValue(expression: ast.Expression): number | undefined {
    if (ast.isIntLiteral(expression)) {
        return Number(expression.value);
    }
    if (ast.isRealLiteral(expression)) {
        return Number(expression.value);
    }
    if (ast.isUnaryExpression(expression) && (expression.operator === '-' || expression.operator === '+')) {
        const value = numberValue(expression.operand);
        return value === undefined ? undefined : expression.operator === '-' ? -value : value;
    }
    return undefined;
}

function stringValue(annotation: ast.Annotation): string | undefined {
    const argument = annotation.arguments[0];
    return annotation.arguments.length === 1 && ast.isStringLiteral(argument) ? argument.value : undefined;
}

/** A state machine, state, pseudo state, region or transition. */
type LayoutNode = ast.StateMachine | AnnotatedElement;

function isContainer(node: LayoutNode): node is AnnotationContainer {
    return ast.isStateMachine(node) || ast.isState(node) || ast.isRegion(node);
}

/** The layout annotations of a node (as element and as container) by name (the first one of each name). */
function layoutAnnotationsOf(element: LayoutNode): Map<string, ast.Annotation> {
    const result = new Map<string, ast.Annotation>();
    const annotations = [...(isAnnotatedElement(element) ? elementAnnotations(element) : []), ...(isContainer(element) ? containerAnnotations(element) : [])];
    for (const annotation of annotations) {
        if (isLayoutAnnotation(annotation) && !result.has(annotation.name)) {
            result.set(annotation.name, annotation);
        }
    }
    return result;
}

/** The elements which can carry layout annotations, in text order. */
function annotatedElements(machine: ast.StateMachine): LayoutNode[] {
    const result: LayoutNode[] = [machine];
    const visit = (container: ast.StateMachine | ast.State | ast.Region) => {
        for (const vertex of container.vertices) {
            result.push(vertex);
            if (ast.isState(vertex)) {
                vertex.regions.forEach(region => {
                    result.push(region);
                    visit(region);
                });
                visit(vertex);
            }
        }
        result.push(...container.transitions);
    };
    visit(machine);
    return result;
}

// ---------------------------------------------------------------------------------------------
// Reading

/**
 * The manual layout described by the layout annotations of the model, undefined if the model has no
 * layout annotation (the diagram is laid out automatically). Annotations of elements which have no
 * diagram element (e.g. an `@initial` on a state without initial transition) and invalid annotations are
 * ignored. `@size` / `@regions` of a state without `@at` are ignored (the state is placed automatically).
 */
export function layoutFromModel(machine: ast.StateMachine): ManualLayout | undefined {
    const { ids, initial, final, definitions } = diagramElementIds(machine);
    const layout = createManualLayout('manual');
    let found = false;
    for (const element of annotatedElements(machine)) {
        const annotations = layoutAnnotationsOf(element);
        if (annotations.size === 0) {
            continue;
        }
        found = true;
        const numbers = (name: string, count?: number) => {
            const annotation = annotations.get(name);
            const values = annotation ? annotationNumbers(annotation) : undefined;
            return values && (count === undefined || values.length === count) ? values : undefined;
        };
        const at = numbers('at', 2);
        const size = numbers('size', 2);
        const id = ids.get(element);
        if (ast.isTransition(element)) {
            if (!id) {
                continue;
            }
            const entry: EdgeLayout = {};
            const via = numbers('via');
            if (via && via.length >= 2 && via.length % 2 === 0) {
                entry.bends = [];
                for (let i = 0; i < via.length; i += 2) {
                    entry.bends.push({ x: via[i], y: via[i + 1] });
                }
            }
            const label = numbers('label', 2);
            if (label) {
                entry.label = { x: label[0], y: label[1] };
            }
            if (entry.bends || entry.label) {
                layout.edges[id] = entry;
            }
            continue;
        }
        if ((ast.isState(element) || ast.isPseudoState(element)) && id && at) {
            const entry: NodeLayout = { x: at[0], y: at[1] };
            if (ast.isState(element)) {
                addSize(entry, size);
                const regions = annotations.get('regions');
                const orientation = regions ? stringValue(regions) : undefined;
                if (orientation === 'vertical' || orientation === 'horizontal') {
                    entry.regions = orientation;
                }
            }
            layout.nodes[id] = entry;
        }
        if (ast.isRegion(element) && id && (at || size)) {
            const entry: NodeLayout = { x: at?.[0] ?? 0, y: at?.[1] ?? 0 };
            addSize(entry, size);
            layout.nodes[id] = entry;
        }
        if (ast.isStateMachine(element) || ast.isState(element) || ast.isRegion(element)) {
            const point = (name: string, nodeId: string | undefined) => {
                const values = numbers(name, 2);
                if (values && nodeId) {
                    layout.nodes[nodeId] = { x: values[0], y: values[1] };
                }
            };
            point('initial', initial.get(element));
            point('final', final.get(element));
            if (ast.isStateMachine(element) && definitions) {
                const values = numbers('definitions');
                if (values && (values.length === 2 || values.length === 4)) {
                    const entry: NodeLayout = { x: values[0], y: values[1] };
                    addSize(entry, values.length === 4 ? values.slice(2) : undefined);
                    layout.nodes[DEFINITION_ID] = entry;
                }
            }
        }
    }
    return found ? layout : undefined;
}

function addSize(entry: NodeLayout, size: number[] | undefined): void {
    if (size?.[0] !== undefined && size[0] > 0) {
        entry.width = size[0];
    }
    if (size?.[1] !== undefined && size[1] > 0) {
        entry.height = size[1];
    }
}

/** Whether the model has at least one layout annotation (the diagram is arranged by hand). */
export function hasLayoutAnnotations(machine: ast.StateMachine): boolean {
    return annotatedElements(machine).some(e => isContainer(e) && e.annotations.some(isLayoutAnnotation));
}

// ---------------------------------------------------------------------------------------------
// Writing

/** The layout annotations an element should have according to the layout (name -> value, in output order). */
function desiredAnnotations(element: LayoutNode, layout: ManualLayout | undefined, ids: ReturnType<typeof diagramElementIds>): Map<string, Value> {
    const result = new Map<string, Value>();
    if (!layout) {
        return result;
    }
    const id = ids.ids.get(element);
    const size = (node: NodeLayout) => {
        if (node.width !== undefined || node.height !== undefined) {
            result.set('size', [node.width ?? 0, node.height ?? 0]);
        }
    };
    if (ast.isTransition(element)) {
        const edge = id ? layout.edges[id] : undefined;
        if (edge?.bends?.length) {
            result.set('via', edge.bends.flatMap(p => [p.x, p.y]));
        }
        if (edge?.label) {
            result.set('label', [edge.label.x, edge.label.y]);
        }
        return result;
    }
    const node = id ? layout.nodes[id] : undefined;
    if (node && (ast.isState(element) || ast.isPseudoState(element) || ast.isRegion(element))) {
        result.set('at', [node.x, node.y]);
        if (!ast.isPseudoState(element)) {
            size(node);
        }
        if (ast.isState(element) && node.regions) {
            result.set('regions', node.regions);
        }
    }
    if (ast.isStateMachine(element) || ast.isState(element) || ast.isRegion(element)) {
        const point = (name: string, nodeId: string | undefined) => {
            const entry = nodeId ? layout.nodes[nodeId] : undefined;
            if (entry) {
                result.set(name, [entry.x, entry.y]);
            }
        };
        point('initial', ids.initial.get(element));
        point('final', ids.final.get(element));
        if (ast.isStateMachine(element) && ids.definitions) {
            const entry = layout.nodes[DEFINITION_ID];
            if (entry) {
                result.set('definitions', entry.width !== undefined || entry.height !== undefined
                    ? [entry.x, entry.y, entry.width ?? 0, entry.height ?? 0]
                    : [entry.x, entry.y]);
            }
        }
    }
    return result;
}

/** The arguments of an annotation as read by the annotation writer (numbers and strings), undefined if one cannot be read. */
function writtenArguments(annotation: ast.Annotation): LayoutArgument[] | undefined {
    const result: LayoutArgument[] = [];
    for (const argument of annotation.arguments) {
        const value = ast.isStringLiteral(argument) ? argument.value : numberValue(argument);
        if (value === undefined) {
            return undefined;
        }
        result.push(value);
    }
    return result;
}

function written(annotation: ast.Annotation): WrittenAnnotation {
    const cst = annotation.$cstNode!;
    return { name: annotation.name, layout: isLayoutAnnotation(annotation), args: writtenArguments(annotation), offset: cst.offset, end: cst.end };
}

/**
 * The text edits which make the layout annotations of the model equal to the layout: changed values are
 * replaced in place, new annotations are appended to the annotations of the element (or written on a new
 * line before the element, with its indentation), annotations which are not in the layout are removed
 * (with their line if nothing else remains on it). `layout` undefined removes all layout annotations
 * (automatic layout). Other annotations (`@CycleBased`, ...) are not changed. Entries of the layout
 * without a model element are ignored. Applying the edits and reading the layout again
 * ({@link layoutFromModel}) yields the layout with rounded numbers; computing the edits again then
 * yields no edits. (The edits are computed by the shared {@link annotationSlotEdits}.)
 */
export function layoutTextEdits(machine: ast.StateMachine, text: string, layout: ManualLayout | undefined): TextEdit[] {
    const ids = diagramElementIds(machine);
    const slots: AnnotationSlot[] = [];
    for (const element of annotatedElements(machine)) {
        const desired = desiredAnnotations(element, layout, ids);
        const wanted = (names: readonly string[]): WantedAnnotation[] => [...desired]
            .filter(([name]) => names.includes(name))
            .map(([name, value]) => ({ name, args: typeof value === 'string' ? [value] : value }));
        // element annotations before the element, container annotations in its body
        if (isAnnotatedElement(element)) {
            slots.push({
                written: elementAnnotations(element).filter(a => a.$cstNode).map(written),
                wanted: wanted(ELEMENT_LAYOUT_ANNOTATIONS),
                insert: added => insertBefore(element, text, added)
            });
        }
        if (isContainer(element)) {
            slots.push({
                written: containerAnnotations(element).filter(a => a.$cstNode).map(written),
                wanted: wanted(CONTAINER_LAYOUT_ANNOTATIONS),
                insert: added => insertIntoBody(element, text, added)
            });
        }
    }
    return annotationSlotEdits(text, slots);
}

/** Inserts annotations before an element without annotations: on a new line if the element starts a line. */
function insertBefore(element: AnnotatedElement, text: string, annotations: string): TextEdit {
    return insertAnnotations(element.$cstNode!.offset, text, annotations);
}

/**
 * Inserts container annotations at the beginning of the body (before its first member; in the state
 * machine after the definition section, before the first element).
 */
function insertIntoBody(container: AnnotationContainer, text: string, annotations: string): TextEdit {
    const members: Array<{ $cstNode?: { offset: number } }> = [
        ...container.vertices, ...container.transitions, ...container.annotations.filter(isElementAnnotation),
        ...(ast.isState(container) ? [...container.regions, ...container.reactions] : []),
        ...(ast.isStateMachine(container) ? container.reactions : container.annotations)
    ];
    const first = members.filter(m => m.$cstNode).sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset)[0];
    if (first) {
        return insertAnnotations(first.$cstNode!.offset, text, annotations);
    }
    // empty body: before the closing brace
    const close = text.lastIndexOf('}', container.$cstNode!.end - 1);
    const lineStart = text.lastIndexOf('\n', close - 1) + 1;
    const indent = text.substring(lineStart, close);
    return indent.trim() === ''
        ? { offset: lineStart, length: 0, text: `${indent}    ${annotations}\n` }
        : { offset: close, length: 0, text: ` ${annotations} ` };
}
