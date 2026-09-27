/**
 * Support for manual (hand-arranged) layouts (experimental), shared by the web app and the VS Code
 * webview: storage of the layout per file in the local storage (web app), the undo history of layout changes and a model editor which records how
 * diagram operations change the ids of diagram elements (so the layout follows renames, moves and
 * deletions).
 */
import type { AstNode } from 'langium';
import {
    ModelEditor, isRegion, isState, isStateMachine, parseManualLayout, qualifiedName, removeLayoutElements, renameLayoutElement, serializeManualLayout,
    type DeletionTarget, type EditResult, type ManualLayout, type ScopeContainer, type StateMachine, type Transition, type Vertex
} from 'hsm-language';

const STORAGE_LAYOUT_PREFIX = 'hsm-modeler.layout:';

/** The layout stored for the file (undefined: none or storage not available). */
export function loadStoredLayout(fileName: string): ManualLayout | undefined {
    try {
        const text = localStorage.getItem(STORAGE_LAYOUT_PREFIX + fileName);
        return text ? parseManualLayout(text) : undefined;
    } catch {
        return undefined;
    }
}

export function storeLayout(fileName: string, layout: ManualLayout | undefined): void {
    try {
        if (layout) {
            localStorage.setItem(STORAGE_LAYOUT_PREFIX + fileName, serializeManualLayout(layout));
        } else {
            localStorage.removeItem(STORAGE_LAYOUT_PREFIX + fileName);
        }
    } catch {
        // storage is not available
    }
}

// ---------------------------------------------------------------------------------------------
// Undo history

export interface LayoutHistoryEntry {
    before: ManualLayout | undefined;
    after: ManualLayout | undefined;
    /**
     * Key of the text state when the change was made (see {@link textKey}; the web app uses the
     * `alternativeVersionId` of the Monaco model). Layout changes and text edits share one undo order:
     * a layout change is undone if the text is in the state it had then.
     */
    textKey: string;
    /** The change belongs to a text edit (renamed / moved / deleted elements) and is undone with it. */
    linked: boolean;
}

/**
 * Identifies a state of the text for the layout history (length and FNV-1a hash of the text). Used when
 * the text editor has no version id that returns to earlier values on undo (VS Code documents).
 */
export function textKey(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Undo / redo stacks of layout changes, interleaved with the undo stack of the text editor. */
export class LayoutHistory {

    private undoStack: LayoutHistoryEntry[] = [];
    private redoStack: LayoutHistoryEntry[] = [];

    push(entry: LayoutHistoryEntry): void {
        this.undoStack.push(entry);
        if (this.undoStack.length > 200) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }

    /** A text edit (not undo / redo) invalidates the redo stack, like in the text editor. */
    textEdited(): void {
        this.redoStack = [];
    }

    /** The layout change to undo instead of the text if the text has the given version. */
    layoutUndo(textKey: string): LayoutHistoryEntry | undefined {
        const top = this.undoStack[this.undoStack.length - 1];
        if (top && !top.linked && top.textKey === textKey) {
            this.redoStack.push(this.undoStack.pop()!);
            return top;
        }
        return undefined;
    }

    layoutRedo(textKey: string): LayoutHistoryEntry | undefined {
        const top = this.redoStack[this.redoStack.length - 1];
        if (top && !top.linked && top.textKey === textKey) {
            this.undoStack.push(this.redoStack.pop()!);
            return top;
        }
        return undefined;
    }

    /** The text was undone from the state `previousKey`: the layout change linked to that text edit is undone too. */
    textUndone(previousKey: string): LayoutHistoryEntry | undefined {
        const top = this.undoStack[this.undoStack.length - 1];
        if (top?.linked && top.textKey === previousKey) {
            this.redoStack.push(this.undoStack.pop()!);
            return top;
        }
        return undefined;
    }

    /** The text was redone to the state `key`: the linked layout change is redone too. */
    textRedone(key: string): LayoutHistoryEntry | undefined {
        const top = this.redoStack[this.redoStack.length - 1];
        if (top?.linked && top.textKey === key) {
            this.undoStack.push(this.redoStack.pop()!);
            return top;
        }
        return undefined;
    }
}

// ---------------------------------------------------------------------------------------------
// Tracking of id changes

export type LayoutKeyChange =
    | { kind: 'rename', from: string, to: string }
    | { kind: 'remove', ids: string[] };

/** Applies the recorded id changes to a layout. */
export function applyKeyChanges(layout: ManualLayout, changes: LayoutKeyChange[]): ManualLayout {
    let result = layout;
    for (const change of changes) {
        result = change.kind === 'rename' ? renameLayoutElement(result, change.from, change.to) : removeLayoutElements(result, change.ids);
    }
    return result;
}

/**
 * A model editor which records how the ids of diagram elements change: renamed and moved vertices get
 * new (qualified) ids, deleted elements disappear. `ids` maps the AST nodes to their diagram ids.
 */
export class TrackingModelEditor extends ModelEditor {

    readonly changes: LayoutKeyChange[] = [];

    constructor(text: string, machine: StateMachine, private readonly ids: Map<AstNode, string>) {
        super(text, machine);
    }

    override renameVertex(vertex: Vertex, newName: string): EditResult {
        const result = super.renameVertex(vertex, newName);
        const id = this.ids.get(vertex);
        if (id && result.edits.length > 0) {
            const dot = id.lastIndexOf('.');
            this.changes.push({ kind: 'rename', from: id, to: (dot >= 0 ? id.substring(0, dot + 1) : '') + newName });
        }
        return result;
    }

    override moveVertex(vertex: Vertex, target: ScopeContainer): EditResult {
        const result = super.moveVertex(vertex, target);
        const id = this.ids.get(vertex);
        if (id && result.edits.length > 0) {
            this.changes.push({ kind: 'rename', from: id, to: movedId(vertex, target) });
        }
        return result;
    }

    override deleteElements(targets: DeletionTarget[]): EditResult {
        const result = super.deleteElements(targets);
        const ids = targets.flatMap(target => {
            if ('initialOf' in target || 'finalOf' in target) {
                const container = 'initialOf' in target ? target.initialOf : target.finalOf;
                const id = this.ids.get(container);
                return id ? [`${id}#${'initialOf' in target ? 'initial' : 'final'}`] : [];
            }
            const id = this.ids.get(target);
            return id ? [id] : [];
        });
        if (ids.length > 0 && result.edits.length > 0) {
            this.changes.push({ kind: 'remove', ids });
        }
        return result;
    }

    override reconnectTransition(transition: Transition, end: 'source' | 'target', vertex: Vertex): EditResult {
        const result = super.reconnectTransition(transition, end, vertex);
        const id = this.ids.get(transition);
        if (id && result.edits.length > 0) {
            this.changes.push({ kind: 'remove', ids: [id] });
        }
        return result;
    }
}

/** The qualified name of a vertex after moving it into `target`. */
export function movedId(vertex: Vertex, target: ScopeContainer): string {
    const owner = isRegion(target) ? target.$container : target;
    return isStateMachine(owner) || !isState(owner) ? vertex.name : `${qualifiedName(owner)}.${vertex.name}`;
}
