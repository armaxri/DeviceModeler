import { AstUtils, URI, UriUtils, type AstNode, type LangiumCoreServices, type LangiumDocuments, type Reference } from 'langium';
import * as ast from './generated/ast.js';

/**
 * Imports of other files (`import "motor.hsm"`) and submachine instances.
 *
 * Resolution: an import path is resolved relative to the URI of the importing document
 * ({@link resolveImportUri}); the imported document must be loaded into the Langium workspace
 * (`LangiumDocuments`): the language server loads all files of the workspace, {@link HsmModelLoader}
 * loads imported files transitively (from the file system or from given texts). The
 * {@link HsmImportResolver} (service `references.ImportResolver`) resolves the imports of a state
 * machine before its document is linked and stores the result in a registry, so that the type
 * system and the interpreter can use the pure functions of this module ({@link resolvedImports},
 * {@link importedMachines}, {@link machineType}, {@link instanceMachine} ...).
 *
 * Kinds of imports ({@link importKind}): `.hsm` files (state machines, their names are types),
 * C/C++ headers (`.h`, `.hpp`, ...; accepted but not resolved yet – see {@link HsmImportResolver.resolveHeader},
 * the extension point for the C++ header integration) and everything else (unsupported, an error).
 */

/** `hsm`: a state machine file; `header`: a C/C++ header; `unsupported`: any other file. */
export type ImportKind = 'hsm' | 'header' | 'unsupported';

/** File extensions of C/C++ headers accepted by `import`. */
export const HEADER_EXTENSIONS: readonly string[] = ['.h', '.hh', '.hpp', '.hxx', '.h++', '.inl'];

/** The result of resolving one import path. */
export interface ResolvedImport {
    /** The path in the text (`import "motor.hsm"`). */
    readonly node: ast.ImportPath;
    readonly path: string;
    readonly kind: ImportKind;
    /** URI of the imported file (resolved relative to the importing document). */
    readonly uri?: URI;
    /** `hsm`: the imported state machine, `undefined` if the file is not loaded. */
    readonly machine?: ast.StateMachine;
    /**
     * `header`: the result of the header integration (not implemented yet; a future header resolver
     * stores the parsed declarations here).
     */
    readonly header?: unknown;
}

/** The kind of an import path, by its file extension. */
export function importKind(path: string): ImportKind {
    const lower = path.toLowerCase();
    if (lower.endsWith('.hsm')) {
        return 'hsm';
    }
    return HEADER_EXTENSIONS.some(extension => lower.endsWith(extension)) ? 'header' : 'unsupported';
}

/** Resolves an import path relative to the URI of the importing document (absolute paths are kept). */
export function resolveImportUri(base: URI, path: string): URI {
    const normalized = path.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
        return base.scheme === 'file' ? URI.file(normalized) : base.with({ path: normalized.startsWith('/') ? normalized : `/${normalized}` });
    }
    return UriUtils.resolvePath(UriUtils.dirname(base), normalized);
}

/** All import paths of a state machine in text order. */
export function importPaths(machine: ast.StateMachine): ast.ImportPath[] {
    return machine.imports.flatMap(i => i.paths);
}

// ---------------------------------------------------------------------------------------------
// Registry of resolved imports (filled by the HsmImportResolver before a document is linked)

const registry = new WeakMap<ast.StateMachine, readonly ResolvedImport[]>();
const machinesCache = new WeakMap<readonly ResolvedImport[], Map<string, ast.StateMachine>>();

/** Stores the resolved imports of a state machine (called by the {@link HsmImportResolver}). */
export function registerImports(machine: ast.StateMachine, imports: readonly ResolvedImport[]): void {
    registry.set(machine, imports);
}

/** The resolved imports of a state machine (empty if it has none or they were not resolved yet). */
export function resolvedImports(machine: ast.StateMachine): readonly ResolvedImport[] {
    return registry.get(machine) ?? [];
}

/**
 * The imported state machines by name (the first import of a name wins; duplicates and imports of
 * the importing machine itself are reported by the validator and ignored here).
 */
export function importedMachines(machine: ast.StateMachine): Map<string, ast.StateMachine> {
    const imports = resolvedImports(machine);
    let machines = machinesCache.get(imports);
    if (!machines) {
        machines = new Map();
        for (const resolved of imports) {
            const imported = resolved.machine;
            if (imported?.name && imported !== machine && imported.name !== machine.name && !machines.has(imported.name)) {
                machines.set(imported.name, imported);
            }
        }
        machinesCache.set(imports, machines);
    }
    return machines;
}

