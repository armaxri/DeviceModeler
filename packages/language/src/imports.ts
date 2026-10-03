import { AstUtils, URI, UriUtils, type AstNode, type LangiumCoreServices, type LangiumDocuments, type Reference } from 'langium';
import * as ast from './generated/ast.js';
import { cppHeaderStore, loadHeaderClosure, resolveHeaderPath, type CppHeaderStore, type CppImportInfo, type LoadedHeader } from './cpp-headers.js';
import { CppTypeIndex } from './cpp-header/type-index.js';

/**
 * Imports of other files (`import "motor.devm"`) and submachine instances.
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
 * Kinds of imports ({@link importKind}): `.devm` files (state machine files, their names are types;
 * a structure file cannot be imported by a state machine),
 * C/C++ headers (`.h`, `.hpp`, ...: their types and constants, see cpp-headers.ts and cpp-types.ts;
 * resolved relative to the importing file and the include paths) and everything else (unsupported, an error).
 */

/** `model`: a model file (`.devm`); `header`: a C/C++ header; `unsupported`: any other file. */
export type ImportKind = 'model' | 'header' | 'unsupported';

/** The file extension of the model files of the Device Modeler (state machines and structure files). */
export const MODEL_EXTENSION = '.devm';

/** The file extension of the unit test files of state machines. */
export const TEST_EXTENSION = '.devmtest';

/** Whether a path (or URI) names a model file (`.devm`). */
export function isModelPath(path: string): boolean {
    return path.toLowerCase().endsWith(MODEL_EXTENSION);
}

/** Whether a path (or URI) names a unit test file (`.devmtest`). */
export function isTestPath(path: string): boolean {
    return path.toLowerCase().endsWith(TEST_EXTENSION);
}

/** File extensions of C/C++ headers accepted by `import`. */
export const HEADER_EXTENSIONS: readonly string[] = ['.h', '.hh', '.hpp', '.hxx', '.h++', '.inl'];

/** The result of resolving one import path. */
export interface ResolvedImport {
    /** The path in the text (`import "motor.devm"`). */
    readonly node: ast.ImportPath;
    readonly path: string;
    readonly kind: ImportKind;
    /** URI of the imported file (resolved relative to the importing document). */
    readonly uri?: URI;
    /** `model`: the imported state machine, `undefined` if the file is not loaded or is a structure file. */
    readonly machine?: ast.StateMachine;
    /** `model`: whether the imported file is a structure file (which a state machine cannot import). */
    readonly structureFile?: boolean;
    /** `header`: the result of the header resolution. */
    readonly header?: ResolvedHeader;
}

/** A resolved header import. */
export interface ResolvedHeader {
    /** Whether the header was found (`uri` of the import is its location). */
    readonly found: boolean;
    /** The locations that were searched (the directory of the importing file, then the include paths). */
    readonly searched: readonly URI[];
    /** The header and the headers it includes (transitively), empty if it was not found. */
    readonly headers: readonly LoadedHeader[];
}

