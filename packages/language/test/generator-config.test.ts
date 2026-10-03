import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    CONFIG_PROPERTIES, HEADER_PROPERTIES, parseHeaderConfig, globToRegExp, licenseComment, parseGeneratorConfig, postProcessFiles, TARGET_PROPERTIES, targetConfigForModel
} from '../src/generator/config.js';
import { expandModelPath, loadGeneratorConfig, runGenerateCommand, runGeneration } from '../src/generator/generate-command.js';
import { example } from './helpers.js';

describe('parseGeneratorConfig', () => {

    test('accepts a complete configuration', () => {
        const { config, diagnostics } = parseGeneratorConfig(JSON.stringify({
            $schema: './hsm-gen.schema.json',
            models: ['models/*.devm', { path: 'door.devm', cpp: { className: 'MyDoor' } }],
            cpp: { outDir: 'gen', namespace: 'app::sm', std: 11, headerExtension: '.hpp', sourceExtension: '.cc', licenseHeader: ['a', 'b'] },
            c: { outDir: 'gen-c', stringCapacity: 32 },
            writeOnlyIfChanged: false
        }));
        expect(diagnostics).toEqual([]);
        expect(config?.models).toEqual([{ path: 'models/*.devm' }, { path: 'door.devm', cpp: { className: 'MyDoor' } }]);
        expect(config?.cpp?.std).toBe(11);
        expect(config?.writeOnlyIfChanged).toBe(false);
        expect(targetConfigForModel(config!, 'cpp', [config!.models[1]])).toMatchObject({ namespace: 'app::sm', className: 'MyDoor' });
    });

    test('defaults: writeOnlyIfChanged', () => {
        expect(parseGeneratorConfig({ models: ['a.devm'], cpp: {} }).config).toEqual({ models: [{ path: 'a.devm' }], cpp: {}, writeOnlyIfChanged: true });
    });

    test('reports errors with JSON pointers', () => {
        const messages = (value: unknown) => parseGeneratorConfig(value).diagnostics.map(d => `${d.pointer} ${d.message}`);
        expect(messages('{')[0]).toMatch(/^ invalid JSON/);
        expect(messages([])).toEqual([' the configuration must be a JSON object']);
        expect(messages({ cpp: {} })).toEqual([`/models 'models' must be a non-empty array of paths / globs of .devm files`]);
        expect(messages({ models: ['a.devm'] })).toEqual([' no target configured: add "cpp": {} and / or "c": {}']);
        expect(messages({ models: ['a.devm'], cpp: { std: 14, headerExtension: 'hpp', nameSpace: 'x' }, extra: 1 })).toEqual([
            `/extra unknown property 'extra' (expected one of models, cpp, c, headers, writeOnlyIfChanged)`,
            `/cpp/std 'std' must be 17 or 11`,
            `/cpp/headerExtension 'headerExtension' must be a file extension starting with a dot, e.g. '.hpp'`,
            `/cpp/nameSpace unknown option 'nameSpace' of target 'cpp' (expected one of outDir, headerExtension, sourceExtension, licenseHeader, licenseHeaderFile, maxMicrosteps, namespace, className, std)`
        ]);
        expect(messages({ models: [{ file: 'a.devm' }, 3], c: { prefix: 'a-b', licenseHeader: 'x', licenseHeaderFile: 'y' } })).toEqual([
            `/models/0/file unknown property 'file' of a model entry (expected path, cpp, c)`,
            `/models/0/path a model entry needs a 'path' (path or glob of .devm files)`,
            '/models/1 a model entry must be a path / glob or an object { "path": ..., "cpp": {...}, "c": {...} }',
            `/c/prefix 'prefix' must be an identifier`,
            `/c use either 'licenseHeader' or 'licenseHeaderFile', not both`
        ]);
    });

    test('the JSON schema declares the same properties as the validator', () => {
        const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schemas/hsm-gen.schema.json'), 'utf-8'));
        expect(Object.keys(schema.properties).sort()).toEqual([...CONFIG_PROPERTIES].sort());
        for (const target of ['cpp', 'c'] as const) {
            expect(Object.keys(schema.definitions[target].properties).sort()).toEqual(Object.keys(TARGET_PROPERTIES[target]).sort());
        }
        expect(Object.keys(schema.properties.models.items.anyOf[1].properties).sort()).toEqual(['c', 'cpp', 'path']);
        expect(Object.keys(schema.definitions.headers.properties).sort()).toEqual([...HEADER_PROPERTIES].sort());
    });

    test('the headers block (C/C++ header imports)', () => {
        const parsed = parseGeneratorConfig({
            models: ['a.devm'], cpp: {},
            headers: { includePaths: ['include'], defines: { USE_CAN: '1', LEVEL: 2 }, dataModel: { longBits: 32, pointerBits: 32, charSigned: false } }
        });
        expect(parsed.diagnostics).toEqual([]);
        expect(parsed.config?.headers).toEqual({ includePaths: ['include'], defines: { USE_CAN: '1', LEVEL: '2' }, dataModel: { longBits: 32, pointerBits: 32, charSigned: false } });
        const invalid = parseGeneratorConfig({ models: ['a.devm'], cpp: {}, headers: { includePaths: 'include', dataModel: { longBits: 16 }, x: 1 } });
        expect(invalid.diagnostics.map(d => `${d.pointer}: ${d.message}`)).toEqual([
            "/headers/includePaths: 'includePaths' must be an array of directories",
            "/headers/dataModel/longBits: 'longBits' must be 32 or 64",
            "/headers/x: unknown property 'x' of 'headers' (expected includePaths, defines, dataModel)"
        ]);
        expect(parseHeaderConfig('{ "headers": { "includePaths": ["inc"] } }')).toEqual({ includePaths: ['inc'] });
        expect(parseHeaderConfig('{ "models": [] }')).toBeUndefined();
    });
});

