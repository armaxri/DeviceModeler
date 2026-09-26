import type { AstNode } from 'langium';

/**
 * Error raised by the interpreter when the model cannot be executed, e.g. a choice without enabled
 * branch, a composite state without initial transition, a division by zero or an unknown event.
 *
 * The message names the model element and its line; the element itself is available as {@link node}.
 */
export class SimulationError extends Error {

    /** The model element that caused the error, if known. */
    readonly node?: AstNode;

    constructor(message: string, node?: AstNode) {
        super(node ? `${message} (${describeLocation(node)})` : message);
        this.name = 'SimulationError';
        this.node = node;
    }
}

/** `line 12: 'Closed -> Open : eject'` – location and (shortened) source text of a node. */
export function describeLocation(node: AstNode): string {
    const cst = node.$cstNode;
    if (!cst) {
        return node.$type;
    }
    let text = cst.text.replace(/\s+/g, ' ').trim();
    if (text.length > 60) {
        text = text.substring(0, 57) + '...';
    }
    return `line ${cst.range.start.line + 1}: '${text}'`;
}
