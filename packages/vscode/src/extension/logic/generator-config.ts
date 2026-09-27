import * as path from 'node:path';

/**
 * Resolution of the options of `HSM: Generate C++` for a model.
 *
 * A generator configuration file next to the model (or in a parent directory up to the workspace
 * folder) takes precedence over the VS Code settings `hsm.cpp.*`. Recognized file names:
 * `hsm.gen.json`, `<name>.hsm.gen.json` and `<name>.hsmgen.json`. The format follows the generator
 * configuration of the language package (`{ "models": [...], "cpp": { "outDir", "namespace", "className", "std" } }`,
 * paths relative to the configuration file, per-model options in model entries). This module is the
 * single integration point: once the language package exports its configuration loader, only
 * {@link resolveCppConfig} has to delegate to it.
 */

/** The `hsm.cpp.*` settings. */
export interface CppSettings {
    /** Relative to the model file; absolute paths and `${workspaceFolder}` are supported; empty: the directory of the model. */
    outputDirectory: string;
    /** `null`: the namespace of the model; `''`: the global namespace. */
    namespace: string | null;
    standard: '11' | '17';
}

export interface ResolvedCppConfig {
    /** Absolute output directory. */
    outDir: string;
    namespace?: string;
    className?: string;
    standard: 11 | 17;
    /** The configuration file used, if any (otherwise the settings). */
    configFile?: string;
    /** Problems of the configuration file (e.g. options not supported here). */
    warnings: string[];
}

/** File system access needed to find configuration files (injected for tests). */
export interface ConfigFileSystem {
    readDirectory(directory: string): Promise<string[]>;
    readFile(file: string): Promise<string>;
}

const CONFIG_FILE_PATTERN = /^(hsm\.gen\.json|.+\.hsm\.gen\.json|.+\.hsmgen\.json)$/;

/** Options of the `cpp` target handled by the extension; others are reported as warnings. */
const SUPPORTED_CPP_OPTIONS = new Set(['outDir', 'namespace', 'className', 'std', 'standard']);

interface CppOptions {
    outDir?: unknown;
    namespace?: unknown;
    className?: unknown;
    std?: unknown;
    standard?: unknown;
    [key: string]: unknown;
}

export function isGeneratorConfigFile(fileName: string): boolean {
    return CONFIG_FILE_PATTERN.test(fileName);
}

export async function resolveCppConfig(modelPath: string, settings: CppSettings, workspaceFolder: string | undefined, fs: ConfigFileSystem): Promise<ResolvedCppConfig> {
    const found = await findConfigFor(modelPath, workspaceFolder, fs);
    if (found) {
        return found;
    }
    return {
        outDir: resolveOutputDirectory(modelPath, settings.outputDirectory, workspaceFolder),
        namespace: settings.namespace ?? undefined,
        standard: settings.standard === '11' ? 11 : 17,
        warnings: []
    };
}

/** The output directory of the settings: relative to the model, absolute, or with `${workspaceFolder}`. */
export function resolveOutputDirectory(modelPath: string, setting: string, workspaceFolder: string | undefined): string {
    const modelDir = path.dirname(modelPath);
    let value = setting.trim();
    if (value === '') {
        return modelDir;
    }
    if (value.includes('${workspaceFolder}')) {
        value = value.split('${workspaceFolder}').join(workspaceFolder ?? modelDir);
    }
    return path.resolve(modelDir, value);
}

/** Searches configuration files from the directory of the model up to the workspace folder. */
async function findConfigFor(modelPath: string, workspaceFolder: string | undefined, fs: ConfigFileSystem): Promise<ResolvedCppConfig | undefined> {
    let directory = path.dirname(modelPath);
    const root = workspaceFolder ? path.resolve(workspaceFolder) : directory;
    for (;;) {
        let entries: string[] = [];
        try {
            entries = (await fs.readDirectory(directory)).filter(isGeneratorConfigFile).sort();
        } catch {
            // not readable: continue with the parent
        }
        for (const entry of entries) {
            const file = path.join(directory, entry);
            const resolved = configForModel(file, await fs.readFile(file), modelPath);
            if (resolved) {
                return resolved;
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory || !isWithin(directory, root) || path.resolve(directory) === root) {
            return undefined;
        }
        directory = parent;
    }
}

function isWithin(directory: string, root: string): boolean {
    const relative = path.relative(root, directory);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The C++ options of the configuration file for the model, or undefined if the file does not
 * configure the model (not listed in `models`) or has no `cpp` target.
 */
export function configForModel(configFile: string, text: string, modelPath: string): ResolvedCppConfig | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error(`${configFile}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(value)) {
        throw new Error(`${configFile}: the configuration must be a JSON object`);
    }
    const configDir = path.dirname(configFile);
    const modelEntries: CppOptions[] = [];
    if (Array.isArray(value.models)) {
        const relative = path.relative(configDir, modelPath).split(path.sep).join('/');
        let matched = false;
        for (const entry of value.models) {
            const pattern = typeof entry === 'string' ? entry : isObject(entry) && typeof entry.path === 'string' ? entry.path : undefined;
            if (pattern !== undefined && globToRegExp(pattern.replace(/^\.\//, '')).test(relative)) {
                matched = true;
                if (isObject(entry) && isObject(entry.cpp)) {
                    modelEntries.push(entry.cpp);
                }
            }
        }
        if (!matched) {
            return undefined;
        }
    }
    if (!isObject(value.cpp) && modelEntries.length === 0) {
        return undefined;
    }
    const options: CppOptions = Object.assign({}, isObject(value.cpp) ? value.cpp : {}, ...modelEntries);
    const warnings = Object.keys(options).filter(key => !SUPPORTED_CPP_OPTIONS.has(key))
        .map(key => `${path.basename(configFile)}: the option 'cpp.${key}' is not supported by the VS Code extension yet and is ignored (use 'hsm generate' on the command line).`);
    const std = options.std ?? options.standard;
    return {
        outDir: typeof options.outDir === 'string' ? path.resolve(configDir, options.outDir) : path.dirname(modelPath),
        namespace: typeof options.namespace === 'string' ? options.namespace : undefined,
        className: typeof options.className === 'string' ? options.className : undefined,
        standard: Number(std) === 11 ? 11 : 17,
        configFile,
        warnings
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `*` matches within a path segment, `**` any number of segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
    let pattern = '';
    const text = glob.replace(/\\/g, '/');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '*') {
            if (text[i + 1] === '*') {
                const segmentStart = i === 0 || text[i - 1] === '/';
                i++;
                if (segmentStart && text[i + 1] === '/') {
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
