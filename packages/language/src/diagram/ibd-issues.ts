import type { AstNode, LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import type { IbdLayoutResult } from './ibd-model.js';

/** The problems shown at a diagram element: a marker (error or warning) with the messages as its tooltip. */
export interface IbdIssue {
    severity: 'error' | 'warning';
    messages: string[];
}

function rootDocument(node: AstNode): LangiumDocument | undefined {
    let root = node;
    while (root.$container) {
        root = root.$container;
    }
    return root.$document;
}

/**
 * The innermost element of the diagram whose text (in `document`, the edited file) contains the offset:
 * an instance, a thread, a connector (connection or delegation), a boundary port of the frame, a port
 * of a component block, a type box or – with `includeFrame` – the frame itself. Ports of instances are
 * not elements of the edited file (their text is in the component type): the instance contains them.
 */
export function ibdDiagramElementAt(layout: IbdLayoutResult, document: LangiumDocument, offset: number, includeFrame: boolean): string | undefined {
    let best: { id: string, length: number } | undefined;
    for (const [id, node] of layout.elements) {
        if (layout.instances.has(id) || rootDocument(node) !== document || (!includeFrame && id === layout.graph.id)) {
            continue;
        }
        const cst = node.$cstNode;
        if (!cst || offset < cst.offset || offset > cst.end) {
            continue;
        }
        const length = cst.end - cst.offset;
        if (!best || length < best.length) {
            best = { id, length };
        }
    }
    return best?.id;
}

/**
 * The markers of the diagram: the errors and warnings of the edited file assigned to the innermost
 * diagram element containing their start (see {@link ibdDiagramElementAt}; problems outside of all
 * elements – e.g. of another component type of the file – are not shown in the diagram).
 */
export function ibdIssues(layout: IbdLayoutResult, document: LangiumDocument, diagnostics: readonly Diagnostic[]): Map<string, IbdIssue> {
    const issues = new Map<string, IbdIssue>();
    for (const diagnostic of diagnostics) {
        if (diagnostic.severity !== 1 && diagnostic.severity !== 2) {
            continue;
        }
        const id = ibdDiagramElementAt(layout, document, document.textDocument.offsetAt(diagnostic.range.start), true);
        if (!id) {
            continue;
        }
        const severity = diagnostic.severity === 1 ? 'error' : 'warning';
        const issue = issues.get(id) ?? { severity, messages: [] };
        if (severity === 'error') {
            issue.severity = 'error';
        }
        issue.messages.push(typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value);
        issues.set(id, issue);
    }
    return issues;
}
