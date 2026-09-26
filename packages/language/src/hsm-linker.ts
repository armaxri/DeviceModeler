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
        return { ...error, message: ambiguityMessage(name, candidates.map(vertex => referenceName(vertex, refInfo.container))) };
    }
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