/** The kind of an import path, by its file extension. */
export function importKind(path: string): ImportKind {
    const lower = path.toLowerCase();
    if (lower.endsWith(MODEL_EXTENSION)) {
        return 'model';
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
const cppRegistry = new WeakMap<ast.StateMachine, CppImportInfo>();
let emptyIndex: CppTypeIndex | undefined;

/** Stores the resolved imports of a state machine (called by the {@link HsmImportResolver}). */
export function registerImports(machine: ast.StateMachine, imports: readonly ResolvedImport[], cpp?: CppImportInfo): void {
    registry.set(machine, imports);
    if (cpp) {
        cppRegistry.set(machine, cpp);
    } else {
        cppRegistry.delete(machine);
    }
}

/**
 * The C++ types and constants visible in a state machine: the index over its imported headers (and
 * the headers they include). Without header imports (or before the machine is linked) an empty
 * index, which knows the fundamental types and the `<cstdint>` typedefs.
 */
export function cppImports(machine: ast.StateMachine | undefined): CppImportInfo {
    const info = machine ? cppRegistry.get(machine) : undefined;
    return info ?? { index: emptyIndex ??= new CppTypeIndex([]), headers: [] };
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
    let text = reference.$refText.replace(/\s+/g, '');
    // tests may prefix state names with the name of the state machine (`Gate.motor.On`)
    if (text.startsWith(`${context.name}.`) && !instanceVariables(context).some(i => text.startsWith(`${referableName(i)}.`))) {
        text = text.slice(context.name.length + 1);
    }
    let result: ast.VariableDeclaration | undefined;
    for (const instance of instanceVariables(context)) {
        const name = referableName(instance);
        if (text.startsWith(`${name}.`) && (!result || name.length > referableName(result).length)) {
            result = instance;
        }
    }
    return result;
}

/** Whether a C/C++ header import of the machine could not be resolved (errors of C++ names are then not reported). */
export function hasUnresolvedHeaders(machine: ast.StateMachine | undefined): boolean {
    return !!machine && resolvedImports(machine).some(i => i.kind === 'header' && !i.header?.found);
}

/** Whether a `.devm` import of the machine could not be resolved (the file is missing or not a state machine). */
export function hasUnresolvedImports(machine: ast.StateMachine): boolean {
    return resolvedImports(machine).some(i => i.kind === 'model' && !i.machine);
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
    readonly headerStore: CppHeaderStore;

    constructor(services: LangiumCoreServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
        this.headerStore = cppHeaderStore(services.shared);
    }

    /** Resolves the imports of the state machine of a document and stores them in the registry. */
    update(machine: ast.StateMachine): readonly ResolvedImport[] {
        const imports = this.resolve(machine);
        registerImports(machine, imports, this.cppImports(machine, imports));
        return imports;
    }

    /** The index over the headers of the resolved imports (`undefined` if there are no header imports). */
    protected cppImports(machine: ast.StateMachine, imports: readonly ResolvedImport[]): CppImportInfo | undefined {
        const headers: LoadedHeader[] = [];
        const seen = new Set<string>();
        for (const resolved of imports) {
            for (const header of resolved.header?.headers ?? []) {
                if (!seen.has(header.uri.toString())) {
                    seen.add(header.uri.toString());
                    headers.push(header);
                }
            }
        }
        if (!imports.some(i => i.kind === 'header')) {
            return undefined;
        }
        const settings = this.headerStore.settingsFor(machine.$document?.uri);
        return { index: this.headerStore.index(headers, settings), headers, settingsVersion: this.headerStore.settingsVersion };
    }

    /**
     * Whether the headers used by the machine changed since it was linked (a header text changed, or
     * a header that was not found might exist now).
     */
    headersChanged(machine: ast.StateMachine): boolean {
        const info = cppRegistry.get(machine);
        if (info && info.settingsVersion !== this.headerStore.settingsVersion) {
            return true;
        }
        return resolvedImports(machine).some(i => i.kind === 'header' && i.header !== undefined
            && (!i.header.found || i.header.headers.some(h => this.headerStore.version(h.uri) !== h.version)));
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
        if (kind !== 'model' || !uri) {
            return { node, path, kind, uri };
        }
        const root = this.documents.getDocument(uri)?.parseResult.value;
        return { node, path, kind, uri, machine: ast.isStateMachine(root) ? root : undefined, structureFile: ast.isDmfModel(root) };
    }

    /**
     * Finds a header in the {@link CppHeaderStore} (relative to the importing file, then in the include
     * paths) and loads it with the headers it includes.
     */
    protected resolveHeader(node: ast.ImportPath, path: string, uri: URI | undefined): ResolvedImport {
        const base = AstUtils.findRootNode(node).$document?.uri;
        const settings = this.headerStore.settingsFor(base);
        const found = resolveHeaderPath(this.headerStore, path, base ? UriUtils.dirname(base) : undefined, settings);
        if (!found.uri) {
            return { node, path, kind: 'header', uri: uri ?? found.searched[0], header: { found: false, searched: found.searched, headers: [] } };
        }
        const headers = loadHeaderClosure(this.headerStore, found.uri, settings);
        return { node, path, kind: 'header', uri: found.uri, header: { found: true, searched: found.searched, headers } };
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

    /** URIs of the `.devm` files imported (transitively) by the state machine, without the machine itself. */
    importClosure(machine: ast.StateMachine): URI[] {
        const result = new Map<string, URI>();
        const visit = (current: ast.StateMachine) => {
            for (const resolved of this.resolve(current)) {
                if (resolved.kind === 'model' && resolved.uri && !result.has(resolved.uri.toString())) {
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
