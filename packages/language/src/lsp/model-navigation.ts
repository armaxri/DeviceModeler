import { AstUtils, CstUtils, GrammarUtils, type LangiumDocument } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import type { LocationLink, Position, Range } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import { machineType, resolvedImports } from '../imports.js';
import { cppElementAt, type CppLocation } from './cpp-lsp.js';
import { cppLocations, cppTypeLocationsOf, referenceBaseRange, type CppNavigationKind } from './cpp-navigation.js';

/**
 * Go to definition / declaration / type definition and the links of import paths of a model as plain
 * data, for editors without a language server (the Monaco editor of the web app, embedded in Eclipse,
 * CLion and the desktop app). The same rules as the language server of the VS Code extension
 * (`packages/vscode/src/server/hsm-lsp.ts`): C++ names, struct members and header imports lead into the
 * headers (each segment of `app::Mode::Fast` to its own declaration), the name of an imported state
 * machine used as a type and the path of a model import to the imported state machine, everything else
 * to the declaration in the models (Langium's definition provider).
 */

/** A target of a navigation: a {@link CppLocation} (also for targets in models). */
export type NavigationLink = CppLocation;

/** The definitions within the models (Langium's definition provider); the language server passes its base class. */
export type ModelDefinitions = (document: LangiumDocument, params: { textDocument: { uri: string }, position: Position }) =>
    Promise<LocationLink[] | undefined> | LocationLink[] | undefined;

/** LSP location links of navigation targets. */
export function toLocationLinks(links: readonly NavigationLink[]): LocationLink[] {
    return links.map(l => ({ targetUri: l.uri, targetRange: l.range, targetSelectionRange: l.selection, originSelectionRange: l.origin }));
}

/** The link of an import path (`import "motor.h"`, `import "motor.hsm"`) whose file was found. */
export interface ImportLink {
    /** Range of the import path (with the quotes). */
    readonly range: Range;
    /** URI of the imported file. */
    readonly target: string;
    readonly kind: 'header' | 'model';
}

function position(document: LangiumDocument, offset: number) {
    return { textDocument: { uri: document.uri.toString() }, position: document.textDocument.positionAt(offset) };
}

/** The imported state machine at an offset: the name of a state machine used as a type, or the path of its import. */
function machineAt(document: LangiumDocument, offset: number): { machine: ast.StateMachine, origin: Range } | undefined {
    const root = document.parseResult.value.$cstNode;
    const leaf = root ? CstUtils.findLeafNodeAtOffset(root, offset) : undefined;
    const node = leaf?.astNode;
    let machine: ast.StateMachine | undefined;
    if (ast.isTypeReference(node)) {
        machine = machineType(node);
    } else if (ast.isImportPath(node)) {
        const owner = AstUtils.getContainerOfType(node, ast.isStateMachine);
        machine = owner ? resolvedImports(owner).find(i => i.node === node)?.machine : undefined;
    }
    return leaf && machine ? { machine, origin: leaf.range } : undefined;
}

/** The location of a state machine (its name selected). */
function machineLink(machine: ast.StateMachine, origin: Range): NavigationLink | undefined {
    const cst = machine.$cstNode;
    const uri = machine.$document?.uri.toString();
    if (!cst || !uri) {
        return undefined;
    }
    const name = GrammarUtils.findNodeForProperty(cst, 'name') ?? cst;
    return { uri, range: cst.range, selection: name.range, origin };
}

/**
 * Go to definition at an offset (empty: nothing to navigate to); `modelDefinitions`: the definitions within the
 * models (default: the definition provider of the services).
 */
export async function definitionLinks(services: LangiumServices, document: LangiumDocument, offset: number,
    modelDefinitions: ModelDefinitions = (d, p) => services.lsp.DefinitionProvider?.getDefinition(d, p)): Promise<NavigationLink[]> {
    const cpp = cppLocations(document, offset, 'definition');
    if (cpp.length > 0) {
        return cpp;
    }
    const imported = machineAt(document, offset);
    if (imported) {
        const link = machineLink(imported.machine, imported.origin);
        return link ? [link] : [];
    }
    const links = await modelDefinitions(document, position(document, offset)) ?? [];
    // in a reference followed by struct members (`cfg.reading.speed`) only the name of the variable leads to it
    const root = document.parseResult.value.$cstNode;
    const node = root ? CstUtils.findLeafNodeAtOffset(root, offset)?.astNode : undefined;
    const base = ast.isElementReference(node) ? referenceBaseRange(node) : undefined;
    return links.map(link => ({
        uri: link.targetUri,
        range: link.targetRange,
        selection: link.targetSelectionRange,
        origin: base ?? link.originSelectionRange ?? link.targetSelectionRange
    }));
}

/**
 * Go to declaration: all declarations of a C++ name (the definition first), otherwise the definition
 * (`definition`: default {@link definitionLinks}).
 */
export async function declarationLinks(services: LangiumServices, document: LangiumDocument, offset: number,
    definition: () => Promise<NavigationLink[]> = () => definitionLinks(services, document, offset)): Promise<NavigationLink[]> {
    const cpp = cppLocations(document, offset, 'declaration');
    return cpp.length > 0 ? cpp : definition();
}

/**
 * Go to type definition: the enum or struct of a C++ constant, enumerator or struct member, the C++ type of
 * a variable, event, parameter, operation or type alias, the imported state machine of a submachine instance.
 */
export function typeDefinitionLinks(services: LangiumServices, document: LangiumDocument, offset: number): NavigationLink[] {
    if (cppElementAt(document, offset)) {
        return cppLocations(document, offset, 'typeDefinition');
    }
    const root = document.parseResult.value.$cstNode;
    const leaf = root ? CstUtils.findDeclarationNodeAtOffset(root, offset, services.parser.GrammarConfig.nameRegexp) : undefined;
    const target = leaf ? services.references.References.findDeclarations(leaf)[0] : undefined;
    if (!leaf || !target) {
        return [];
    }
    const base = ast.isElementReference(leaf.astNode) ? referenceBaseRange(leaf.astNode) : undefined;
    const origin = base ?? leaf.range;
    const cpp = cppTypeLocationsOf(target, origin);
    if (cpp.length > 0) {
        return cpp;
    }
    const machine = ast.isVariableDeclaration(target) ? machineType(target.type) : undefined;
    const link = machine ? machineLink(machine, origin) : undefined;
    return link ? [link] : [];
}

/** The navigation of a kind at an offset. */
export function navigationLinks(services: LangiumServices, document: LangiumDocument, offset: number, kind: CppNavigationKind): Promise<NavigationLink[]> {
    switch (kind) {
        case 'definition': return definitionLinks(services, document, offset);
        case 'declaration': return declarationLinks(services, document, offset);
        default: return Promise.resolve(typeDefinitionLinks(services, document, offset));
    }
}

/** The links of the import paths whose files were found (the document must be linked). */
export function importLinks(document: LangiumDocument): ImportLink[] {
    const links: ImportLink[] = [];
    for (const node of AstUtils.streamAst(document.parseResult.value)) {
        if (!ast.isStateMachine(node)) {
            continue;
        }
        for (const resolved of resolvedImports(node)) {
            const found = resolved.kind === 'header' ? resolved.header?.found : resolved.machine !== undefined;
            const cst = resolved.node.$cstNode;
            if (found && resolved.uri && cst) {
                links.push({ range: cst.range, target: resolved.uri.toString(), kind: resolved.kind === 'header' ? 'header' : 'model' });
            }
        }
    }
    return links;
}
