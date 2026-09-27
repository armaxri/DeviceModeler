import type { StateMachine } from '../generated/ast.js';
import { generateC } from './c/index.js';
import { generateCpp } from './cpp/index.js';

/**
 * Generator configuration files (`hsm.gen.json`, like the `.sgen` files of itemis CREATE): which
 * models are generated for which targets with which options. This module contains the format, its
 * validation and the file name / include post-processing; it has no file system access (it is also
 * used in the browser). Loading the file, expanding the globs and writing the files is done by
 * `generate-command.ts` (Node only). The JSON schema is `schemas/hsm-gen.schema.json`.
 *
 * ```json
 * {
 *     "$schema": "../node_modules/hsm-language/schemas/hsm-gen.schema.json",
 *     "models": ["models/*.hsm", { "path": "legacy/door.hsm", "cpp": { "namespace": "legacy" } }],
 *     "cpp": { "outDir": "src-gen", "namespace": "app::sm", "std": 17, "headerExtension": ".hpp" },
 *     "writeOnlyIfChanged": true
 * }
 * ```
 */

/** Default file name of a generator configuration (`<name>.hsm.gen.json` is also recognized by the schema). */
export const GENERATOR_CONFIG_FILE = 'hsm.gen.json';

export type GeneratorTarget = 'cpp' | 'c';
export const GENERATOR_TARGETS: readonly GeneratorTarget[] = ['cpp', 'c'];

/** Options shared by all targets. */
export interface CommonTargetConfig {
    /** Output directory, relative to the configuration file (default: the directory of each model). */
    outDir?: string;
    /** Extension of the generated headers including the dot (default `.h`); includes are adapted. */
    headerExtension?: string;
    /** Extension of the generated sources (default `.cpp` / `.c`). */
    sourceExtension?: string;
    /** Text put at the top of every generated file; wrapped in a comment unless it is one already. */
    licenseHeader?: string | string[];
    /** File (relative to the configuration file) whose text is used as `licenseHeader`. */
    licenseHeaderFile?: string;
    /** Maximum number of transitions per step and of queued event steps per call (default 1000). */
    maxMicrosteps?: number;
}

/** Options of the C++ target (see `CppGeneratorOptions`). */
export interface CppTargetConfig extends CommonTargetConfig {
    /** Namespace `a::b` (default: the namespace of the model, `""`: the global namespace). */
    namespace?: string;
    /** Name of the class and its files (default: the state machine name); only useful per model. */
    className?: string;
    /** C++ standard the code is written for (default 17). */
    std?: 11 | 17;
}

/** Options of the C target (see `CGeneratorOptions`). */
export interface CTargetConfig extends CommonTargetConfig {
    /** Prefix of functions and file names (default: the state machine name in snake case). */
    prefix?: string;
    /** Name of the handle type (default: the state machine name). */
    typeName?: string;
    /** Size of string buffers including the terminating 0 (default 64). */
    stringCapacity?: number;
    /** Capacity of the event queues (default 16). */
    queueCapacity?: number;
}

export type TargetConfig = CppTargetConfig | CTargetConfig;

/** A model entry: a path or glob (relative to the configuration file) with optional per-model options. */
export interface ModelEntry {
    path: string;
    cpp?: CppTargetConfig;
    c?: CTargetConfig;
}

/** A validated generator configuration. A target is generated if its key is present. */
export interface GeneratorConfig {
    models: ModelEntry[];
    cpp?: CppTargetConfig;
    c?: CTargetConfig;
    /** Only write files whose content changed, keeping the modification times of the others (default true). */
    writeOnlyIfChanged: boolean;
}

export interface ConfigDiagnostic {
    severity: 'error' | 'warning';
    message: string;
    /** JSON pointer of the offending value, e.g. `/cpp/std`. */
    pointer: string;
}

export interface ParsedGeneratorConfig {
    /** Undefined if there are errors. */
    config?: GeneratorConfig;
    diagnostics: ConfigDiagnostic[];
}

