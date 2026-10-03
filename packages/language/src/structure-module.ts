import type { StructureImportResolver } from './structure-imports.js';
import type { StructureValidator } from './structure-validator.js';

/** The services of the structure part of the `.devm` language (see `DevmModule` in devm-module.ts). */
export type StructureAddedServices = {
    references: {
        StructureImportResolver: StructureImportResolver
    },
    validation: {
        StructureValidator: StructureValidator
    }
};

