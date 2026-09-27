import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseGeneratorConfig } from 'hsm-language';
import {
    generationFromConfig, generationFromSettings, isGeneratorConfigFile, matchingEntries, resolveGeneration, resolveOutputDirectory, type CppSettings
} from '../../src/extension/logic/generator-config.js';
import { runGeneration } from '../../../language/src/generator/generate-command.js';

const settings: CppSettings = { outputDirectory: '', namespace: null, standard: '17' };
const MODEL = 'statemachine Lamp {\n    interface:\n        in event toggle\n    [*] -> Off\n    state Off\n    state On\n    Off -> On : toggle\n    On -> Off : toggle\n}\n';

function config(value: unknown) {
    const parsed = parseGeneratorConfig(value);
    expect(parsed.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    return parsed.config!;
}

describe('generator configuration files', () => {
    it('recognizes hsm.gen.json and <name>.hsm.gen.json', () => {
        expect(isGeneratorConfigFile('hsm.gen.json')).toBe(true);
        expect(isGeneratorConfigFile('firmware.hsm.gen.json')).toBe(true);
        expect(isGeneratorConfigFile('package.json')).toBe(false);
        expect(isGeneratorConfigFile('hsm.gen.json.bak')).toBe(false);
    });

    it('matches models by path and glob relative to the configuration', () => {
        const c = config({ models: ['models/*.hsm', { path: './legacy/door.hsm', cpp: { namespace: 'legacy' } }, 'other/**/*.hsm'], cpp: {} });
        const dir = path.resolve('/work');
        expect(matchingEntries(c, dir, '/work/models/lamp.hsm').map(e => e.path)).toEqual(['models/*.hsm']);
        expect(matchingEntries(c, dir, '/work/legacy/door.hsm').map(e => e.path)).toEqual(['./legacy/door.hsm']);
        expect(matchingEntries(c, dir, '/work/other/a/b/x.hsm').map(e => e.path)).toEqual(['other/**/*.hsm']);
        expect(matchingEntries(c, dir, '/work/models/sub/lamp.hsm')).toEqual([]);
        expect(matchingEntries(c, dir, '/elsewhere/models/lamp.hsm')).toEqual([]);
    });

    it('generates only the model with the merged options of its entries', () => {
        const c = config({ models: ['*.hsm', { path: 'door.hsm', cpp: { namespace: 'legacy' } }], cpp: { outDir: 'gen', std: 11 } });
        const resolved = generationFromConfig(c, path.resolve('/work/hsm.gen.json'), '/work/door.hsm')!;
        expect(resolved.baseDir).toBe(path.resolve('/work'));
        expect(resolved.config.models).toEqual([{ path: path.resolve('/work/door.hsm'), cpp: undefined }, { path: path.resolve('/work/door.hsm'), cpp: { namespace: 'legacy' } }]);
        expect(resolved.config.cpp).toEqual({ outDir: 'gen', std: 11 });
        expect(resolved.config.c).toBeUndefined();
    });

    it('ignores configurations without the model or without the C++ target', () => {
        expect(generationFromConfig(config({ models: ['a.hsm'], cpp: {} }), '/work/hsm.gen.json', '/work/b.hsm')).toBeUndefined();
        expect(generationFromConfig(config({ models: ['b.hsm'], c: {} }), '/work/hsm.gen.json', '/work/b.hsm')).toBeUndefined();
    });
});

describe('settings', () => {
    it('resolves the output directory relative to the model', () => {
        expect(resolveOutputDirectory('/w/models/a.hsm', '', '/w')).toBe(path.resolve('/w/models'));
        expect(resolveOutputDirectory('/w/models/a.hsm', 'gen', '/w')).toBe(path.resolve('/w/models/gen'));
        expect(resolveOutputDirectory('/w/models/a.hsm', '${workspaceFolder}/src-gen', '/w')).toBe(path.resolve('/w/src-gen'));
        expect(resolveOutputDirectory('/w/models/a.hsm', '/abs/out', '/w')).toBe(path.resolve('/abs/out'));
    });

    it('maps the settings to a configuration', () => {
        const resolved = generationFromSettings('/w/a.hsm', { outputDirectory: 'gen', namespace: 'app::sm', standard: '11' }, '/w');
        expect(resolved.config.cpp).toEqual({ outDir: path.resolve('/w/gen'), namespace: 'app::sm', std: 11 });
        expect(generationFromSettings('/w/a.hsm', settings, '/w').config.cpp?.namespace).toBeUndefined();
        expect(generationFromSettings('/w/a.hsm', { ...settings, namespace: '' }, '/w').config.cpp?.namespace).toBe('');
    });
});

describe('resolveGeneration', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-vscode-'));
        await fs.mkdir(path.join(dir, 'models'));
        await fs.writeFile(path.join(dir, 'models/lamp.hsm'), MODEL);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('falls back to the settings without configuration file', async () => {
        const resolved = await resolveGeneration(path.join(dir, 'models/lamp.hsm'), settings, dir);
        expect(resolved.configFile).toBeUndefined();
        expect(resolved.config.cpp?.outDir).toBe(path.join(dir, 'models'));
    });

    it('uses a configuration file in a parent directory and generates like hsm generate', async () => {
        await fs.writeFile(path.join(dir, 'hsm.gen.json'), JSON.stringify({
            models: ['models/*.hsm'], cpp: { outDir: 'src-gen', namespace: 'app', headerExtension: '.hpp', licenseHeader: 'Copyright ACME' }
        }));
        const model = path.join(dir, 'models/lamp.hsm');
        const resolved = await resolveGeneration(model, settings, dir);
        expect(resolved.configFile).toBe(path.join(dir, 'hsm.gen.json'));
        const result = await runGeneration({ config: resolved.config, baseDir: resolved.baseDir, targets: ['cpp'], mode: 'write' });
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(result.outputs.map(o => path.relative(dir, o.file)).sort()).toEqual(['src-gen/Lamp.cpp', 'src-gen/Lamp.hpp', 'src-gen/sc_statemachine.hpp']);
        const source = await fs.readFile(path.join(dir, 'src-gen/Lamp.cpp'), 'utf-8');
        expect(source).toContain('Copyright ACME');
        expect(source).toContain('#include "Lamp.hpp"');
        expect(source).toContain('namespace app');
    });

    it('skips configuration files with errors and reports them', async () => {
        await fs.writeFile(path.join(dir, 'models/hsm.gen.json'), '{ "models": ["*.hsm"], "cpp": { "std": 14 } }');
        const resolved = await resolveGeneration(path.join(dir, 'models/lamp.hsm'), settings, dir);
        expect(resolved.configFile).toBeUndefined();
        expect(resolved.diagnostics.some(d => d.severity === 'error' && d.file === path.join(dir, 'models/hsm.gen.json'))).toBe(true);
    });

    it('does not search above the workspace folder', async () => {
        await fs.writeFile(path.join(dir, 'hsm.gen.json'), JSON.stringify({ models: ['models/*.hsm'], cpp: {} }));
        const resolved = await resolveGeneration(path.join(dir, 'models/lamp.hsm'), settings, path.join(dir, 'models'));
        expect(resolved.configFile).toBeUndefined();
    });
});