describe('file names, includes and license headers', () => {

    const files = [
        { path: 'sc_statemachine.h', content: '#ifndef SC_H_\n' },
        { path: 'Door.h', content: '#include <array>\n#include "sc_statemachine.h"\n#include "other.h"\n' },
        { path: 'Door.cpp', content: '#include "Door.h"\n' }
    ];

    test('renames files and adapts the includes', () => {
        expect(postProcessFiles(files, 'cpp', { headerExtension: '.hpp', sourceExtension: '.cc' })).toEqual([
            { path: 'sc_statemachine.hpp', content: '#ifndef SC_H_\n' },
            { path: 'Door.hpp', content: '#include <array>\n#include "sc_statemachine.hpp"\n#include "other.h"\n' },
            { path: 'Door.cc', content: '#include "Door.hpp"\n' }
        ]);
        expect(postProcessFiles(files, 'cpp', {})).toEqual(files);
    });

    test('license headers', () => {
        expect(licenseComment('Copyright ACME\n\nMIT\n')).toBe('/*\n * Copyright ACME\n *\n * MIT\n */\n');
        expect(licenseComment(['// Copyright ACME', '// MIT'])).toBe('// Copyright ACME\n// MIT\n');
        expect(postProcessFiles([files[2]], 'cpp', { licenseHeader: 'L' })[0].content).toBe('/*\n * L\n */\n#include "Door.h"\n');
    });

    test('globs', () => {
        const matches = (glob: string, file: string) => globToRegExp(glob).test(file);
        expect(matches('*.devm', 'a.devm')).toBe(true);
        expect(matches('*.devm', 'x/a.devm')).toBe(false);
        expect(matches('**/*.devm', 'a.devm')).toBe(true);
        expect(matches('**/*.devm', 'x/y/a.devm')).toBe(true);
        expect(matches('x/**/a?.devm', 'x/ab.devm')).toBe(true);
        expect(matches('x/**/a?.devm', 'x/y/abc.devm')).toBe(false);
        expect(matches('a.devm', 'aXhsm')).toBe(false);
    });
});

