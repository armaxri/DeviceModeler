import type { DmfImportResolver } from './dmf-imports.js';
import type { DmfValidator } from './dmf-validator.js';
import type { HsmServices } from './hsm-module.js';

/** The services of the structure part of the `.devm` language (see `HsmModule` in hsm-module.ts). */
export type DmfAddedServices = {
    references: {
        DmfImportResolver: DmfImportResolver
    },
    validation: {
        DmfValidator: DmfValidator
    }
};

/**
 * Services of structure files. State machine files and structure files are one language (`.devm`), so
 * these are the services of that language ({@link HsmServices}); the name is kept for the code of the
 * structure part.
 */
export type DmfServices = HsmServices;
