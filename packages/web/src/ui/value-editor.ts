import {
    defaultValueOf, enumeratorValueText, fromHost, formatValue as formatRuntimeValue, isCppType, runtimeTypeOfCpp, toHost, type HostValue,
    type RuntimeType
} from 'hsm-language';
import { h } from './dom.js';

/**
 * Editors of values in the simulation panel: inputs for integers, reals, booleans and strings, a
 * drop-down with the enumerators for values of C++ enum types, and expandable editors with one
 * editor per member / element for C++ structs and arrays (a change of a member yields the whole
 * struct value).
 */
export interface ValueEditor {
    readonly element: HTMLElement;
    /** Shows a value (not while the user edits it). */
    set(value: HostValue | undefined): void;
    /** The edited value; `undefined` if the input is invalid (the editor is marked). */
    read(): HostValue | undefined;
    /** Whether the user is editing the value (the value is not overwritten then). */
    readonly editing: boolean;
    /** Called when the user changed the value (on `change` of an input). */
    onChange?: () => void;
    /** Called on Escape: the editor should show the current value again. */
    onReset?: () => void;
}

/** The type of an editor: a runtime type or `number` (untyped numbers). */
export type EditorType = RuntimeType | 'number';

/** A short name of a type for titles, e.g. `integer`, `std::uint8_t`, `motor::Mode`. */
export function typeLabel(type: EditorType | undefined): string {
    if (type === undefined) {
        return 'value';
    }
    return typeof type === 'string' ? type : type.cppName;
}

/** The default value of a type as host value (`0`, `""`, the first enumerator, a struct with default members). */
export function defaultHostValue(type: EditorType | undefined): HostValue | undefined {
    if (type === undefined || type === 'void') {
        return undefined;
    }
    if (type === 'number') {
        return 0;
    }
    try {
        return toHost(defaultValueOf(type));
    } catch {
        return undefined;
    }
}

/** An editor for values of the type. */
export function valueEditor(type: EditorType | undefined, value: HostValue | undefined): ValueEditor {
    if (isCppType(type)) {
        const resolved = type.resolved;
        if (resolved.kind === 'enum') {
            return enumEditor(type, value);
        }
        return compositeEditor(type, value);
    }
    return inputEditor(type ?? 'number', value);
}

function baseName(type: EditorType): string {
    if (typeof type === 'string') {
        return type;
    }
    return isCppType(type) ? type.kind : type.kind;
}

function inputEditor(type: EditorType, initial: HostValue | undefined): ValueEditor {
    const base = baseName(type);
    const input = base === 'boolean' ? h('input', { type: 'checkbox' })
        : base === 'string' ? h('input', { type: 'text', spellcheck: 'false' })
            : h('input', { type: 'number', step: base === 'integer' ? '1' : 'any' });
    input.classList.add('sim-input');
    const editor: ValueEditor = {
        element: input,
        set: value => {
            if (input.type === 'checkbox') {
                input.checked = value === true;
            } else {
                input.value = value === undefined ? '' : String(value);
            }
            input.classList.remove('invalid');
        },
        read: () => {
            const value = readInput(input, base, type);
            input.classList.toggle('invalid', value === undefined);
            return value;
        },
        get editing() {
            return document.activeElement === input;
        }
    };
    input.addEventListener('change', () => editor.onChange?.());
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            input.blur();
        } else if (event.key === 'Escape') {
            editor.onReset?.();
            input.blur();
        }
    });
    editor.set(initial);
    return editor;
}

function readInput(input: HTMLInputElement, base: string, type: EditorType): HostValue | undefined {
    if (input.type === 'checkbox') {
        return input.checked;
    }
    const text = input.value.trim();
    switch (base) {
        case 'integer': {
            const value = Number(text);
            if (text === '' || !Number.isInteger(value)) {
                return undefined;
            }
            // C++ integer types: the value must fit (it would be wrapped silently otherwise)
            if (typeof type === 'object' && !isCppType(type) && type.kind === 'integer') {
                const bits = BigInt(type.bits);
                const [min, max] = type.signed ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
                return BigInt(value) >= min && BigInt(value) <= max ? value : undefined;
            }
            return value;
        }
        case 'real':
        case 'number': {
            const value = Number(text);
            return text !== '' && Number.isFinite(value) ? value : undefined;
        }
        case 'string':
            return input.value;
        default:
            return undefined;
    }
}

