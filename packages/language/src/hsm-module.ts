import { EmptyFileSystem, inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices, type PartialLangiumServices
} from 'langium/lsp';
import { HsmGeneratedModule, HsmGeneratedSharedModule, HsmTestGeneratedModule } from './generated/module.js';
import { HsmDocumentValidator, HsmExpressionValidator } from './hsm-expression-validator.js';
import { HsmFormatter } from './hsm-formatter.js';
import { HsmDocumentationProvider } from './doc/hsm-documentation-provider.js';
import { HsmLinker } from './hsm-linker.js';
import { HsmScopeProvider } from './hsm-scope.js';
import { HsmValidator, registerValidationChecks } from './hsm-validator.js';
import { HsmTestModule, type HsmTestServices } from './testing/hsm-test-module.js';
import { registerTestValidationChecks } from './testing/hsm-test-validator.js';

export type HsmAddedServices = {
    validation: {
        HsmValidator: HsmValidator,
        HsmExpressionValidator: HsmExpressionValidator
    }
};

export type HsmServices = LangiumServices & HsmAddedServices;

export const HsmModule: Module<HsmServices, PartialLangiumServices & HsmAddedServices> = {
    references: {
        ScopeProvider: (services) => new HsmScopeProvider(services),
        Linker: (services) => new HsmLinker(services)
    },
    validation: {
        DocumentValidator: (services) => new HsmDocumentValidator(services),
        HsmValidator: () => new HsmValidator(),
        HsmExpressionValidator: () => new HsmExpressionValidator()
    },
    lsp: {
        Formatter: () => new HsmFormatter()
    },
    documentation: {
        DocumentationProvider: (services) => new HsmDocumentationProvider(services)
    }
};

/** Additional modules, e.g. language server features (semantic highlighting, hover) of an IDE integration. */
export interface HsmServiceExtensions {
    hsm?: Module<HsmServices, PartialLangiumServices>;
    hsmTest?: Module<HsmTestServices, PartialLangiumServices>;
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
        HsmGeneratedSharedModule
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
    registerTestValidationChecks(HsmTest);
    if (!context.connection) {
        // No language server: the configuration service would otherwise wait for the client forever.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Hsm, HsmTest };
}