/** The imported state machine denoted by a type reference (`var motor : Motor`), if any. */
export function machineType(reference: ast.TypeReference | undefined): ast.StateMachine | undefined {
    if (!reference?.name) {
        return undefined;
    }
    const machine = AstUtils.getContainerOfType(reference, ast.isStateMachine);
    return machine ? importedMachines(machine).get(reference.name) : undefined;
}

/** The state machine of a submachine instance (a variable whose type is an imported state machine). */
export function instanceMachine(variable: ast.VariableDeclaration | undefined): ast.StateMachine | undefined {
    return variable ? machineType(variable.type) : undefined;
}

/** Whether the declaration is a submachine instance. */
export function isInstance(declaration: AstNode | undefined): boolean {
    return ast.isVariableDeclaration(declaration) && instanceMachine(declaration) !== undefined;
}

/** The submachine instances declared by a state machine, in declaration order. */
export function instanceVariables(machine: ast.StateMachine): ast.VariableDeclaration[] {
    return machine.scopes.flatMap(s => s.declarations).filter((d): d is ast.VariableDeclaration => isInstance(d));
}

/** Referable name of a declaration: `x` or `Iface.x` for declarations of named interfaces. */
export function referableName(declaration: ast.Declaration): string {
    const scope = declaration.$container;
    return ast.isInterfaceScope(scope) && scope.name ? `${scope.name}.${declaration.name}` : declaration.name;
}

/**
 * The declarations of an instance that are visible to the parent: the declarations of the
 * interfaces of its state machine (not the internal scope, not type aliases, not nested instances),
 * by their referable names inside the instance's machine (`start`, `Iface.x`).
 */
export function instanceMembers(machine: ast.StateMachine): Array<{ name: string, declaration: ast.Declaration }> {
    const result: Array<{ name: string, declaration: ast.Declaration }> = [];
    for (const scope of machine.scopes) {
        if (!ast.isInterfaceScope(scope)) {
            continue;
        }
        for (const declaration of scope.declarations) {
            if (declaration.name && !ast.isTypeAliasDeclaration(declaration) && !isInstance(declaration)) {
                result.push({ name: referableName(declaration), declaration });
            }
        }
    }
    return result;
}

/** The submachine instance bound to a state (`state Moving : motor`) and its state machine. */
export function submachineOf(state: ast.State): { instance: ast.VariableDeclaration, machine: ast.StateMachine } | undefined {
    const instance = state.submachine?.ref;
    const machine = instanceMachine(instance);
    return instance && machine ? { instance, machine } : undefined;
}

/** A node that references a declaration or state of a submachine instance by a path like `motor.start`. */
export type MemberReferenceNode = ast.ElementReference | ast.EventTrigger | ast.RaiseStatement | ast.ValueOfExpression | ast.ActiveExpression;

function referenceOf(node: MemberReferenceNode): Reference<AstNode> {
    switch (node.$type) {
        case 'ElementReference':
            return node.element;
        case 'ActiveExpression':
            return node.state;
        default:
            return node.event;
    }
}

/**
 * The submachine instance through which `node` references a member of another state machine
 * (`motor` for `raise motor.start`, `active(motor.On)`, `motor.speed`), `undefined` for references
 * to own declarations and states. `machine` is the state machine whose instances are considered
 * (default: the machine containing `node`).
 */
export function referencedInstance(node: MemberReferenceNode, machine?: ast.StateMachine): ast.VariableDeclaration | undefined {
    const context = machine ?? AstUtils.getContainerOfType(node, ast.isStateMachine);
    return context ? instanceOfReference(referenceOf(node), context) : undefined;
}

/**
 * The submachine instance of `machine` through which a reference (`motor.start`) denotes a member of
 * the instance's state machine, `undefined` for references to members of `machine` itself.
 */
export function instanceOfReference(reference: Reference<AstNode>, machine: ast.StateMachine): ast.VariableDeclaration | undefined {
    const target = reference.ref;
    const context = machine;
    if (!target || AstUtils.findRootNode(target) === context) {
        return undefined;
    }
    const text = reference.$refText.replace(/\s+/g, '');
    let result: ast.VariableDeclaration | undefined;
    for (const instance of instanceVariables(context)) {
        const name = referableName(instance);
        if (text.startsWith(`${name}.`) && (!result || name.length > referableName(result).length)) {
            result = instance;
        }
    }
    return result;
}