type PropertyKind = 'string' | 'extension' | 'identifier' | 'text' | 'std' | 'positive';

const COMMON_PROPERTIES: Record<keyof CommonTargetConfig, PropertyKind> = {
    outDir: 'string',
    headerExtension: 'extension',
    sourceExtension: 'extension',
    licenseHeader: 'text',
    licenseHeaderFile: 'string',
    maxMicrosteps: 'positive'
};

/** The properties of the targets and their kinds (kept in sync with the JSON schema by a test). */
export const TARGET_PROPERTIES: { cpp: Record<keyof CppTargetConfig, PropertyKind>, c: Record<keyof CTargetConfig, PropertyKind> } = {
    cpp: { ...COMMON_PROPERTIES, namespace: 'string', className: 'identifier', std: 'std' },
    c: { ...COMMON_PROPERTIES, prefix: 'identifier', typeName: 'identifier', stringCapacity: 'positive', queueCapacity: 'positive' }
};

/** The top-level properties (kept in sync with the JSON schema by a test). */
export const CONFIG_PROPERTIES = ['$schema', 'models', 'cpp', 'c', 'writeOnlyIfChanged'] as const;

const DEFAULT_SOURCE_EXTENSIONS: Record<GeneratorTarget, string> = { cpp: '.cpp', c: '.c' };

/**
 * Validates a generator configuration given as JSON text or as parsed value. Unknown properties are
 * errors (to catch typos); `$schema` is allowed.
 */
