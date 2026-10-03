import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { globToRegExp, isGlob, type CppTargetConfig, type GeneratorConfig, type ModelEntry } from 'devm-language';
// Node-only part of the language package (not exported from its index because the web app bundles the index)
import { loadGeneratorConfig, type GenerateDiagnostic } from '../../../../language/src/generator/generate-command.js';

/**
 * Resolution of the generator configuration of `Device Modeler: Generate C++` for a model.
 *
 * A generator configuration file (`devm.gen.json` or `<name>.devm.gen.json`, the format of
 * `devm generate`, see `packages/language/src/generator/config.ts`) in the directory of the model or
 * in a parent directory up to the workspace folder takes precedence if it lists the model (directly
 * or via a glob) and configures the `cpp` target. Otherwise the VS Code settings `hsm.cpp.*` are
 * used. The result is a configuration for `runGeneration` of the language package that contains only
 * this model, so the files are generated exactly as `devm generate` would generate them.
 */

/** The `hsm.cpp.*` settings. */
export interface CppSettings {
    /** Relative to the model file; absolute paths and `${workspaceFolder}` are supported; empty: the directory of the model. */
    outputDirectory: string;
    /** `null`: the namespace of the model; `''`: the global namespace. */
    namespace: string | null;
    standard: '11' | '17';
}

export interface ResolvedGeneration {
    /** Configuration for `runGeneration` (only the model, only the `cpp` target). */
    config: GeneratorConfig;
    /** Directory the relative paths of `config` are resolved against. */
    baseDir: string;
    /** The configuration file used (undefined: the settings). */
    configFile?: string;
    /** Problems of configuration files (warnings, or errors of files that were skipped). */
    diagnostics: GenerateDiagnostic[];
}

const CONFIG_FILE_PATTERN = /^(devm\.gen\.json|.+\.devm\.gen\.json)$/;

export function isGeneratorConfigFile(fileName: string): boolean {
    return CONFIG_FILE_PATTERN.test(fileName);
}

/**
 * The entries of a configuration that match the model (in configuration order). Paths and globs are
 * relative to the directory of the configuration file.
 */
export function matchingEntries(config: GeneratorConfig, configDir: string, modelPath: string): ModelEntry[] {
    const model = path.resolve(modelPath);
    const relative = path.relative(configDir, model).split(path.sep).join('/');
    return config.models.filter(entry => {
        const pattern = entry.path.replace(/\\/g, '/');
        if (!isGlob(pattern)) {
            return path.resolve(configDir, pattern) === model;
        }
        return !relative.startsWith('../') && globToRegExp(pattern.replace(/^\.\//, '')).test(relative);
    });
}

/** The generation of the model with the options of a configuration, or undefined if it does not configure C++ for the model. */
export function generationFromConfig(config: GeneratorConfig, configFile: string, modelPath: string): ResolvedGeneration | undefined {
    const baseDir = path.dirname(configFile);
    const entries = matchingEntries(config, baseDir, modelPath);
    if (entries.length === 0 || (config.cpp === undefined && !entries.some(entry => entry.cpp !== undefined))) {
        return undefined;
    }
    return {
        config: {
            models: entries.map(entry => ({ path: path.resolve(modelPath), cpp: entry.cpp })),
            cpp: config.cpp ?? {},
            writeOnlyIfChanged: config.writeOnlyIfChanged
        },
        baseDir,
        configFile,
        diagnostics: []
    };
}

/** The generation of the model with the `hsm.cpp.*` settings. */
export function generationFromSettings(modelPath: string, settings: CppSettings, workspaceFolder: string | undefined): ResolvedGeneration {
    const cpp: CppTargetConfig = {
        outDir: resolveOutputDirectory(modelPath, settings.outputDirectory, workspaceFolder),
        std: settings.standard === '11' ? 11 : 17
    };
    if (settings.namespace !== null && settings.namespace !== undefined) {
        cpp.namespace = settings.namespace;
    }
    return {
        config: { models: [{ path: path.resolve(modelPath) }], cpp, writeOnlyIfChanged: true },
        baseDir: path.dirname(path.resolve(modelPath)),
        diagnostics: []
    };
}

/** The output directory of the settings: relative to the model, absolute, or with `${workspaceFolder}`. */
export function resolveOutputDirectory(modelPath: string, setting: string, workspaceFolder: string | undefined): string {
    const modelDir = path.dirname(path.resolve(modelPath));
    let value = setting.trim();
    if (value === '') {
        return modelDir;
    }
    if (value.includes('${workspaceFolder}')) {
        value = value.split('${workspaceFolder}').join(workspaceFolder ?? modelDir);
    }
    return path.resolve(modelDir, value);
}

/**
 * Finds the configuration for the model: searches `devm.gen.json` / `*.devm.gen.json` from the
 * directory of the model up to the workspace folder (only the model directory without workspace
 * folder); the first file that configures C++ for the model wins. Falls back to the settings.
 * Configuration files with errors are skipped and reported in `diagnostics`.
 */
export async function resolveGeneration(modelPath: string, settings: CppSettings, workspaceFolder: string | undefined): Promise<ResolvedGeneration> {
    const diagnostics: GenerateDiagnostic[] = [];
    let directory = path.dirname(path.resolve(modelPath));
    const root = workspaceFolder ? path.resolve(workspaceFolder) : directory;
    while (isWithin(directory, root)) {
        let entries: string[] = [];
        try {
            entries = (await fs.readdir(directory)).filter(isGeneratorConfigFile).sort();
        } catch {
            // not readable: continue with the parent
        }
        for (const entry of entries) {
            const loaded = await loadGeneratorConfig(path.join(directory, entry));
            diagnostics.push(...loaded.diagnostics);
            const resolved = loaded.config && generationFromConfig(loaded.config, loaded.file, modelPath);
            if (resolved) {
                return { ...resolved, diagnostics };
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            break;
        }
        directory = parent;
    }
    return { ...generationFromSettings(modelPath, settings, workspaceFolder), diagnostics };
}

function isWithin(directory: string, root: string): boolean {
    const relative = path.relative(root, directory);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