function enumEditor(type: Extract<RuntimeType, { resolved: unknown }>, initial: HostValue | undefined): ValueEditor {
    const resolved = type.resolved.kind === 'enum' ? type.resolved : undefined;
    const select = h('select', { class: 'sim-input sim-enum' },
        ...(resolved?.enumerators ?? []).map(e => h('option', { value: `${type.cppName}::${e.name}`, title: `${e.qualifiedName} = ${enumeratorValueText(e, resolved!)}` }, e.name)));
    const editor: ValueEditor = {
        element: select,
        set: value => {
            const text = typeof value === 'number' ? `${type.cppName}(${value})` : String(value ?? '');
            if (![...select.options].some(o => o.value === text)) {
                // a value without enumerator (e.g. after a cast)
                select.append(h('option', { value: text, class: 'sim-enum-other' }, text.replace(`${type.cppName}`, '')));
            }
            select.value = text;
        },
        read: () => {
            const match = /\((-?\d+)\)$/.exec(select.value);
            return match ? Number(match[1]) : select.value;
        },
        get editing() {
            return document.activeElement === select;
        }
    };
    select.addEventListener('change', () => editor.onChange?.());
    editor.set(initial);
    return editor;
}

/** Struct or array: a summary line (the canonical text of the value) and the editors of the members / elements. */
function compositeEditor(type: Extract<RuntimeType, { resolved: unknown }>, initial: HostValue | undefined): ValueEditor {
    const resolved = type.resolved;
    const summary = h('summary', { class: 'sim-struct-summary' });
    const rows = h('tbody', {});
    const details = h('details', { class: 'sim-struct' }, summary, h('table', { class: 'sim-struct-table' }, rows));
    const children: Array<{ key: string | number, editor: ValueEditor }> = [];
    let current: HostValue | undefined = initial;
    const parts: Array<{ key: string | number, type: EditorType | undefined, label: string }> = resolved.kind === 'struct'
        ? resolved.fields.map(f => ({ key: f.name, type: runtimeTypeOfCpp(f.type, type.index), label: f.name }))
        : resolved.kind === 'array'
            ? Array.from({ length: resolved.length ?? 0 }, (_, i) => ({ key: i, type: runtimeTypeOfCpp(resolved.element, type.index), label: `[${i}]` }))
            : [];
    const valueOf = (key: string | number): HostValue | undefined => {
        if (Array.isArray(current)) {
            return current[key as number];
        }
        return typeof current === 'object' && current !== null ? (current as Record<string, HostValue>)[key] : undefined;
    };
    const editor: ValueEditor = {
        element: details,
        set: value => {
            current = value;
            summary.textContent = describe(type, value);
            for (const child of children) {
                if (!child.editor.editing) {
                    child.editor.set(valueOf(child.key));
                }
            }
        },
        read: () => {
            let valid = true;
            const values = children.map(child => {
                const value = child.editor.read();
                valid &&= value !== undefined;
                return value;
            });
            if (!valid) {
                return undefined;
            }
            if (resolved.kind === 'array') {
                return values as HostValue[];
            }
            return Object.fromEntries(children.map((child, i) => [child.key, values[i]!]));
        },
        get editing() {
            return children.some(child => child.editor.editing);
        }
    };
    for (const part of parts) {
        const child = valueEditor(part.type, valueOf(part.key));
        child.onChange = () => editor.onChange?.();
        child.onReset = () => editor.onReset?.();
        children.push({ key: part.key, editor: child });
        rows.append(h('tr', {}, h('td', { class: 'sim-name', title: typeLabel(part.type) }, part.label), h('td', { class: 'sim-value' }, child.element)));
    }
    editor.set(initial);
    return editor;
}

/** The canonical text of a host value of a C++ type (`{x: 1, y: 2}`, `motor::Mode::Fast`). */
function describe(type: RuntimeType, value: HostValue | undefined): string {
    try {
        return formatRuntimeValue(fromHost(value, type, 'value'));
    } catch {
        return JSON.stringify(value) ?? '–';
    }
}

/** The text of a (read-only) value of a type, e.g. `{x: 1, y: 2}`, `motor::Mode::Fast`, `"text"`, `2.5`. */
export function formatHostValue(type: EditorType | undefined, value: HostValue | undefined): string {
    if (value === undefined) {
        return '–';
    }
    if (isCppType(type)) {
        return describe(type, value);
    }
    return typeof value === 'string' ? JSON.stringify(value) : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
