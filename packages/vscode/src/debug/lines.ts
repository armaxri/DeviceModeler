import { AstUtils, GrammarUtils, type AstNode } from 'langium';
import { createDevmServices, isLocalReaction, isState, isTestStatement, isTransition } from 'devm-language';

/*
 * Lines on which breakpoints can be set: statements of tests (`.devmtest`) and states, transitions and
 * local reactions (`entry / ...`) of state machines (`.devm`). Used by the debug adapter to verify
 * breakpoints (parser only) and by the engine to match them (linked documents) – both with the same rules.
 */

/** Whether the node is a model element with breakpoints (state, transition, local reaction). */
export function isModelBreakpointElement(node: AstNode): boolean {
    return isState(node) || isTransition(node) || isLocalReaction(node);
}

/** 1-based line of a node for breakpoints: the line of the name of a state (not of its annotations), else the first line. */
export function breakpointLine(node: AstNode): number | undefined {
    const cst = node.$cstNode;
    if (!cst) {
        return undefined;
    }
    const name = isState(node) ? GrammarUtils.findNodeForProperty(cst, 'name') : undefined;
    return (name ?? cst).range.start.line + 1;
}

/** Sorted lines with breakpoint targets of a document root: statements (tests) or model elements. */
export function breakpointLines(root: AstNode | undefined): number[] {
    if (!root) {
        return [];
    }
    const lines = new Set<number>();
    for (const node of AstUtils.streamAst(root)) {
        if (isTestStatement(node) || isModelBreakpointElement(node)) {
            const line = breakpointLine(node);
            if (line !== undefined) {
                lines.add(line);
            }
        }
    }
    return [...lines].sort((a, b) => a - b);
}

let services: ReturnType<typeof createDevmServices> | undefined;

/** Breakpoint lines of a file text (parser only, works on incomplete texts). */
export function breakpointLinesOfText(text: string, kind: 'devm' | 'devmtest'): number[] {
    services ??= createDevmServices();
    const parser = kind === 'devmtest' ? services.DevmTest.parser.LangiumParser : services.Devm.parser.LangiumParser;
    return breakpointLines(parser.parse(text).value as AstNode | undefined);
}

/**
 * The verified line of a breakpoint: the requested line if it has a target, else the next line with a
 * target (at most `maxDistance` lines below); undefined if there is none.
 */
export function verifyBreakpointLine(lines: readonly number[], line: number, maxDistance = 10): number | undefined {
    const next = lines.find(candidate => candidate >= line);
    return next !== undefined && next - line <= maxDistance ? next : undefined;
}

/** `devm`, `devmtest` or undefined for other files. */
export function fileKind(pathOrUri: string): 'devm' | 'devmtest' | undefined {
    const lower = pathOrUri.toLowerCase();
    return lower.endsWith('.devmtest') ? 'devmtest' : lower.endsWith('.devm') ? 'devm' : undefined;
}
