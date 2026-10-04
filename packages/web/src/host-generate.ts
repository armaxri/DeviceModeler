import {
    generateTarget, globToRegExp, isGlob, mergeTargetConfig, parseGeneratorConfig, parseHeaderConfig, resolvedImports,
    type CppHeaderSettings, type CppTargetConfig, type GeneratorConfig, type ModelEntry, type ParsedModel, type StateMachine
} from 'hsm-language';
import type { HostCppSettings, HostDocument } from './host.js';

/**
 * C++ generation of the embedded app (see host.ts): the generator of the language package runs in the
 * page, the host writes the files. The configuration is resolved like `HSM: Generate C++` of the VS Code
 * extension (packages/vscode/src/extension/logic/generator-config.ts): the nearest generator configuration
 * (`hsm.gen.json`, `*.hsm.gen.json`, from the directory of the model up to the root of the host) that lists
 * the model and configures C++ wins, otherwise the C++ settings of the host are used.
 *
 * All paths are relative to the root of the host (the Eclipse project) with `/` separators; the documents
 * of the page have the URIs `memory:///<path>`.
 */

export const HOST_FILE_BASE = 'memory:///';

export interface HostGeneration {
    /** Generated files (paths relative to the root of the host). Empty if there are errors. */
    files: Array<{ path: string, content: string }>;
    errors: string[];
    warnings: string[];
    /** The configuration file used, undefined: the settings of the host. */
    configFile?: string;
}

/**
 * The header settings of the nearest configuration with a `headers` block (include paths as URIs of
 * the page, relative to the configuration file).
 */
export function hostHeaderSettings(configs: HostDocument['configs']): CppHeaderSettings {
    for (const config of configs ?? []) {
        const headers = parseHeaderConfig(config.text);
        if (headers) {
            const dir = dirname(config.path);
            return {
                includePaths: (headers.includePaths ?? []).map(p => HOST_FILE_BASE + join(dir, p)).filter(uri => !uri.includes('/../') && !uri.endsWith('/..')),
                defines: headers.defines,
                dataModel: headers.dataModel
            };
        }
    }
    return {};
}

export async function generateCppForHost(parsed: ParsedModel, modelPath: string, document: HostDocument,
    readFile: (path: string) => Promise<string | undefined>): Promise<HostGeneration> {
    const result: HostGeneration = { files: [], errors: [], warnings: [] };
    const modelErrors = parsed.diagnostics.filter(d => d.severity === 1);
    if (parsed.hasSyntaxErrors || modelErrors.length > 0) {
        result.errors.push(`the model has ${modelErrors.length || 'syntax'} error${modelErrors.length === 1 ? '' : 's'}`);
        return result;
    }

    // configuration: nearest file listing the model, otherwise the settings of the host
    let options: CppTargetConfig | undefined;
    let baseDir = dirname(modelPath);
    for (const file of document.configs ?? []) {
        const parsedConfig = parseGeneratorConfig(file.text);
        for (const d of parsedConfig.diagnostics) {
            result.warnings.push(`${file.path}${d.pointer ? ` (${d.pointer})` : ''}: ${d.message}`);
        }
        const config = parsedConfig.config;
        if (!config) {
            continue;
        }
        const entries = matchingEntries(config, dirname(file.path), modelPath);
        if (entries.length > 0 && (config.cpp !== undefined || entries.some(entry => entry.cpp !== undefined))) {
            options = mergeTargetConfig<CppTargetConfig>(config.cpp ?? {}, ...entries.map(entry => entry.cpp));
            baseDir = dirname(file.path);
            result.configFile = file.path;
            break;
        }
    }
    options ??= optionsFromSettings(modelPath, document.cppSettings ?? {});

    if (options.licenseHeaderFile !== undefined) {
        const licensePath = join(baseDir, options.licenseHeaderFile);
        const text = isInside(licensePath) ? await readFile(licensePath) : undefined;
        if (text === undefined) {
            result.errors.push(`cannot read the license header file ${options.licenseHeaderFile}`);
            return result;
        }
        options = { ...options, licenseHeader: text, licenseHeaderFile: undefined };
    }
    const outDir = options.outDir !== undefined ? join(baseDir, options.outDir) : dirname(modelPath);
    if (!isInside(outDir)) {
        result.errors.push(`the output directory ${options.outDir} is outside of the project`);
        return result;
    }
    const includePaths = (hostHeaderSettings(document.configs).includePaths ?? []).map(uri => uri.substring(HOST_FILE_BASE.length));
    const generated = generateTarget(parsed.model, 'cpp', { ...options, outDir: undefined }, {
        headerInclude: header => headerInclude(parsed.model, header, modelPath, outDir, includePaths)
    });
    for (const d of generated.diagnostics) {
        (d.severity === 'error' ? result.errors : result.warnings).push(`${d.line !== undefined ? `line ${d.line}: ` : ''}${d.message}`);
    }
    if (result.errors.length === 0) {
        if (generated.files.length === 0) {
            result.errors.push('nothing generated');
        }
        result.files = generated.files.map(file => ({ path: join(outDir, file.path), content: file.content }));
    }
    return result;
}

