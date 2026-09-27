import { AstUtils, DefaultLinker, type AstNodeDescription, type LinkingError, type ReferenceInfo } from 'langium';
import * as ast from './generated/ast.js';
import { referenceName, vertexCandidates } from './hsm-scope.js';

/**
 * Linker of the HSM language. Improves the error message of vertex references that cannot be
 * resolved because the name denotes several vertices (e.g. `X` for `A.X` and `B.X`).
 */
export class HsmLinker extends DefaultLinker {

    protected override createLinkingError(refInfo: ReferenceInfo, targetDescription?: AstNodeDescription): LinkingError {
        const error = super.createLinkingError(refInfo, targetDescription);
        if (targetDescription || !isVertexReference(refInfo)) {
            return error;
        }
        const machine = AstUtils.getContainerOfType(refInfo.container, ast.isStateMachine);
        const name = refInfo.reference.$refText;
        if (!machine || !name) {
            return error;
        }
        const candidates = vertexCandidates(machine, name);
        if (candidates.length < 2) {
            return error;
        }
        const names = candidates.map(vertex => referenceName(vertex, refInfo.container));
        const point = candidates[0];
        if (new Set(names).size === 1 && ast.isPseudoState(point) && (point.kind === 'entry' || point.kind === 'exit')) {
            // entry points / exit nodes with the same name in several regions of a state
            return { ...error, message: regionPointAmbiguityMessage(point.name, point.kind) };
        }
        return { ...error, message: ambiguityMessage(name, names) };
    }
}

/** Message for a reference to an entry point / exit node whose name is used in several regions of a state. */
export function regionPointAmbiguityMessage(name: string, kind: 'entry' | 'exit'): string {
    const what = kind === 'entry' ? 'entry point' : 'exit node';
    return `'${name}' is ambiguous: several regions have an ${what} with this name. Declare the transition inside the region of the ${what}.`;
}

function isVertexReference(refInfo: ReferenceInfo): boolean {
    return (ast.isTransition(refInfo.container) && (refInfo.property === 'source' || refInfo.property === 'target'))
        || (ast.isActiveExpression(refInfo.container) && refInfo.property === 'state');
}

/** `'X' is ambiguous, use a qualified name like 'A.X' or 'B.X'.` */
export function ambiguityMessage(name: string, qualifiedNames: string[]): string {
    const quoted = [...new Set(qualifiedNames)].map(n => `'${n}'`);
    const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}` : quoted.join('');
    return `'${name}' is ambiguous, use a qualified name like ${list}.`;
}
