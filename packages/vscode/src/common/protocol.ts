import type { CppHeaderSettings, StructureContext } from 'hsm-language';

/**
 * Messages between the extension and the diagram webview. The webview holds a copy of the document
 * text, parses and lays it out and computes the text edits of diagram operations; the extension owns
 * the document and applies the edits with a `WorkspaceEdit` (so undo, dirty state and saving work as
 * for any other edit).
 */

export type DiagramTheme = 'classic' | 'modern' | 'dark';

export interface WebviewSettings {
    direction: 'DOWN' | 'RIGHT';
    routing: 'SPLINES' | 'ORTHOGONAL' | 'POLYLINE';
    priorities: boolean;
    /** The effective theme (`auto` is resolved by the extension). */
    theme: DiagramTheme;
    showProperties: boolean;
}

/** A text edit in offsets of the text known to the webview. */
export interface OffsetEdit {
    offset: number;
    length: number;
    text: string;
}

export interface TextRange {
    offset: number;
    end: number;
}

export type StatusSeverity = 'info' | 'warning' | 'error';

/**
 * A place to navigate to from the diagram (the `DiagramLocation` of the web app's diagram controller): a
 * file, in a structure file the shown element, the selected diagram element and the instance tree
 * context, in a state machine an offset of its text.
 */
export interface NavigationLocation {
    uri: string;
    element?: string;
    id?: string;
    context?: StructureContext;
    offset?: number;
}

/** The state of the navigation history (shared by all diagrams): labels of the next Back / Forward targets. */
export interface NavigationState {
    back?: string;
    forward?: string;
}

/**
 * Commands of the manual layout (experimental): `arrange` writes the automatic layout as layout
 * annotations into the model, `reset` removes all layout annotations.
 */
export type LayoutCommand = 'arrange' | 'reset';

/** Messages from the extension to the webview. */
export type ToWebview =
    /**
     * The document text (on open and after every change, debounced) and, by URI, the texts of all `.hsm`
     * and `.dmf` files of the workspace and of the files the document imports (transitively, also C/C++
     * headers), so that the webview can resolve the imports and answer queries across files (the
     * structures using a state machine, routes, renames). Sent again when one of these files changes.
     */
    | { type: 'text', text: string, version: number, fileName: string, uri: string, files?: Record<string, string>, headers?: CppHeaderSettings }
    /** Runs a command of the manual layout (commands of the extension). */
    | { type: 'layoutCommand', command: LayoutCommand }
    /** Converts the SVG of the diagram into a PNG image (answered with a `png` message). */
    | { type: 'rasterize', requestId: number, svg: string, scale: number }
    | { type: 'settings', settings: WebviewSettings }
    /** The text cursor moved (select the element at the offset). */
    | { type: 'cursor', offset: number }
    /** Answer to an `edit` message: `ok` false if the document changed in between or the edit failed. */
    | { type: 'editResult', requestId: number, ok: boolean, text: string, version: number, message?: string }
    /** Shows and selects a location of this document (navigation, Back / Forward). */
    | { type: 'reveal', location: NavigationLocation }
    /** Answer to an `openLocation` message: `ok` false if the file could not be opened. */
    | { type: 'locationResult', requestId: number, ok: boolean }
    /** The navigation history changed (the Back / Forward buttons). */
    | { type: 'history', state: NavigationState }
    /** Go back / forward in the navigation history (commands): answered with a `navigate` message. */
    | { type: 'navigateRequest', direction: 'back' | 'forward' }
    | { type: 'fit' };

/** Messages from the webview to the extension. */
export type FromWebview =
    | { type: 'ready' }
    /** Applies text edits computed from a diagram operation, based on the text of document version `version`. */
    | { type: 'edit', requestId: number, version: number, edits: OffsetEdit[] }
    /** Highlights (and reveals) the text of the element selected in the diagram; no range: remove the highlight. */
    | { type: 'highlight', range?: TextRange }
    /** Selects a text range in the text editor (simulation: "show in model"). */
    | { type: 'selectText', range: TextRange }
    /** Moves the cursor of the text editor to the offset and focuses it. */
    | { type: 'editAt', offset: number }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'status', message: string, severity: StatusSeverity }
    /** A setting was changed in the toolbar of the webview. */
    | { type: 'updateSetting', key: 'direction' | 'routing' | 'priorities' | 'showProperties', value: string | boolean }
    /** Runs a command of the extension (toolbar buttons); `element`: the structure shown in the diagram (export). */
    | { type: 'command', command: 'exportDiagram' | 'generateCpp', element?: string }
    /** The PNG image of a `rasterize` request (base64), or the error. */
    | { type: 'png', requestId: number, data?: string, error?: string }
    | { type: 'simulation', running: boolean }
    /** Opens a file and its diagram (double-click on a submachine state). */
    | { type: 'openFile', uri: string }
    /**
     * Navigation to a location (another file and its diagram, or an element of this one): recorded in the
     * history with `from` (the current location of the diagram), answered with `locationResult`.
     */
    | { type: 'openLocation', requestId: number, location: NavigationLocation, from: NavigationLocation }
    /** Back / Forward in the navigation history; `from` is the current location of the diagram. */
    | { type: 'navigate', direction: 'back' | 'forward', from: NavigationLocation }
    /**
     * Applies edits of several files (by URI, offsets relative to the texts sent to the webview, which are
     * identified by `hashes`, see text-hash.ts) as one workspace edit; the edits of this document are based
     * on version `version`. Answered with `editResult`.
     */
    | { type: 'workspaceEdit', requestId: number, version: number, edits: Record<string, OffsetEdit[]>, hashes: Record<string, number> };