function optionsFromSettings(modelPath: string, settings: HostCppSettings): CppTargetConfig {
    const modelDir = dirname(modelPath);
    let outDir = (settings.outputDirectory ?? '').trim();
    if (outDir.includes('${project}')) {
        // relative to the root: made relative to the model directory
        outDir = relative(modelDir, normalize(outDir.split('${project}').join('').replace(/^\/+/, '')));
    }
    const options: CppTargetConfig = { std: settings.standard === '11' ? 11 : 17 };
    if (outDir !== '') {
        options.outDir = outDir;
    }
    if (settings.namespace !== null && settings.namespace !== undefined) {
        options.namespace = settings.namespace;
    }
    return options;
}

/** The entries of a configuration that match the model (paths and globs relative to the configuration file). */
function matchingEntries(config: GeneratorConfig, configDir: string, modelPath: string): ModelEntry[] {
    const relativePath = relative(configDir, modelPath);
    return config.models.filter(entry => {
        const pattern = entry.path.replace(/\\/g, '/');
        if (!isGlob(pattern)) {
            return join(configDir, pattern) === modelPath;
        }
        return !relativePath.startsWith('../') && globToRegExp(pattern.replace(/^\.\//, '')).test(relativePath);
    });
}

/** The `#include` of an imported header, like `hsm generate` (generate-command.ts). */
function headerInclude(machine: StateMachine, header: { path: string }, modelPath: string, outDir: string, includePaths: string[]): string | undefined {
    const resolved = resolvedImports(machine).find(i => i.kind === 'header' && i.path === header.path);
    const found = resolved?.header?.found && resolved.uri?.scheme === 'memory' ? resolved.uri.path.replace(/^\/+/, '') : undefined;
    if (!found || outDir === dirname(modelPath)) {
        return undefined;
    }
    if (includePaths.some(dir => join(dir, header.path) === found)) {
        return undefined;
    }
    return relative(outDir, found);
}

// ---------------------------------------------------------------------------------------------------------
// Paths relative to the root ('' is the root)

export function normalize(path: string): string {
    const result: string[] = [];
    for (const segment of path.replace(/\\/g, '/').split('/')) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..' && result.length > 0 && result[result.length - 1] !== '..') {
            result.pop();
        } else {
            result.push(segment);
        }
    }
    return result.join('/');
}

export function dirname(path: string): string {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.substring(0, index);
}

export function join(dir: string, path: string): string {
    return normalize(path.startsWith('/') ? path : `${dir}/${path}`);
}

function relative(from: string, to: string): string {
    const a = normalize(from).split('/').filter(s => s !== '');
    const b = normalize(to).split('/').filter(s => s !== '');
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) {
        common++;
    }
    return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}

function isInside(path: string): boolean {
    return path !== '..' && !path.startsWith('../');
}
