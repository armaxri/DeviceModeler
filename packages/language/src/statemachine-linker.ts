import {
    AstUtils, Cancellation, DefaultDocumentBuilder, DefaultLinker,
    type AstNodeDescription, type LangiumCoreServices, type LangiumDocument, type LinkingError, type ReferenceInfo, type ScopeProvider
} from 'langium';
import type { LangiumSharedServices } from 'langium/lsp';
import * as ast from './generated/ast.js';
import type { DevmServices } from './devm-module.js';
import { referenceName, vertexCandidates } from './statemachine-scope.js';
import { resolvedImports } from './imports.js';
import { setReferenceMembers } from './cpp-types.js';

/**
 * Linker of state machine files. Improves the error message of vertex references that cannot be
 * resolved because the name denotes several vertices (e.g. `X` for `A.X` and `B.X`).
 */
export class StateMachineLinker extends DefaultLinker {

    constructor(protected readonly services: DevmServices) {
        super(services);
    }

    /** Resolves the imports of the state machine (see imports.ts) before its references are linked. */
    override async link(document: LangiumDocument, cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        const root = document.parseResult.value;
        if (ast.isStateMachine(root)) {
            this.services.references.ImportResolver.update(root);
        }
        await super.link(document, cancelToken);
    }

    override getCandidate(refInfo: ReferenceInfo): AstNodeDescription | LinkingError {
        return memberAwareCandidate(refInfo, this.scopeProvider, () => super.getCandidate(refInfo));
    }

    protected override createLinkingError(refInfo: ReferenceInfo, targetDescription?: AstNodeDescription): LinkingError {
        const error = super.createLinkingError(refInfo, targetDescription);
        if (!targetDescription && ast.isElementReference(refInfo.container) && refInfo.property === 'element') {
            const hint = cppNameHint(refInfo.reference.$refText);
            return hint ? { ...error, message: `${error.message} ${hint}` } : error;
        }
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

/**
 * Linking of element references whose name continues with members of a C++ struct value (`pos.x`,
 * `cfg.home.y`): if the whole name does not denote a declaration, the longest prefix that names a
 * variable (or constant) is the referenced declaration and the rest are the members (recorded with
 * `setReferenceMembers`, read with `referenceMembers`). Whether the members exist is checked by the
 * type system / validator.
 */
export function memberAwareCandidate(refInfo: ReferenceInfo, scopeProvider: ScopeProvider, standard: () => AstNodeDescription | LinkingError): AstNodeDescription | LinkingError {
    const candidate = standard();
    const container = refInfo.container;
    if (!ast.isElementReference(container) || refInfo.property !== 'element') {
        return candidate;
    }
    if (!isLinkingError(candidate)) {
        setReferenceMembers(container, undefined);
        return candidate;
    }
    const segments = refInfo.reference.$refText.replace(/\s+/g, '').split('.');
    if (segments.length > 1 && !container.call) {
        const scope = scopeProvider.getScope(refInfo);
        for (let length = segments.length - 1; length >= 1; length--) {
            const description = scope.getElement(segments.slice(0, length).join('.'));
            if (description && description.type === 'VariableDeclaration') {
                setReferenceMembers(container, segments.slice(length));
                return description;
            }
        }
    }
    setReferenceMembers(container, undefined);
    return candidate;
}

function isLinkingError(value: AstNodeDescription | LinkingError): value is LinkingError {
    return 'info' in value && 'message' in value && !('path' in value);
}

/** A hint for an unresolved name that is written like a C++ name of the global namespace (`HAL_OK` -> `::HAL_OK`). */
function cppNameHint(name: string): string | undefined {
    return /^[A-Za-z_]\w*$/.test(name) && /^(k[A-Z]|[A-Z][A-Z0-9_]+$)/.test(name)
        ? `(A constant of the global namespace of an imported C++ header is written '::${name}'.)`
        : undefined;
}

/** Linker of the test language: members of C++ struct values in element references (`pos.x`). */
export class DevmTestLinker extends DefaultLinker {

    constructor(services: LangiumCoreServices) {
        super(services);
    }

    override getCandidate(refInfo: ReferenceInfo): AstNodeDescription | LinkingError {
        return memberAwareCandidate(refInfo, this.scopeProvider, () => super.getCandidate(refInfo));
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

/**
 * Document builder of the Device Modeler languages: a document is also relinked if a file it imports
 * changed (or if it has an import that could not be resolved, a new file may resolve it). Structure
 * files are also relinked if the state machine of a component (`behavior "door.devm"`) changed.
 */
export class DevmDocumentBuilder extends DefaultDocumentBuilder {

    constructor(services: LangiumSharedServices) {
        super(services);
    }

    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        if (super.shouldRelink(document, changedUris)) {
            return true;
        }
        const root = document.parseResult.value;
        if (ast.isStructureModel(root)) {
            const services = this.serviceRegistry.getServices(document.uri) as Partial<DevmServices>;
            return services.references?.StructureImportResolver?.dependenciesChanged(root, changedUris) ?? false;
        }
        if (!ast.isStateMachine(root)) {
            return false;
        }
        return resolvedImports(root).some(i => i.kind === 'model' && (!i.machine || (i.uri !== undefined && changedUris.has(i.uri.toString()))))
            || this.headersChanged(root);
    }

    /** Whether a header imported by the machine changed (or a missing one may exist now). */
    protected headersChanged(machine: ast.StateMachine): boolean {
        const services = this.serviceRegistry.getServices(machine.$document!.uri) as Partial<DevmServices>;
        return services.references?.ImportResolver?.headersChanged(machine) ?? false;
    }
}
