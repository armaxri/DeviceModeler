/**
 * Annotations of the elements of a state machine.
 *
 * Annotations are members of the state machine, of states and of regions (written between their other
 * members). The layout annotations (see docs/manual-layout.md) describe a hand-arranged diagram:
 *
 * - element annotations, belonging to the state, pseudo state, region or transition that follows them in
 *   the text (only annotations may come in between):
 *   - `@at(x, y)`: position of a state, pseudo state or region (relative to the content area of its parent)
 *   - `@size(width, height)`: explicit size of a state or region
 *   - `@regions("vertical" | "horizontal")`: arrangement of the regions of a state
 *   - `@via(x1, y1, x2, y2, ...)`: waypoints of a transition (relative to the transition's frame)
 *   - `@label(dx, dy)`: offset of the label of a transition
 * - container annotations, belonging to the state machine, state or region in whose body they are written:
 *   - `@initial(x, y)`, `@final(x, y)`: position of the implicit initial / final pseudo state
 *   - `@definitions(x, y)`: position of the definition section (state machine only)
 *
 * All other annotations (`@CycleBased(100)`, ...) are annotations of the state machine.
 */
import * as ast from './generated/ast.js';

/** Layout annotations of states, pseudo states, regions and transitions (written before the element). */
export const ELEMENT_LAYOUT_ANNOTATIONS: readonly string[] = ['at', 'size', 'regions', 'via', 'label'];
/** Layout annotations of containers (state machine, states, regions; written in their body). */
export const CONTAINER_LAYOUT_ANNOTATIONS: readonly string[] = ['initial', 'final', 'definitions'];
/** All layout annotations. */
export const LAYOUT_ANNOTATIONS: readonly string[] = [...ELEMENT_LAYOUT_ANNOTATIONS, ...CONTAINER_LAYOUT_ANNOTATIONS];

/** Elements which can have element annotations. */
export type AnnotatedElement = ast.State | ast.PseudoState | ast.Region | ast.Transition;
/** Elements which contain annotations. */
export type AnnotationContainer = ast.StateMachine | ast.State | ast.Region;

export function isLayoutAnnotation(annotation: ast.Annotation): boolean {
    return LAYOUT_ANNOTATIONS.includes(annotation.name);
}

export function isElementAnnotation(annotation: ast.Annotation): boolean {
    return ELEMENT_LAYOUT_ANNOTATIONS.includes(annotation.name);
}

export function isAnnotatedElement(node: unknown): node is AnnotatedElement {
    return ast.isState(node) || ast.isPseudoState(node) || ast.isRegion(node) || ast.isTransition(node);
}

interface ContainerInfo {
    /** Element annotation -> the element it belongs to (undefined: no element follows). */
    owners: Map<ast.Annotation, AnnotatedElement | undefined>;
    /** Element -> its element annotations in text order. */
    elements: Map<AnnotatedElement, ast.Annotation[]>;
}

const cache = new WeakMap<AnnotationContainer, ContainerInfo>();

function info(container: AnnotationContainer): ContainerInfo {
    let result = cache.get(container);
    if (result) {
        return result;
    }
    result = { owners: new Map(), elements: new Map() };
    const members: Array<{ $cstNode?: { offset: number } }> = [
        ...container.annotations, ...container.vertices, ...container.transitions,
        ...(ast.isState(container) ? [...container.regions, ...container.reactions] : []),
        ...(ast.isStateMachine(container) ? [...container.scopes, ...container.reactions] : [])
    ];
    const sorted = members.filter(m => m.$cstNode).sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset);
    let pending: ast.Annotation[] = [];
    for (const member of sorted) {
        if (ast.isAnnotation(member)) {
            if (isElementAnnotation(member)) {
                pending.push(member);
            }
            continue;
        }
        const element = isAnnotatedElement(member) ? member : undefined;
        pending.forEach(annotation => result!.owners.set(annotation, element));
        if (element) {
            result.elements.set(element, pending);
        }
        pending = [];
    }
    pending.forEach(annotation => result!.owners.set(annotation, undefined));
    cache.set(container, result);
    return result;
}

/** The element annotations of an element (the element annotations written directly before it), in text order. */
export function elementAnnotations(element: AnnotatedElement): ast.Annotation[] {
    const container = element.$container;
    return container ? info(container).elements.get(element) ?? [] : [];
}

/** The annotations of a container which are not element annotations (container annotations, `@CycleBased`, ...). */
export function containerAnnotations(container: AnnotationContainer): ast.Annotation[] {
    return container.annotations.filter(a => !isElementAnnotation(a));
}

/**
 * The element or container an annotation belongs to; undefined for an element annotation which is not
 * followed by a state, pseudo state, region or transition.
 */
export function annotationOwner(annotation: ast.Annotation): AnnotatedElement | AnnotationContainer | undefined {
    const container = annotation.$container;
    if (!ast.isStateMachine(container) && !ast.isState(container) && !ast.isRegion(container)) {
        return undefined;
    }
    return isElementAnnotation(annotation) ? info(container).owners.get(annotation) : container;
}

/** The annotations of the state machine which are not layout annotations (`@CycleBased`, ...). */
export function semanticAnnotations(machine: ast.StateMachine): ast.Annotation[] {
    return machine.annotations.filter(a => !isLayoutAnnotation(a));
}

/** Offset at which the text of an element begins including its element annotations (to delete or move it with them). */
export function elementStart(element: AnnotatedElement): number | undefined {
    const offsets = [element.$cstNode?.offset, ...elementAnnotations(element).map(a => a.$cstNode?.offset)]
        .filter((o): o is number => o !== undefined);
    return offsets.length > 0 ? Math.min(...offsets) : undefined;
}
