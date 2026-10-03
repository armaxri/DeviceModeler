import { JSDocDocumentationProvider, type AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { qualifiedName } from '../statemachine-scope.js';
import { eventDirection, returnTypeOf, typeName, typeOfEvent, typeOfParameter, typeOfVariable } from '../typesystem.js';
import { nodeText } from '../model-utils.js';

/**
 * Documentation of model elements for hover (language server): a signature line (e.g.
 * `in event finished : integer`, `state Closed.Active`), the description of a state and the
 * documentation comment (`/** … *\/`) preceding the element.
 */
export class StateMachineDocumentationProvider extends JSDocDocumentationProvider {

    override getDocumentation(node: AstNode): string | undefined {
        const parts: string[] = [];
        const signature = elementSignature(node);
        if (signature) {
            parts.push('```devm\n' + signature + '\n```');
        }
        if (ast.isState(node) && node.description) {
            parts.push(node.description);
        }
        const comment = super.getDocumentation(node);
        if (comment) {
            parts.push(comment);
        }
        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }
}

/** A one-line signature of a declaration or vertex, e.g. `var track : integer = 1`. */
export function elementSignature(node: AstNode): string | undefined {
    if (ast.isEventDeclaration(node)) {
        const direction = eventDirection(node);
        const type = typeOfEvent(node);
        return `${direction === 'internal' ? '' : `${direction} `}event ${node.name}${type === 'void' ? '' : ` : ${typeName(type)}`}`;
    }
    if (ast.isVariableDeclaration(node)) {
        const keyword = node.const ? 'const' : node.readonly ? 'var readonly' : 'var';
        const initial = node.initialValue ? ` = ${nodeText(node.initialValue)}` : '';
        return `${keyword} ${node.name} : ${typeName(typeOfVariable(node))}${initial}`;
    }
    if (ast.isOperationDeclaration(node)) {
        const parameters = node.parameters.map(p => `${p.name}${p.varArgs ? '...' : ''} : ${typeName(typeOfParameter(p))}`);
        return `operation ${node.name}(${parameters.join(', ')}) : ${typeName(returnTypeOf(node))}`;
    }
    if (ast.isState(node)) {
        return `state ${qualifiedName(node)}`;
    }
    if (ast.isPseudoState(node)) {
        return `${node.kind} ${qualifiedName(node)}`;
    }
    if (ast.isStateMachine(node)) {
        return `statemachine ${node.name}`;
    }
    return undefined;
}