describe('runGeneration / devm generate', () => {

    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-gen-'));
        fs.mkdirSync(path.join(dir, 'models/sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'models/door.devm'), example('door.devm'));
        fs.writeFileSync(path.join(dir, 'models/sub/keyboard.devm'), example('keyboard.devm'));
        fs.writeFileSync(path.join(dir, 'LICENSE.txt'), 'Copyright ACME\n');
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    const writeConfig = (config: unknown) => fs.writeFileSync(path.join(dir, 'hsm.gen.json'), JSON.stringify(config));

    test('expands globs', async () => {
        expect(await expandModelPath(dir, 'models/**/*.devm')).toEqual([path.join(dir, 'models/door.devm'), path.join(dir, 'models/sub/keyboard.devm')]);
        expect(await expandModelPath(dir, 'models/*.devm')).toEqual([path.join(dir, 'models/door.devm')]);
        expect(await expandModelPath(dir, 'models/missing.devm')).toEqual([]);
    });

    test('writes only changed files and checks them', async () => {
        writeConfig({ models: ['models/**/*.devm'], cpp: { outDir: 'gen', namespace: 'app', licenseHeaderFile: 'LICENSE.txt' }, c: { outDir: 'gen-c' } });
        const loaded = await loadGeneratorConfig(path.join(dir, 'hsm.gen.json'));
        expect(loaded.diagnostics).toEqual([]);
        const request = { config: loaded.config!, baseDir: dir };
        const first = await runGeneration({ ...request, mode: 'write' });
        expect(first.diagnostics).toEqual([]);
        expect(first.outputs.map(o => `${path.relative(dir, o.file)} ${o.status}`)).toEqual([
            'gen/sc_statemachine.h written', 'gen/Door.h written', 'gen/Door.cpp written',
            'gen-c/sc_types.h written', 'gen-c/door.h written', 'gen-c/door.c written',
            'gen/Keyboard.h written', 'gen/Keyboard.cpp written',
            'gen-c/keyboard.h written', 'gen-c/keyboard.c written'
        ]);
        expect(fs.readFileSync(path.join(dir, 'gen/Door.h'), 'utf-8')).toMatch(/^\/\*\n \* Copyright ACME\n \*\/\n\/\/ Generated by devm/);
        expect(fs.readFileSync(path.join(dir, 'gen/Door.h'), 'utf-8')).toContain('namespace app {');

        const doorHeader = path.join(dir, 'gen/Door.h');
        const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
        fs.utimesSync(doorHeader, past, past);
        const second = await runGeneration({ ...request, mode: 'write' });
        expect(second.outputs.every(o => o.status === 'unchanged')).toBe(true);
        expect(Math.round(fs.statSync(doorHeader).mtimeMs)).toBe(past.getTime());

        expect((await runGeneration({ ...request, mode: 'check' })).outputs.every(o => o.status === 'up-to-date')).toBe(true);
        fs.writeFileSync(path.join(dir, 'models/door.devm'), example('door.devm').replace(/statemachine Door/, 'statemachine Door2'));
        fs.rmSync(path.join(dir, 'gen/Keyboard.cpp'));
        const check = await runGeneration({ ...request, mode: 'check' });
        expect(check.outputs.filter(o => o.status !== 'up-to-date').map(o => `${path.relative(dir, o.file)} ${o.status}`)).toEqual([
            'gen/Door2.h missing', 'gen/Door2.cpp missing', 'gen-c/door2.h missing', 'gen-c/door2.c missing', 'gen/Keyboard.cpp missing'
        ]);
    });

    test('reports conflicts, unmatched globs and model errors without writing', async () => {
        fs.writeFileSync(path.join(dir, 'models/broken.devm'), 'statemachine Broken { [*] -> Missing }');
        writeConfig({ models: ['models/*.devm', 'nothing/*.devm', { path: 'models/sub/keyboard.devm', cpp: { className: 'Door' } }], cpp: { outDir: 'gen' } });
        const loaded = await loadGeneratorConfig(path.join(dir, 'hsm.gen.json'));
        const result = await runGeneration({ config: loaded.config!, baseDir: dir, mode: 'write' });
        const messages = result.diagnostics.map(d => `${d.file ? path.relative(dir, d.file) : ''}: ${d.message}`);
        expect(messages).toContainEqual(`: 'nothing/*.devm' matches no model`);
        expect(messages.some(m => m.startsWith('models/broken.devm: ') && m.includes('Missing'))).toBe(true);
        expect(messages.some(m => m.startsWith('models/sub/keyboard.devm: ') && m.includes('Door.h is generated with different contents'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'gen'))).toBe(false);
    });

    test('command line: --list-outputs, --check and --outputs-file', async () => {
        writeConfig({ models: ['models/door.devm'], cpp: { outDir: 'gen', headerExtension: '.hpp' } });
        const log: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line: string) => log.push(line));
        vi.spyOn(console, 'error').mockImplementation((line: string) => log.push(`E ${line}`));
        const config = path.join(dir, 'hsm.gen.json');
        expect(await runGenerateCommand(undefined, [], { config, listOutputs: true })).toBe(0);
        expect(log.splice(0)).toEqual(['sc_statemachine.hpp', 'Door.hpp', 'Door.cpp'].map(f => path.join(dir, 'gen', f).replace(/\\/g, '/')));
        expect(await runGenerateCommand(undefined, [], { config, check: true })).toBe(1);
        const outputsFile = path.join(dir, 'outputs.txt');
        fs.writeFileSync(outputsFile, ['sc_statemachine.hpp', 'Door.hpp', 'Door.cpp'].map(f => path.join(dir, 'gen', f)).join('\n'));
        expect(await runGenerateCommand(undefined, [], { config, outputsFile })).toBe(0);
        expect(await runGenerateCommand(undefined, [], { config, check: true })).toBe(0);
        // a target and files: the models of the configuration are replaced, the options kept
        expect(await runGenerateCommand('cpp', [path.join(dir, 'models/sub/keyboard.devm')], { config, outputsFile, namespace: 'kb' })).toBe(1);
        expect(fs.readFileSync(path.join(dir, 'gen/Keyboard.hpp'), 'utf-8')).toContain('namespace kb {');
        expect(fs.readFileSync(outputsFile, 'utf-8')).toContain('/gen/Keyboard.cpp\n');
        log.length = 0;
        expect(await runGenerateCommand('java', [], {})).toBe(1);
        expect(log).toEqual([`E Unknown target 'java' (supported: cpp, c)`]);
    });
});