export function parseGeneratorConfig(input: string | unknown): ParsedGeneratorConfig {
    const diagnostics: ConfigDiagnostic[] = [];
    const error = (pointer: string, message: string) => diagnostics.push({ severity: 'error', message, pointer });
    let value: unknown = input;
    if (typeof input === 'string') {
        try {
            value = JSON.parse(input);
        } catch (e) {
            error('', `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
            return { diagnostics };
        }
    }
    if (!isObject(value)) {
        error('', 'the configuration must be a JSON object');
        return { diagnostics };
    }
    for (const key of Object.keys(value)) {
        if (!(CONFIG_PROPERTIES as readonly string[]).includes(key)) {
            error(`/${key}`, `unknown property '${key}' (expected one of ${CONFIG_PROPERTIES.filter(p => p !== '$schema').join(', ')})`);
        }
    }
    const models: ModelEntry[] = [];
    if (!Array.isArray(value.models) || value.models.length === 0) {
        error('/models', `'models' must be a non-empty array of paths / globs of .hsm files`);
    } else {
        value.models.forEach((entry: unknown, index: number) => {
            const pointer = `/models/${index}`;
            if (typeof entry === 'string') {
                if (entry.trim() === '') {
                    error(pointer, 'empty model path');
                } else {
                    models.push({ path: entry });
                }
            } else if (isObject(entry)) {
                for (const key of Object.keys(entry)) {
                    if (key !== 'path' && key !== 'cpp' && key !== 'c') {
                        error(`${pointer}/${key}`, `unknown property '${key}' of a model entry (expected path, cpp, c)`);
                    }
                }
                if (typeof entry.path !== 'string' || entry.path.trim() === '') {
                    error(`${pointer}/path`, `a model entry needs a 'path' (path or glob of .hsm files)`);
                    return;
                }
                const model: ModelEntry = { path: entry.path };
                for (const target of GENERATOR_TARGETS) {
                    if (entry[target] !== undefined) {
                        const options = validateTarget(target, entry[target], `${pointer}/${target}`, error);
                        if (options) {
                            model[target] = options;
                        }
                    }
                }
                models.push(model);
            } else {
                error(pointer, 'a model entry must be a path / glob or an object { "path": ..., "cpp": {...}, "c": {...} }');
            }
        });
    }
    const config: GeneratorConfig = { models, writeOnlyIfChanged: true };
    for (const target of GENERATOR_TARGETS) {
        if (value[target] !== undefined) {
            const options = validateTarget(target, value[target], `/${target}`, error);
            if (options) {
                config[target] = options as CppTargetConfig & CTargetConfig;
            }
        }
    }
    if (value.cpp === undefined && value.c === undefined) {
        error('', `no target configured: add "cpp": {} and / or "c": {}`);
    }
    if (value.writeOnlyIfChanged !== undefined) {
        if (typeof value.writeOnlyIfChanged === 'boolean') {
            config.writeOnlyIfChanged = value.writeOnlyIfChanged;
        } else {
            error('/writeOnlyIfChanged', `'writeOnlyIfChanged' must be true or false`);
        }
    }
    return diagnostics.some(d => d.severity === 'error') ? { diagnostics } : { config, diagnostics };
}

function validateTarget(target: GeneratorTarget, value: unknown, pointer: string,
    error: (pointer: string, message: string) => void): TargetConfig | undefined {
    if (!isObject(value)) {
        error(pointer, `'${target}' must be an object with the options of the ${target === 'cpp' ? 'C++' : 'C'} generator`);
        return undefined;
    }
    const properties: Record<string, PropertyKind> = TARGET_PROPERTIES[target];
    const result: Record<string, unknown> = {};
    for (const [key, option] of Object.entries(value)) {
        const kind = properties[key];
        const at = `${pointer}/${key}`;
        if (!kind) {
            error(at, `unknown option '${key}' of target '${target}' (expected one of ${Object.keys(properties).join(', ')})`);
            continue;
        }
        const problem = checkKind(kind, option);
        if (problem) {
            error(at, `'${key}' ${problem}`);
        } else {
            result[key] = option;
        }
    }
    if (result.licenseHeader !== undefined && result.licenseHeaderFile !== undefined) {
        error(pointer, `use either 'licenseHeader' or 'licenseHeaderFile', not both`);
    }
    return result as TargetConfig;
}

function checkKind(kind: PropertyKind, value: unknown): string | undefined {
    switch (kind) {
        case 'string':
            return typeof value === 'string' ? undefined : 'must be a string';
        case 'identifier':
            return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : 'must be an identifier';
        case 'extension':
            return typeof value === 'string' && /^\.[A-Za-z0-9_+]+$/.test(value) ? undefined : `must be a file extension starting with a dot, e.g. '.hpp'`;
        case 'text':
            return typeof value === 'string' || (Array.isArray(value) && value.every(line => typeof line === 'string'))
                ? undefined : 'must be a string or an array of lines';
        case 'std':
            return value === 11 || value === 17 || value === '11' || value === '17' ? undefined : 'must be 17 or 11';
        case 'positive':
            return typeof value === 'number' && Number.isInteger(value) && value > 0 ? undefined : 'must be a positive integer';
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merges target options; later options win (`undefined` values do not override). */
export function mergeTargetConfig<T extends TargetConfig>(...configs: Array<T | undefined>): T {
    const result: Record<string, unknown> = {};
    for (const config of configs) {
        for (const [key, value] of Object.entries(config ?? {})) {
            if (value !== undefined) {
                result[key] = value;
            }
        }
    }
    return result as T;
}

/** The effective options of a target for a model matched by the given entries (in configuration order). */
export function targetConfigForModel(config: GeneratorConfig, target: GeneratorTarget, entries: readonly ModelEntry[]): TargetConfig {
    return mergeTargetConfig<TargetConfig>(config[target], ...entries.map(entry => entry[target]));
}

export interface TargetFile {
    /** File name (no directory). */
    path: string;
    content: string;
}

export interface TargetGenerationResult {
    files: TargetFile[];
    diagnostics: Array<{ severity: 'error' | 'warning', message: string, line?: number }>;
}

/**
 * Generates the files of one target for a state machine with the options of a configuration:
 * runs the generator, renames the files to the configured extensions (adapting the includes of the
 * generated files) and prepends the license header. `licenseHeaderFile` must have been resolved
 * into `licenseHeader` by the caller. `outDir` is ignored (the paths are file names).
 */
export function generateTarget(machine: StateMachine, target: GeneratorTarget, options: TargetConfig): TargetGenerationResult {
    const result = target === 'cpp'
        ? generateCpp(machine, cppGeneratorOptions(options as CppTargetConfig))
        : generateC(machine, cGeneratorOptions(options as CTargetConfig));
    const diagnostics = result.diagnostics.map(d => ({
        severity: d.severity,
        message: d.message,
        line: d.node?.$cstNode ? d.node.$cstNode.range.start.line + 1 : undefined
    }));
    return { files: postProcessFiles(result.files, target, options), diagnostics };
}

function cppGeneratorOptions(options: CppTargetConfig) {
    return {
        namespace: options.namespace,
        className: options.className,
        standard: (Number(options.std ?? 17) === 11 ? 11 : 17) as 11 | 17,
        maxMicrosteps: options.maxMicrosteps
    };
}

function cGeneratorOptions(options: CTargetConfig) {
    return {
        prefix: options.prefix,
        typeName: options.typeName,
        stringCapacity: options.stringCapacity,
        queueCapacity: options.queueCapacity,
        maxMicrosteps: options.maxMicrosteps
    };
}

/** Renames generated files to the configured extensions, adapts their includes and adds the license header. */
export function postProcessFiles(files: readonly TargetFile[], target: GeneratorTarget, options: CommonTargetConfig): TargetFile[] {
    const headerExtension = options.headerExtension ?? '.h';
    const sourceExtension = options.sourceExtension ?? DEFAULT_SOURCE_EXTENSIONS[target];
    const renames = new Map<string, string>();
    for (const file of files) {
        const name = file.path.replace(/^.*[\\/]/, '');
        const match = /^(.*)\.(h|c|cpp)$/.exec(name);
        if (match) {
            renames.set(name, match[1] + (match[2] === 'h' ? headerExtension : sourceExtension));
        }
    }
    const license = options.licenseHeader !== undefined ? licenseComment(options.licenseHeader) : '';
    return files.map(file => {
        const name = file.path.replace(/^.*[\\/]/, '');
        let content = file.content;
        if (headerExtension !== '.h') {
            content = content.replace(/^(#\s*include\s+")([^"]+\.h)(")/gm,
                (all, start: string, header: string, end: string) => renames.has(header) ? start + renames.get(header) + end : all);
        }
        return { path: renames.get(name) ?? name, content: license + content };
    });
}

/**
 * The license header as comment followed by a newline: kept as it is if it already starts with
 * a comment (`//` or `/*`), otherwise wrapped in a block comment.
 */
export function licenseComment(text: string | readonly string[]): string {
    const lines = (typeof text === 'string' ? text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n') : [...text]);
    const joined = lines.join('\n');
    if (/^\s*(\/\/|\/\*)/.test(joined)) {
        return joined + '\n';
    }
    return ['/*', ...lines.map(line => line.trim() === '' ? ' *' : ` * ${line.replace(/\*\//g, '* /')}`), ' */', ''].join('\n');
}

/**
 * Converts a glob into a regular expression matching paths with `/` separators: `*` matches
 * within a path segment, `**` any number of segments, `?` one character.
 */
export function globToRegExp(glob: string): RegExp {
    let pattern = '';
    const text = glob.replace(/\\/g, '/');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '*') {
            if (text[i + 1] === '*') {
                const atSegmentStart = i === 0 || text[i - 1] === '/';
                i++;
                if (atSegmentStart && text[i + 1] === '/') {
                    pattern += '(?:[^/]*/)*';
                    i++;
                } else {
                    pattern += '.*';
                }
            } else {
                pattern += '[^/]*';
            }
        } else if (c === '?') {
            pattern += '[^/]';
        } else {
            pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${pattern}$`);
}

/** Whether a path contains glob characters. */
export function isGlob(path: string): boolean {
    return /[*?]/.test(path);
}
