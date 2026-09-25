import { EmptyFileSystem, inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices, type PartialLangiumServices
} from 'langium/lsp';
import { HsmGeneratedModule, HsmGeneratedSharedModule } from './generated/module.js';
import { HsmFormatter } from './hsm-formatter.js';
import { HsmScopeProvider } from './hsm-scope.js';
import { HsmValidator, registerValidationChecks } from './hsm-validator.js';

export type HsmAddedServices = {
    validation: {
        HsmValidator: HsmValidator
    }
};

export type HsmServices = LangiumServices & HsmAddedServices;

export const HsmModule: Module<HsmServices, PartialLangiumServices & HsmAddedServices> = {
    references: {
        ScopeProvider: (services) => new HsmScopeProvider(services)
    },
    validation: {
        HsmValidator: () => new HsmValidator()
    },
    lsp: {
        Formatter: () => new HsmFormatter()
    }
};

/**
 * Creates the full set of services required by the HSM language.
 * Works in Node.js as well as in the browser (pass `EmptyFileSystem` there).
 */
export function createHsmServices(context: DefaultSharedModuleContext = EmptyFileSystem): {
    shared: LangiumSharedServices,
    Hsm: HsmServices
} {
    const shared = inject(
        createDefaultSharedModule(context),
        HsmGeneratedSharedModule
    );
    const Hsm = inject(
        createDefaultModule({ shared }),
        HsmGeneratedModule,
        HsmModule
    );
    shared.ServiceRegistry.register(Hsm);
    registerValidationChecks(Hsm);
    if (!context.connection) {
        // No language server: the configuration service would otherwise wait for the client forever.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Hsm };
}
