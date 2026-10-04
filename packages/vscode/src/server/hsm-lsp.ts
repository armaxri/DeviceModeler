import { DocumentState, URI, type LangiumDocument, type MaybePromise, type Module } from 'langium';
import {
    DefaultDefinitionProvider, type DeclarationProvider, type DocumentLinkProvider, type LangiumServices, type PartialLangiumServices,
    type TypeDefinitionProvider
} from 'langium/lsp';
import type {
    CancellationToken, DeclarationParams, DefinitionParams, DocumentLink, DocumentLinkParams, LocationLink, TypeDefinitionParams
} from 'vscode-languageserver';
import {
    cppHeaderStore, createHsmServices, declarationLinks, definitionLinks, importKind, importLinks, ModelHoverProvider, ModelSemanticTokenProvider,
    semanticTokenKind, toLocationLinks, typeDefinitionLinks, type HsmServiceExtensions, type NavigationLink
} from 'hsm-language';
import type { DefaultSharedModuleContext, LangiumSharedServices } from 'langium/lsp';
// Node-only part of the language package (not exported from its index because the web app bundles the index)
import {
    headerSettingsFromSection, installNodeHeaderSupport, type HeaderConfigFinder, type HeaderSettingsSection
} from '../../../language/src/node/cpp-headers-node.js';

/*
 * The language server features of models are shared with the web app's Monaco editor (also embedded in
 * Eclipse, JetBrains IDEs and the desktop app): navigation (`lsp/model-navigation.ts`), semantic tokens
 * (`lsp/semantic-tokens.ts`) and hover (`lsp/model-hover.ts`) of the language package. The classes here adapt
 * them to Langium's LSP services.
 */

/** Semantic token type of a declaration (or of the target of a reference). */
export const tokenKind = semanticTokenKind;

/**
 * Semantic highlighting for both languages: names of declarations and all cross references are
 * highlighted by the kind of the element they declare / refer to (states, events, variables,
 * constants, operations, …), C++ names of the headers as types, enums, enumerators and constants.
 */
export class HsmSemanticTokenProvider extends ModelSemanticTokenProvider { }

/**
 * Hover: a short signature of the declaration (e.g. `in event request : integer` or
 * `state Operating.Red`) followed by its documentation comment; the declarations of C++ names.
 */
export class HsmHoverProvider extends ModelHoverProvider { }

export { hoverSignature } from 'hsm-language';

/** LSP location links (undefined if there are none). */
function links(locations: readonly NavigationLink[]): LocationLink[] | undefined {
    return locations.length > 0 ? toLocationLinks(locations) : undefined;
}

/**
 * Go to definition: additionally from C++ names, struct members and header imports into the headers
 * (each segment of a qualified name `app::Mode::Fast` leads to its own declaration), from the name of
 * an imported state machine used as a type (`var motor : Motor`) and from an import path
 * (`import "motor.hsm"`) to the imported state machine. In a reference followed by struct members
 * (`cfg.reading.speed`) only the name of the variable is the origin of the link to the variable.
 */
export class HsmDefinitionProvider extends DefaultDefinitionProvider {

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
 * definition (declarations of the HSM languages are their definitions).
 */
export class HsmDeclarationProvider implements DeclarationProvider {

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
export class HsmTypeDefinitionProvider implements TypeDefinitionProvider {

    constructor(private readonly services: LangiumServices) { }

    getTypeDefinition(document: LangiumDocument, params: TypeDefinitionParams): MaybePromise<LocationLink[] | undefined> {
        return links(typeDefinitionLinks(this.services, document, document.textDocument.offsetAt(params.position)));
    }
}

/**
 * Document links on the paths of imports (`import "motor_types.h"`, `import "motor.hsm"`) that were
 * found: Ctrl/Cmd+Click opens the header or model.
 */
export class HsmDocumentLinkProvider implements DocumentLinkProvider {

    constructor(private readonly services: LangiumServices) { }

    async getDocumentLinks(document: LangiumDocument, _params: DocumentLinkParams, cancelToken?: CancellationToken): Promise<DocumentLink[]> {
        // the imports are resolved when the document is linked
        await this.services.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Linked, document.uri, cancelToken);
        return importLinks(document).map(link => ({ range: link.range, target: link.target, tooltip: link.kind === 'header' ? 'Open header' : 'Open state machine' }));
    }
}

/** Language server features added to both languages. */
export const HsmLspModule: Module<LangiumServices, PartialLangiumServices> = {
    lsp: {
        SemanticTokenProvider: services => new HsmSemanticTokenProvider(services),
        HoverProvider: services => new HsmHoverProvider(services),
        DefinitionProvider: services => new HsmDefinitionProvider(services),
        DeclarationProvider: services => new HsmDeclarationProvider(services),
        TypeProvider: services => new HsmTypeDefinitionProvider(services),
        DocumentLinkProvider: services => new HsmDocumentLinkProvider(services)
    }
};

/** The services of the language server: the HSM languages with the additional LSP features. */
export function createHsmLanguageServerServices(context: DefaultSharedModuleContext) {
    const extensions: HsmServiceExtensions = { hsm: HsmLspModule, hsmTest: HsmLspModule };
    return createHsmServices(context, extensions);
}

/**
 * Imported C/C++ headers in the language server: headers are read from the file system (changed files
 * are re-read: file watcher events), the settings come from the `headers` block of the nearest
 * `hsm.gen.json` and from the VS Code settings `hsm.headers.*` (include paths relative to the first
 * workspace folder, `${workspaceFolder}`). Documents importing a changed header are validated again.
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
        const section = await shared.workspace.ConfigurationProvider.getConfiguration('hsm', 'headers') as HeaderSettingsSection | undefined;
        store.updateSettings(headerSettingsFromSection(section, workspaceFolder));
        rebuild();
    };
    shared.workspace.ConfigurationProvider.onConfigurationSectionUpdate(update => {
        if (update.section === 'hsm') {
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
        if (uris.some(uri => /(^|\/)([^/]+\.)?hsm\.gen\.json$/.test(uri.path))) {
            finder.clear();
            store.updateSettings(store.settings);
        }
    });
    return finder;
}
