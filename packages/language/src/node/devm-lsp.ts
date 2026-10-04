import { DefaultWorkspaceManager, DocumentState, URI, type LangiumDocument, type MaybePromise, type Module } from 'langium';
import {
    type DeclarationProvider, type DocumentLinkProvider, type LangiumServices, type PartialLangiumServices,
    type TypeDefinitionProvider
} from 'langium/lsp';
import type {
    CancellationToken, DeclarationParams, DefinitionParams, DocumentLink, DocumentLinkParams, LocationLink, TypeDefinitionParams
} from 'vscode-languageserver';
import {
    cppHeaderStore, createDevmServices, declarationLinks, definitionLinks, importKind, importLinks, ModelHoverProvider, ModelSemanticTokenProvider,
    semanticTokenKind, StructureDefinitionProvider, toLocationLinks, typeDefinitionLinks, type DevmServiceExtensions, type NavigationLink
} from '../index.js';
import type { DefaultSharedModuleContext, LangiumSharedServices, PartialLangiumSharedServices } from 'langium/lsp';
import type { InitializeParams } from 'vscode-languageserver';
import {
    headerSettingsFromSection, installNodeHeaderSupport, type HeaderConfigFinder, type HeaderSettingsSection
} from './cpp-headers-node.js';

/*
 * The language server features of models are shared with the web app's Monaco editor (also embedded in
 * Eclipse, JetBrains IDEs and the desktop app): navigation (`lsp/model-navigation.ts`), semantic tokens
 * (`lsp/semantic-tokens.ts`) and hover (`lsp/model-hover.ts`) of the language package. The classes here adapt
 * them to Langium's LSP services. The server (`language-server.ts`) runs in the VS Code extension and as
 * `devm lsp` of the command line executable (Eclipse, JetBrains IDEs, other LSP clients). Not exported from
 * the package index (Node.js only).
 */

/** Semantic token type of a declaration (or of the target of a reference). */
export const tokenKind = semanticTokenKind;

/**
 * Semantic highlighting for both languages: names of declarations and all cross references are
 * highlighted by the kind of the element they declare / refer to (states, events, variables,
 * constants, operations, …), C++ names of the headers as types, enums, enumerators and constants.
 */
export class DevmSemanticTokenProvider extends ModelSemanticTokenProvider { }

/**
 * Hover: a short signature of the declaration (e.g. `in event request : integer` or
 * `state Operating.Red`) followed by its documentation comment; the declarations of C++ names.
 */
export class DevmHoverProvider extends ModelHoverProvider { }

export { hoverSignature } from '../index.js';

/** LSP location links (undefined if there are none). */
function links(locations: readonly NavigationLink[]): LocationLink[] | undefined {
    return locations.length > 0 ? toLocationLinks(locations) : undefined;
}

/**
 * Go to definition: additionally from C++ names, struct members and header imports into the headers
 * (each segment of a qualified name `app::Mode::Fast` leads to its own declaration), from the name of
 * an imported state machine used as a type (`var motor : Motor`) and from an import path
 * (`import "motor.devm"`) to the imported state machine. In a reference followed by struct members
 * (`cfg.reading.speed`) only the name of the variable is the origin of the link to the variable. In structure
 * files the definitions of the structure part (data types, imports, behavior files; StructureDefinitionProvider).
 */
export class DevmDefinitionProvider extends StructureDefinitionProvider {

    constructor(private readonly services: LangiumServices) {
        super(services);
    }

    override async getDefinition(document: LangiumDocument, params: DefinitionParams): Promise<LocationLink[] | undefined> {
        return links(await definitionLinks(this.services, document, document.textDocument.offsetAt(params.position),
            (d, p) => super.getDefinition(d, { ...params, ...p })));
    }
}

/**
 * Go to declaration: for C++ names all declarations in the headers, the definition first (all blocks
 * of a namespace, opaque enum declarations, using-declarations and their targets); otherwise the
 * definition (declarations of the Device Modeler languages are their definitions).
 */
export class DevmDeclarationProvider implements DeclarationProvider {

    constructor(private readonly services: LangiumServices) { }

    async getDeclaration(document: LangiumDocument, params: DeclarationParams): Promise<LocationLink[] | undefined> {
        const definition = async () => (await this.services.lsp.DefinitionProvider?.getDefinition(document, params) ?? [])
            .map(l => ({ uri: l.targetUri, range: l.targetRange, selection: l.targetSelectionRange, origin: l.originSelectionRange ?? l.targetSelectionRange }));
        return links(await declarationLinks(this.services, document, document.textDocument.offsetAt(params.position), definition));
    }
}

/**
 * Go to type definition: from C++ constants, enumerators and struct members to their enum or struct
 * declaration in the header, from variables, events, parameters, operations and type aliases (their
 * declarations and references) to their C++ type, from submachine instances to the imported state machine.
 */
export class DevmTypeDefinitionProvider implements TypeDefinitionProvider {

