import { EmptyFileSystem, inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices, type PartialLangiumServices, type PartialLangiumSharedServices
} from 'langium/lsp';
import { DevmGeneratedModule, DevmGeneratedSharedModule, DevmTestGeneratedModule } from './generated/module.js';
import type { StructureAddedServices } from './structure-module.js';
import { StructureFormatter } from './structure-formatter.js';
import { StructureImportResolver } from './structure-imports.js';
import { StructureLinker, StructureScopeProvider } from './structure-scope.js';
import { StructureValidator, registerStructureValidationChecks } from './structure-validator.js';
import { createDevmParser, DevmParserErrorMessageProvider } from './devm-parser.js';
import { DevmDocumentValidator, ExpressionValidator } from './expression-validator.js';
import { StructureCompletionProvider, StructureDefinitionProvider, StructureDocumentationProvider, StructureImplementationProvider } from './lsp/structure-lsp.js';
import { DevmDocumentBuilder } from './statemachine-linker.js';
import { StateMachineImportResolver } from './imports.js';
import { StateMachineImportValidator, registerImportValidationChecks } from './statemachine-import-validator.js';
import { StateMachineValidator, registerValidationChecks } from './statemachine-validator.js';
import { DevmTestModule, type DevmTestServices } from './testing/devm-test-module.js';
import { registerTestValidationChecks } from './testing/devm-test-validator.js';

export type StateMachineAddedServices = {
    references: {
        ImportResolver: StateMachineImportResolver
    },
    validation: {
        StateMachineImportValidator: StateMachineImportValidator,
        StateMachineValidator: StateMachineValidator,
        ExpressionValidator: ExpressionValidator
    }
};

/**
 * The services of the `.devm` language: state machine files and structure files (see devm.langium).
 * The AST types of the two kinds are disjoint, so the validation checks of both are registered on the
 * same services; the services that differ per kind dispatch on the kind of the node or file: the
 * structure implementations (structure-*.ts, lsp/structure-lsp.ts) extend the state machine implementations and
 * handle the nodes of structure files themselves, everything else is passed to the state machine part
 * (scope provider, linker, formatter, completion, definition, hover documentation).
 */
export type DevmServices = LangiumServices & StateMachineAddedServices & StructureAddedServices;

export const DevmModule: Module<DevmServices, PartialLangiumServices & StateMachineAddedServices & StructureAddedServices> = {
    parser: {
        LangiumParser: (services) => createDevmParser(services),
        ParserErrorMessageProvider: (services) => new DevmParserErrorMessageProvider(services.Grammar)
    },
    references: {
        ScopeProvider: (services) => new StructureScopeProvider(services),
        Linker: (services) => new StructureLinker(services),
        ImportResolver: (services) => new StateMachineImportResolver(services),
        StructureImportResolver: (services) => new StructureImportResolver(services)
    },
    validation: {
        StateMachineImportValidator: (services) => new StateMachineImportValidator(services),
        DocumentValidator: (services) => new DevmDocumentValidator(services),
        StateMachineValidator: () => new StateMachineValidator(),
        ExpressionValidator: () => new ExpressionValidator(),
        StructureValidator: () => new StructureValidator()
    },
    lsp: {
        Formatter: () => new StructureFormatter(),
        CompletionProvider: (services) => new StructureCompletionProvider(services),
        DefinitionProvider: (services) => new StructureDefinitionProvider(services),
        ImplementationProvider: () => new StructureImplementationProvider()
    },
    documentation: {
        DocumentationProvider: (services) => new StructureDocumentationProvider(services)
    }
};

/** Shared services: the document builder relinks documents whose imported files changed. */
export const DevmSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
    workspace: {
        DocumentBuilder: (services) => new DevmDocumentBuilder(services)
    }
};

/** Additional modules, e.g. language server features (semantic highlighting, hover) of an IDE integration. */
export interface DevmServiceExtensions {
    /** Added to the `.devm` language (state machines and structure files). */
    devm?: Module<DevmServices, PartialLangiumServices>;
    devmTest?: Module<DevmTestServices, PartialLangiumServices>;
}

/**
 * Creates the full set of services of the Device Modeler: the `.devm` language (state machine files
 * and structure files, see devm.langium) and the unit test language (`.devmtest`, see `testing/`).
 * The languages share the index, so test classes can reference state machines of other documents and
 * components can reference their state machines.
 * Works in Node.js as well as in the browser (pass `EmptyFileSystem` there).
 */
export function createDevmServices(context: DefaultSharedModuleContext = EmptyFileSystem, extensions: DevmServiceExtensions = {}): {
    shared: LangiumSharedServices,
    Devm: DevmServices,
    DevmTest: DevmTestServices
} {
    const shared = inject(
        createDefaultSharedModule(context),
        DevmGeneratedSharedModule,
        DevmSharedModule
    );
    const Devm = inject(
        createDefaultModule({ shared }),
        DevmGeneratedModule,
        DevmModule,
        extensions.devm ?? {}
    );
    const DevmTest = inject(
        createDefaultModule({ shared }),
        DevmTestGeneratedModule,
        DevmTestModule,
        extensions.devmTest ?? {}
    );
    shared.ServiceRegistry.register(Devm);
    shared.ServiceRegistry.register(DevmTest);
    registerValidationChecks(Devm);
    registerImportValidationChecks(Devm);
    registerTestValidationChecks(DevmTest);
    registerStructureValidationChecks(Devm);
    if (!context.connection) {
        // No language server: the configuration service would otherwise wait for the client forever.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Devm, DevmTest };
}
