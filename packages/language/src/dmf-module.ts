import type { Module } from 'langium';
import type { LangiumServices, PartialLangiumServices } from 'langium/lsp';
import { DmfFormatter } from './dmf-formatter.js';
import { DmfImportResolver } from './dmf-imports.js';
import { DmfLinker, DmfScopeProvider } from './dmf-scope.js';
import { DmfValidator } from './dmf-validator.js';
import { DmfCompletionProvider, DmfDefinitionProvider, DmfDocumentationProvider, DmfImplementationProvider } from './lsp/dmf-lsp.js';

export type DmfAddedServices = {
    references: {
        DmfImportResolver: DmfImportResolver
    },
    validation: {
        DmfValidator: DmfValidator
    }
};

/** Services of the structure language (`.dmf`, Device Modeling Framework). */
export type DmfServices = LangiumServices & DmfAddedServices;

export const DmfModule: Module<DmfServices, PartialLangiumServices & DmfAddedServices> = {
    references: {
        ScopeProvider: (services) => new DmfScopeProvider(services),
        Linker: (services) => new DmfLinker(services),
        DmfImportResolver: (services) => new DmfImportResolver(services)
    },
    validation: {
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
