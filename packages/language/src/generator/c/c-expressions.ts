import type { DevmType } from '../../typesystem.js';

/** C type of a value type. */
export function cType(type: DevmType): string {
    switch (type) {
        case 'real': return 'sc_real';
        case 'boolean': return 'sc_boolean';
        case 'string': return 'sc_string';
        case 'void': return 'void';
        default: return 'sc_integer';
    }
}

/** C literal of the default value of a type. */
export function cDefault(type: DevmType): string {
    switch (type) {
        case 'real': return '0.0';
        case 'boolean': return 'false';
        case 'string': return '""';
        default: return '0';
    }
}
