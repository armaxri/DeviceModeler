import { EmptyFileSystem, inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices, type PartialLangiumServices, type PartialLangiumSharedServices
} from 'langium/lsp';
import { HsmGeneratedModule, HsmGeneratedSharedModule, HsmTestGeneratedModule } from './generated/module.js';
import { HsmDocumentValidator, HsmExpressionValidator } from './hsm-expression-validator.js';
import { HsmFormatter } from './hsm-formatter.js';
import { HsmCompletionProvider } from './lsp/cpp-lsp.js';
import { HsmDocumentationProvider } from './doc/hsm-documentation-provider.js';
import { HsmDocumentBuilder, HsmLinker } from './hsm-linker.js';
import { HsmImportResolver } from './imports.js';
import { HsmImportValidator, registerImportValidationChecks } from './hsm-import-validator.js';
import { HsmScopeProvider } from './hsm-scope.js';
import { HsmValueConverter } from './hsm-value-converter.js';
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

export type HsmServices = LangiumServices & HsmAddedServices;

export const HsmModule: Module<HsmServices, PartialLangiumServices & HsmAddedServices> = {
    parser: {
        ValueConverter: () => new HsmValueConverter()
    },
    references: {
        ScopeProvider: (services) => new HsmScopeProvider(services),
        Linker: (services) => new HsmLinker(services),
        ImportResolver: (services) => new HsmImportResolver(services)
    },
    validation: {
        HsmImportValidator: (services) => new HsmImportValidator(services),
        DocumentValidator: (services) => new HsmDocumentValidator(services),
        HsmValidator: () => new HsmValidator(),
        HsmExpressionValidator: () => new HsmExpressionValidator()
    },
    lsp: {
        Formatter: () => new HsmFormatter(),
        CompletionProvider: (services) => new HsmCompletionProvider(services)
    },
    documentation: {
        DocumentationProvider: (services) => new HsmDocumentationProvider(services)
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
    hsm?: Module<HsmServices, PartialLangiumServices>;
    hsmTest?: Module<HsmTestServices, PartialLangiumServices>;
    shared?: Module<LangiumSharedServices, PartialLangiumSharedServices>;
}

/**
 * Creates the full set of services required by the HSM language (`.hsm`) and its unit test
 * language (`.hsmtest`, see `testing/`). Both languages share the index, so test classes can
 * reference state machines of other documents.
 * Works in Node.js as well as in the browser (pass `EmptyFileSystem` there).
 */
export function createHsmServices(context: DefaultSharedModuleContext = EmptyFileSystem, extensions: HsmServiceExtensions = {}): {
    shared: LangiumSharedServices,
    Hsm: HsmServices,
    HsmTest: HsmTestServices
} {
    const shared = inject(
        createDefaultSharedModule(context),
        HsmGeneratedSharedModule,
        HsmSharedModule,
        extensions.shared ?? {}
    );
    const Hsm = inject(
        createDefaultModule({ shared }),
        HsmGeneratedModule,
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
    if (!context.connection) {
        // No language server: the configuration service would otherwise wait for the client forever.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Hsm, HsmTest };
}
