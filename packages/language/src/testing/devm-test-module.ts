import type { Module } from 'langium';
import type { LangiumServices, PartialLangiumServices } from 'langium/lsp';
import { DevmTestScopeProvider } from './devm-test-scope.js';
import { DevmTestLinker } from '../statemachine-linker.js';
import { StateMachineCompletionProvider } from '../lsp/cpp-lsp.js';
import { DevmTestValidator } from './devm-test-validator.js';
import { DevmValueConverter } from '../devm-value-converter.js';

export type DevmTestAddedServices = {
    validation: {
        DevmTestValidator: DevmTestValidator
    }
};

/** Services of the unit test language (`.devmtest`). */
export type DevmTestServices = LangiumServices & DevmTestAddedServices;

export const DevmTestModule: Module<DevmTestServices, PartialLangiumServices & DevmTestAddedServices> = {
    parser: {
        ValueConverter: () => new DevmValueConverter()
    },
    references: {
        ScopeProvider: (services) => new DevmTestScopeProvider(services),
        Linker: (services) => new DevmTestLinker(services)
    },
    validation: {
        DevmTestValidator: () => new DevmTestValidator()
    },
    lsp: {
        CompletionProvider: (services) => new StateMachineCompletionProvider(services)
    }
};
