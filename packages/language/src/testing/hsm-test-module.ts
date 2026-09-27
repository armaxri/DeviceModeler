import type { Module } from 'langium';
import type { LangiumServices, PartialLangiumServices } from 'langium/lsp';
import { HsmTestScopeProvider } from './hsm-test-scope.js';
import { HsmTestValidator } from './hsm-test-validator.js';

export type HsmTestAddedServices = {
    validation: {
        HsmTestValidator: HsmTestValidator
    }
};

/** Services of the unit test language (`.hsmtest`). */
export type HsmTestServices = LangiumServices & HsmTestAddedServices;

export const HsmTestModule: Module<HsmTestServices, PartialLangiumServices & HsmTestAddedServices> = {
    references: {
        ScopeProvider: (services) => new HsmTestScopeProvider(services)
    },
    validation: {
        HsmTestValidator: () => new HsmTestValidator()
    }
};
