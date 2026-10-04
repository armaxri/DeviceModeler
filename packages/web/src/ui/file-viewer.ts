import { monaco } from '../monaco.js';
import { h } from './dom.js';

/**
 * A read-only Monaco editor showing another file of the workspace, e.g. the C/C++ header a go to definition
 * leads to: in the web app (no host to open it) as an overlay over the app, in the header viewer windows of
 * the desktop app as the whole page (`index.html?host=http&view=<path>`).
 */
export interface FileViewer {
    /** Selects a range (1-based) and reveals it. */
    reveal(range: monaco.IRange | undefined): void;
    close(): void;
}

export interface FileViewerOptions {
    /** Shown in the title bar (the path of the file). */
    title: string;
    model: monaco.editor.ITextModel;
    range?: monaco.IRange;
    theme: string;
    /** The whole page (no close button) instead of an overlay. */
    fullPage?: boolean;
}

let current: { viewer: FileViewer, model: monaco.editor.ITextModel } | undefined;

export function showFileViewer(options: FileViewerOptions): FileViewer {
    if (current?.model === options.model) {
        current.viewer.reveal(options.range);
        return current.viewer;
    }
    current?.viewer.close();
    const close = h('button', { class: 'file-viewer-close', title: 'Close (Esc)' }, '✕');
    const container = h('div', { class: 'file-viewer-editor' });
    const dialog = h('div', { class: 'file-viewer', role: 'dialog', 'aria-label': options.title },
        h('div', { class: 'file-viewer-header' },
            h('span', { class: 'file-viewer-title' }, options.title),
            h('span', { class: 'file-viewer-hint' }, 'read-only'),
            options.fullPage ? undefined : close),
        container);
    const root = h('div', { class: options.fullPage ? 'file-viewer-page' : 'file-viewer-backdrop' }, dialog);
    document.body.append(root);
    const editor = monaco.editor.create(container, {
        model: options.model,
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        theme: options.theme
    });
    const decorations = editor.createDecorationsCollection();
    const viewer: FileViewer = {
        reveal(range) {
            if (!range) {
                return;
            }
            editor.setSelection(range);
            editor.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate);
            decorations.set([{ range, options: { className: 'hsm-selected-range', isWholeLine: range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn } }]);
            editor.focus();
        },
        close() {
            document.removeEventListener('keydown', onKey);
            editor.dispose();
            root.remove();
            if (current?.viewer === viewer) {
                current = undefined;
            }
        }
    };
    // (bubbling phase: an Escape the editor used itself, e.g. to close its find widget, does not arrive or is handled)
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !options.fullPage && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            viewer.close();
        }
    };
    document.addEventListener('keydown', onKey);
    if (!options.fullPage) {
        // Escape in the editor closes the viewer unless the editor uses it (find widget, peek, a selection)
        editor.createContextKey('hsmFileViewer', true);
        editor.addCommand(monaco.KeyCode.Escape, () => viewer.close(),
            'hsmFileViewer && !findWidgetVisible && !suggestWidgetVisible && !parameterHintsVisible && !markersNavigationVisible && !referenceSearchVisible');
    }
    close.addEventListener('click', () => viewer.close());
    root.addEventListener('mousedown', event => {
        if (event.target === root && !options.fullPage) {
            viewer.close();
        }
    });
    current = { viewer, model: options.model };
    viewer.reveal(options.range);
    return viewer;
}
