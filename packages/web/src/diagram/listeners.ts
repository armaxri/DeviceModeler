import { inject, injectable } from 'inversify';
import {
    MouseListener, SelectMouseListener, TYPES, isSelectable,
    type IActionHandler, type SModelElementImpl, type SModelRootImpl, type ViewerOptions
} from 'sprotty';
import { BringToFrontAction, SelectAction, SelectAllAction, type Action } from 'sprotty-protocol';
import { isVertexNode, type VertexNode } from './model.js';

/** Callbacks from the diagram into the application. */
export interface DiagramCallbacks {
    /** A mouse button was pressed on a diagram element (or the canvas, i.e. the root). */
    mouseDown(target: SModelElementImpl, event: MouseEvent): void;
    doubleClick(target: SModelElementImpl, event: MouseEvent): void;
    /** A vertex was dragged and dropped onto the given container element (undefined: no valid drop target). */
    dragEnd(draggedId: string, dropTargetId: string | undefined): void;
    selectionChanged(selected: string[], deselected: string[]): void;
    allSelected(select: boolean): void;
}

export const DiagramCallbacks = Symbol('DiagramCallbacks');

/** Vertices which can be dragged into other states. */
function movableVertex(target: SModelElementImpl): VertexNode | undefined {
    let current: SModelElementImpl | undefined = target;
    while (current && !isVertexNode(current)) {
        current = 'parent' in current ? (current as { parent?: SModelElementImpl }).parent : undefined;
    }
    if (current && isVertexNode(current) && !['region', 'initial', 'final'].includes(current.kind)) {
        return current;
    }
    return undefined;
}

@injectable()
export class HsmMouseListener extends MouseListener {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;
    @inject(TYPES.ViewerOptions) protected viewerOptions!: ViewerOptions;

    private drag?: { id: string, x: number, y: number, moved: boolean };

    override mouseDown(target: SModelElementImpl, event: MouseEvent): Action[] {
        this.callbacks.mouseDown(target, event);
        const vertex = movableVertex(target);
        this.drag = event.button === 0 && vertex ? { id: vertex.id, x: event.clientX, y: event.clientY, moved: false } : undefined;
        return [];
    }

    override mouseMove(_target: SModelElementImpl, event: MouseEvent): Action[] {
        if (this.drag && (event.buttons & 1) && Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) > 4) {
            this.drag.moved = true;
        }
        return [];
    }

    override mouseUp(target: SModelElementImpl, event: MouseEvent): Action[] {
        const drag = this.drag;
        this.drag = undefined;
        if (drag?.moved) {
            this.callbacks.dragEnd(drag.id, this.findDropTarget(event, drag.id, target.root));
        }
        return [];
    }

    override doubleClick(target: SModelElementImpl, event: MouseEvent): Action[] {
        this.callbacks.doubleClick(target, event);
        return [];
    }

    /** Finds the innermost state, region or the canvas below the mouse, ignoring the dragged element. */
    protected findDropTarget(event: MouseEvent, draggedId: string, root: SModelRootImpl): string | undefined {
        const prefix = this.viewerOptions.baseDiv + '_';
        const dragged = root.index.getById(draggedId);
        for (const domElement of document.elementsFromPoint(event.clientX, event.clientY)) {
            let current: Element | null = domElement;
            while (current && !(current.id && current.id.startsWith(prefix))) {
                current = current.parentElement;
            }
            if (!current) {
                continue;
            }
            const id = current.id.substring(prefix.length);
            const element = root.index.getById(id);
            if (!element || isWithin(element, dragged)) {
                continue;
            }
            if (element === root) {
                return root.id;
            }
            if (isVertexNode(element) && (element.kind === 'state' || element.kind === 'region')) {
                return element.id;
            }
        }
        return undefined;
    }
}

function isWithin(element: SModelElementImpl, ancestor: SModelElementImpl | undefined): boolean {
    let current: SModelElementImpl | undefined = element;
    while (current) {
        if (current === ancestor) {
            return true;
        }
        current = 'parent' in current ? (current as { parent?: SModelElementImpl }).parent : undefined;
    }
    return false;
}

/** Selection without re-ordering the selected element (transitions have to stay on top). */
@injectable()
export class HsmSelectMouseListener extends SelectMouseListener {
    protected override handleSelectTarget(selectableTarget: SModelElementImpl & { selected: boolean }, deselectedElements: SModelElementImpl[], event: MouseEvent): (Action | Promise<Action>)[] {
        return super.handleSelectTarget(selectableTarget as never, deselectedElements, event)
            .filter(action => !('kind' in action) || action.kind !== BringToFrontAction.KIND);
    }
}

/** Informs the application about selection changes. */
@injectable()
export class SelectionTracker implements IActionHandler {

    @inject(DiagramCallbacks) protected callbacks!: DiagramCallbacks;

    handle(action: Action): void {
        if (action.kind === SelectAction.KIND) {
            const select = action as SelectAction;
            this.callbacks.selectionChanged(select.selectedElementsIDs, select.deselectedElementsIDs);
        } else if (action.kind === SelectAllAction.KIND) {
            this.callbacks.allSelected((action as SelectAllAction).select);
        }
    }
}

export { isSelectable };