/** Whether an `.hsm` import of the machine could not be resolved (the file is missing). */
export function hasUnresolvedImports(machine: ast.StateMachine): boolean {
    return resolvedImports(machine).some(i => i.kind === 'hsm' && !i.machine);
}

/**
 * Whether a variable is probably an instance of a state machine whose import could not be resolved:
 * its type is not known and the machine has an unresolved import. Errors that follow from this
 * (unresolved members `motor.start`, ...) are not reported, the unresolved import is.
 */
export function isUnresolvedInstance(variable: ast.VariableDeclaration | undefined, isKnownType: (reference: ast.TypeReference) => boolean): boolean {
    const machine = variable && AstUtils.getContainerOfType(variable, ast.isStateMachine);
    return !!variable?.type && !!machine && !isKnownType(variable.type) && hasUnresolvedImports(machine);
}

// ---------------------------------------------------------------------------------------------
// Resolution

/**
 * Resolves the imports of state machines against the documents of the Langium workspace.
 *
 * Extension point for C/C++ headers: override {@link resolveHeader} (e.g. parse the header with the
 * header parser and store the declarations in `ResolvedImport.header`), the rest of the language
 * only relies on `kind` and `machine`.
 */
export class HsmImportResolver {

    protected readonly documents: LangiumDocuments;

    constructor(services: LangiumCoreServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    /** Resolves the imports of the state machine of a document and stores them in the registry. */
    update(machine: ast.StateMachine): readonly ResolvedImport[] {
        const imports = this.resolve(machine);
        registerImports(machine, imports);
        return imports;
    }

    /** Resolves all import paths of a state machine (without storing the result). */
    resolve(machine: ast.StateMachine): ResolvedImport[] {
        const base = machine.$document?.uri;
        return importPaths(machine).map(node => this.resolvePath(node, base));
    }

    protected resolvePath(node: ast.ImportPath, base: URI | undefined): ResolvedImport {
        const path = node.path ?? '';
        const kind = importKind(path);
        const uri = base && path ? resolveImportUri(base, path) : undefined;
        if (kind === 'header') {
            return this.resolveHeader(node, path, uri);
        }
        if (kind !== 'hsm' || !uri) {
            return { node, path, kind, uri };
        }
        const root = this.documents.getDocument(uri)?.parseResult.value;
        return { node, path, kind, uri, machine: ast.isStateMachine(root) ? root : undefined };
    }

    /** C/C++ headers are not resolved yet (the validator reports an info). */
    protected resolveHeader(node: ast.ImportPath, path: string, uri: URI | undefined): ResolvedImport {
        return { node, path, kind: 'header', uri };
    }

    /**
     * The import cycle starting at the import `start` of `machine`, as the list of machine names
     * (`['Door', 'Motor', 'Door']`), or `undefined` if the import does not lead back to `machine`.
     */
    findCycle(machine: ast.StateMachine, start: ResolvedImport): string[] | undefined {
        const origin = machine.$document?.uri.toString();
        const visited = new Set<string>();
        const search = (current: ast.StateMachine, path: string[]): string[] | undefined => {
            const uri = current.$document?.uri.toString();
            if (uri === origin || current === machine) {
                return [...path, current.name];
            }
            if (!uri || visited.has(uri)) {
                return undefined;
            }
            visited.add(uri);
            for (const next of this.resolve(current)) {
                if (next.machine) {
                    const cycle = search(next.machine, [...path, current.name]);
                    if (cycle) {
                        return cycle;
                    }
                }
            }
            return undefined;
        };
        return start.machine ? search(start.machine, [machine.name]) : undefined;
    }

    /** URIs of the `.hsm` files imported (transitively) by the state machine, without the machine itself. */
    importClosure(machine: ast.StateMachine): URI[] {
        const result = new Map<string, URI>();
        const visit = (current: ast.StateMachine) => {
            for (const resolved of this.resolve(current)) {
                if (resolved.kind === 'hsm' && resolved.uri && !result.has(resolved.uri.toString())) {
                    result.set(resolved.uri.toString(), resolved.uri);
                    if (resolved.machine) {
                        visit(resolved.machine);
                    }
                }
            }
        };
        visit(machine);
        const own = machine.$document?.uri.toString();
        return [...result.entries()].filter(([key]) => key !== own).map(([, uri]) => uri);
    }
}
