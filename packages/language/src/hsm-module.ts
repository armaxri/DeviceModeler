import { EmptyFileSystem, inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices, type PartialLangiumServices, type PartialLangiumSharedServices
} from 'langium/lsp';
import { DevmGeneratedModule, HsmGeneratedSharedModule, HsmTestGeneratedModule } from './generated/module.js';
import type { DmfAddedServices } from './dmf-module.js';
import { DmfFormatter } from './dmf-formatter.js';
import { DmfImportResolver } from './dmf-imports.js';
import { DmfLinker, DmfScopeProvider } from './dmf-scope.js';
import { DmfValidator, registerDmfValidationChecks } from './dmf-validator.js';
import { createDevmParser, DevmParserErrorMessageProvider } from './devm-parser.js';
import { HsmDocumentValidator, HsmExpressionValidator } from './hsm-expression-validator.js';
import { DmfCompletionProvider, DmfDefinitionProvider, DmfDocumentationProvider, DmfImplementationProvider } from './lsp/dmf-lsp.js';
import { HsmDocumentBuilder } from './hsm-linker.js';
import { HsmImportResolver } from './imports.js';
import { HsmImportValidator, registerImportValidationChecks } from './hsm-import-validator.js';
import { HsmValidator, registerValidationChecks } from './hsm-validator.js';
import { HsmTestModule, type HsmTestServices } from './testing/hsm-test-module.js';
import { registerTestValidationChecks } from './testing/hsm-test-validator.js';

export type HsmAddedServices = {
    references: {
        ImportResolver: HsmImportResolver
    },
    validation: {
        HsmImportValidator: HsmImportValidator,
        HsmValidator: HsmValidator,
        HsmExpressionValidator: HsmExpressionValidator
    }
};

/**
 * The services of the `.devm` language: state machine files and structure files (see devm.langium).
 * The AST types of the two kinds are disjoint, so the validation checks of both are registered on the
 * same services; the services that differ per kind dispatch on the kind of the node or file: the
 * structure implementations (dmf-*.ts, lsp/dmf-lsp.ts) extend the state machine implementations and
 * handle the nodes of structure files themselves, everything else is passed to the state machine part
 * (scope provider, linker, formatter, completion, definition, hover documentation).
 */
export type HsmServices = LangiumServices & HsmAddedServices & DmfAddedServices;

export const HsmModule: Module<HsmServices, PartialLangiumServices & HsmAddedServices & DmfAddedServices> = {
    parser: {
        LangiumParser: (services) => createDevmParser(services),
        ParserErrorMessageProvider: (services) => new DevmParserErrorMessageProvider(services.Grammar)
    },
    references: {
        ScopeProvider: (services) => new DmfScopeProvider(services),
        Linker: (services) => new DmfLinker(services),
        ImportResolver: (services) => new HsmImportResolver(services),
        DmfImportResolver: (services) => new DmfImportResolver(services)
    },
    validation: {
        HsmImportValidator: (services) => new HsmImportValidator(services),
        DocumentValidator: (services) => new HsmDocumentValidator(services),
        HsmValidator: () => new HsmValidator(),
        HsmExpressionValidator: () => new HsmExpressionValidator(),
        DmfValidator: () => new DmfValidator()
    },
    lsp: {
        Formatter: () => new DmfFormatter(),
        CompletionProvider: (services) => new DmfCompletionProvider(services),
        DefinitionProvider: (services) => new DmfDefinitionProvider(services),
        ImplementationProvider: () => new DmfImplementationProvider()
    },
    documentation: {
        DocumentationProvider: (services) => new DmfDocumentationProvider(services)
    }
};

/** Shared services: the document builder relinks documents whose imported files changed. */
export const HsmSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
    workspace: {
        DocumentBuilder: (services) => new HsmDocumentBuilder(services)
    }
};

/** Additional modules, e.g. language server features (semantic highlighting, hover) of an IDE integration. */
export interface HsmServiceExtensions {
    /** Added to the `.devm` language (state machines and structure files). */
    hsm?: Module<HsmServices, PartialLangiumServices>;
    hsmTest?: Module<HsmTestServices, PartialLangiumServices>;
}

/**
 * Creates the full set of services of the Device Modeler: the `.devm` language (state machine files
 * and structure files, see devm.langium) and the unit test language (`.devmtest`, see `testing/`).
 * The languages share the index, so test classes can reference state machines of other documents and
 * components can reference their state machines. `Hsm` and `Dmf` are the same services (the `.devm`
 * language), both names are kept for the code of the two kinds.
 * Works in Node.js as well as in the browser (pass `EmptyFileSystem` there).
 */
export function createHsmServices(context: DefaultSharedModuleContext = EmptyFileSystem, extensions: HsmServiceExtensions = {}): {
    shared: LangiumSharedServices,
    Hsm: HsmServices,
    HsmTest: HsmTestServices,
    Dmf: HsmServices
} {
    const shared = inject(
        createDefaultSharedModule(context),
        HsmGeneratedSharedModule,
        HsmSharedModule
    );
    const Hsm = inject(
        createDefaultModule({ shared }),
        DevmGeneratedModule,
        HsmModule,
        extensions.hsm ?? {}
    );
    const HsmTest = inject(
        createDefaultModule({ shared }),
        HsmTestGeneratedModule,
        HsmTestModule,
        extensions.hsmTest ?? {}
    );
    shared.ServiceRegistry.register(Hsm);
    shared.ServiceRegistry.register(HsmTest);
    registerValidationChecks(Hsm);
    registerImportValidationChecks(Hsm);
    registerTestValidationChecks(HsmTest);
    registerDmfValidationChecks(Hsm);
    if (!context.connection) {
        // No language server: the configuration service would otherwise wait for the client forever.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Hsm, HsmTest, Dmf: Hsm };
}