    constructor(private readonly services: LangiumServices) { }

    getTypeDefinition(document: LangiumDocument, params: TypeDefinitionParams): MaybePromise<LocationLink[] | undefined> {
        return links(typeDefinitionLinks(this.services, document, document.textDocument.offsetAt(params.position)));
    }
}

/**
 * Document links on the paths of imports (`import "motor_types.h"`, `import "motor.devm"`) that were
 * found: Ctrl/Cmd+Click opens the header or model.
 */
export class DevmDocumentLinkProvider implements DocumentLinkProvider {

    constructor(private readonly services: LangiumServices) { }

    async getDocumentLinks(document: LangiumDocument, _params: DocumentLinkParams, cancelToken?: CancellationToken): Promise<DocumentLink[]> {
        // the imports are resolved when the document is linked
        await this.services.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Linked, document.uri, cancelToken);
        return importLinks(document).map(link => ({ range: link.range, target: link.target, tooltip: link.kind === 'header' ? 'Open header' : 'Open model' }));
    }
}

/** Language server features added to both languages. */
export const DevmLspModule: Module<LangiumServices, PartialLangiumServices> = {
    lsp: {
        SemanticTokenProvider: services => new DevmSemanticTokenProvider(services),
        HoverProvider: services => new DevmHoverProvider(services),
        DefinitionProvider: services => new DevmDefinitionProvider(services),
        DeclarationProvider: services => new DevmDeclarationProvider(services),
        TypeProvider: services => new DevmTypeDefinitionProvider(services),
        DocumentLinkProvider: services => new DevmDocumentLinkProvider(services)
    }
};

/**
 * The workspace of clients that only send the deprecated `rootUri` / `rootPath` (no `workspaceFolders`):
 * the root is indexed as the only workspace folder, so references between files work in every client.
 */
export class DevmWorkspaceManager extends DefaultWorkspaceManager {

    override initialize(params: InitializeParams): void {
        super.initialize(params);
        const root = params.rootUri ?? (params.rootPath ? URI.file(params.rootPath).toString() : undefined);
        if ((!this.folders || this.folders.length === 0) && root) {
            this.folders = [{ uri: root, name: URI.parse(root).path.split('/').pop() || 'workspace' }];
        }
    }
}

/** Shared services of the language server. */
export const DevmSharedLspModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
    workspace: {
        WorkspaceManager: services => new DevmWorkspaceManager(services)
    }
};

/** The services of the language server: the languages of the Device Modeler with the additional LSP features. */
export function createDevmLanguageServerServices(context: DefaultSharedModuleContext) {
    const extensions: DevmServiceExtensions = { devm: DevmLspModule, devmTest: DevmLspModule, shared: DevmSharedLspModule };
    return createDevmServices(context, extensions);
}

/**
 * Imported C/C++ headers in the language server: headers are read from the file system (changed files
 * are re-read: file watcher events), the settings come from the `headers` block of the nearest
 * `devm.gen.json` and from the client settings `devm.headers.*` (VS Code settings, `workspace/configuration`;
 * include paths relative to the first workspace folder, `${workspaceFolder}`; clients without settings
 * use the defaults). Documents importing a changed header are validated again. Changed files are
 * reported by the client (`workspace/didChangeWatchedFiles`, the watcher for all files is registered
 * dynamically by Langium when the client supports it).
 */
export function installHeaderSupport(shared: LangiumSharedServices): HeaderConfigFinder {
    const finder = installNodeHeaderSupport(shared);
    const store = cppHeaderStore(shared);
    let workspaceFolder: string | undefined;
    shared.lsp.LanguageServer.onInitialize(params => {
        const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
        workspaceFolder = folder ? URI.parse(folder).fsPath : undefined;
    });
    const rebuild = () => {
        void shared.workspace.WorkspaceLock.write(token => shared.workspace.DocumentBuilder.update([], [], token));
    };
    const applySettings = async () => {
        const section = await shared.workspace.ConfigurationProvider.getConfiguration('devm', 'headers') as HeaderSettingsSection | undefined;
        store.updateSettings(headerSettingsFromSection(section, workspaceFolder));
        rebuild();
    };
    shared.workspace.ConfigurationProvider.onConfigurationSectionUpdate(update => {
        if (update.section === 'devm') {
            void applySettings();
        }
    });
    void shared.workspace.ConfigurationProvider.ready.then(applySettings);
    // header and configuration files changed on disk (the document builder ignores them, but relinks the importing documents)
    shared.lsp.DocumentUpdateHandler.onWatchedFilesChange(params => {
        const uris = params.changes.map(change => URI.parse(change.uri));
        const headers = uris.filter(uri => importKind(uri.path) === 'header');
        if (headers.length > 0) {
            store.invalidate(headers);
        }
        if (uris.some(uri => /(^|\/)([^/]+\.)?devm\.gen\.json$/.test(uri.path))) {
            finder.clear();
            store.updateSettings(store.settings);
        }
    });
    return finder;
}
