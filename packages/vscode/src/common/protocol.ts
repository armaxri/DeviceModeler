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

/** Messages from the extension to the webview. */
export type ToWebview =
    /**
     * The document text (on open and after every change, debounced) and the texts of the `.hsm` files
     * it imports (transitively) by URI, so that the webview can resolve the imports.
     */
    | { type: 'text', text: string, version: number, fileName: string, uri: string, files?: Record<string, string> }
    | { type: 'settings', settings: WebviewSettings }
    /** The text cursor moved (select the element at the offset). */
    | { type: 'cursor', offset: number }
    /** Answer to an `edit` message: `ok` false if the document changed in between or the edit failed. */
    | { type: 'editResult', requestId: number, ok: boolean, text: string, version: number, message?: string }
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
    /** Runs a command of the extension (toolbar buttons). */
    | { type: 'command', command: 'exportSvg' | 'exportPlantUml' | 'generateCpp' }
    | { type: 'simulation', running: boolean }
    /** Opens a file and its diagram (double-click on a submachine state). */
    | { type: 'openFile', uri: string };
