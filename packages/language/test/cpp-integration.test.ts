import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { errors, parse, warnings } from './helpers.js';
import { formatValue, StatechartInterpreter } from '../src/simulation/index.js';
import { HsmTestWorkspace } from '../src/testing/index.js';
import { cppCompletionItems, cppDefinition, cppHover } from '../src/lsp/cpp-lsp.js';
import { cliHeaderSettings, installNodeHeaderSupport } from '../src/node/cpp-headers-node.js';
import { createHsmServices } from '../src/hsm-module.js';
import { HsmModelLoader } from '../src/hsm-document.js';
import { storageOfTypeReference } from '../src/cpp-storage.js';
import type { VariableDeclaration } from '../src/generated/ast.js';

const MOTOR_TYPES = fs.readFileSync(path.resolve(__dirname, 'cpp-header/motor_types.h'), 'utf-8');

function model(body: string, header = 'motor_types.h'): string {
    return `statemachine M {\n    import "${header}"\n${body}\n}`;
}

describe('C++ header imports: validation', () => {
    test('types, enumerators, constants and members', async () => {
        const parsed = await parse(model(`
    interface:
        in event moveTo : motor::Position
        in event setMode : motor::Mode
        var mode : motor::Mode = motor::Mode::Off
        var target : motor::Position = motor::kParkPosition
        var speed : motor::Rpm = motor::kMaxSpeed
        var small : uint8_t = 7
        var limits : motor::Limits
    [*] -> Idle
    state Idle
    state Moving
    Idle -> Moving : moveTo [valueof(moveTo).x <= motor::kMaxSpeed] / target = valueof(moveTo); target.y = 3; limits.home.z = target.x
    Moving -> Idle : setMode [valueof(setMode) == motor::Mode::Off] / mode = valueof(setMode); speed = limits.gains[1]; small = motor::kMask
`), { 'motor_types.h': MOTOR_TYPES });
        expect(parsed.hasSyntaxErrors).toBe(false);
        expect(errors(parsed)).toEqual([]);
    });

    test('type errors', async () => {
        const parsed = await parse(model(`
    interface:
        var mode : motor::Mode = 1
        var pos : motor::Position
        var n : integer
        var small : uint8_t = 300
    [*] -> Idle
    state Idle
    Idle -> Idle : [mode == 1 || pos == pos] / n = mode; n = pos.q; n = motor::kNope; mode = motor::Mode::Slow as integer
`), { 'motor_types.h': MOTOR_TYPES });
        expect(errors(parsed)).toEqual([
            "Type mismatch: the initial value of type integer cannot be assigned to 'mode' of type motor::Mode.",
            'Cannot compare a value of type motor::Mode with a value of type integer.',
            'Cannot compare a value of type motor::Position with a value of type motor::Position.',
            "Type mismatch: a value of type motor::Mode cannot be assigned to 'n' of type integer.",
            "Cannot access 'q' of 'pos': 'motor::Position' has no member 'q' (members: x, y, z).",
            "Unknown C++ name 'motor::kNope': it is not declared in the imported headers.",
            "Type mismatch: a value of type integer cannot be assigned to 'mode' of type motor::Mode."
        ]);
        expect(warnings(parsed), JSON.stringify(parsed.diagnostics.map(d => d.message))).toContain("The value 300 is out of the range of uint8_t (0..255) of 'small'; it is converted to 44.");
    });

    test('missing header', async () => {
        const parsed = await parse(model('    [*] -> A\n    state A', 'nope.h'));
        expect(errors(parsed)[0]).toMatch(/^Cannot resolve the import 'nope.h': the header was not found/);
    });
});

const CONTROLLER = `statemachine Controller {
    import "motor_types.h"
    interface:
        in event moveTo : motor::Position
        in event setMode : motor::Mode
        out event arrived : motor::Position
        var mode : motor::Mode = motor::kDefaultMode
        var target : motor::Position
        var flags : integer
        operation measure() : motor::Position
    [*] -> Idle
    state Idle
    state Moving
    Idle -> Moving : moveTo [valueof(moveTo).x <= motor::kMaxSpeed] / target = valueof(moveTo); flags = motor::kStall | motor::kOverCurrent
    Moving -> Idle : setMode [valueof(setMode) == motor::Mode::Off] / mode = valueof(setMode); target = measure(); raise arrived : target
}`;

describe('C++ header imports: interpreter and test language', () => {
    test('host values of enum and struct variables', async () => {
        const parsed = await parse(CONTROLLER, { 'motor_types.h': MOTOR_TYPES });
        expect(errors(parsed)).toEqual([]);
        const events: string[] = [];
        const sim = new StatechartInterpreter(parsed.model, {
            operations: { measure: () => ({ x: 7, z: 9 }) },
            onOutEvent: event => events.push(event.text)
        });
        sim.enter();
        expect(sim.getVariable('mode')).toBe('motor::Mode::Slow');
        expect(sim.getVariable('target')).toEqual({ x: 0, y: 0, z: 0 });
        sim.raise('moveTo', { x: 100, y: -50 });
        sim.runCycle();
        expect(sim.getVariable('target')).toEqual({ x: 100, y: -50, z: 0 });
        expect(sim.getVariable('flags')).toBe(5);
        expect(formatValue(sim.getValue('target'))).toBe('{x: 100, y: -50, z: 0}');
        sim.raise('setMode', 0);
        sim.runCycle();
        expect(sim.getVariable('mode')).toBe('motor::Mode::Off');
        expect(events).toEqual(['arrived({x: 7, y: 0, z: 9})']);
        expect(() => sim.setVariable('mode', 'Turbo')).toThrow(/'Turbo' is not an enumerator of motor::Mode \(Off, Slow, Fast, Boost\)/);
        expect(() => sim.setVariable('target', { w: 1 })).toThrow(/motor::Position has no member 'w'/);
    });

    test('unit tests assert enum values and mock operations returning structs', async () => {
        const workspace = new HsmTestWorkspace();
        const documents = await workspace.load([
            { uri: 'memory:///cpp/motor_types.h', text: MOTOR_TYPES },
            { uri: 'memory:///cpp/controller.devm', text: CONTROLLER },
            {
                uri: 'memory:///cpp/controller.devmtest', text: `testclass ControllerTest for statemachine Controller {
    @Test
    operation moves() {
        enter
        assert mode == motor::Mode::Slow
        var p : motor::Position = motor::kParkPosition
        p.z = 3
        raise moveTo : p
        proceed 1 cycle
        assert active(Moving)
        assert target.x == 100 && target.z == 3
        mock measure returns (motor::kOrigin)
        raise setMode : motor::Mode::Off
        proceed 1 cycle
        assert mode == motor::Mode::Off message "mode"
        assert target.y == 0
        assert called measure
    }
}`
            }
        ]);
        for (const loaded of documents) {
            expect(loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message), loaded.uri).toEqual([]);
        }
        const results = workspace.runDocuments(documents);
        expect(results.map(r => [r.name, r.status, r.message])).toEqual([['moves', 'passed', undefined]]);
    });
});

describe('C++ header imports: language server features', () => {
    async function controller() {
        const parsed = await parse(CONTROLLER, { 'motor_types.h': MOTOR_TYPES });
        expect(errors(parsed)).toEqual([]);
        return parsed.document;
    }

    /** The offset of the `occurrence`-th match of `text` plus `delta`. */
    function offsetOf(document: Awaited<ReturnType<typeof controller>>, text: string, delta = 0, occurrence = 0): number {
        const content = document.textDocument.getText();
        let offset = -1;
        for (let i = 0; i <= occurrence; i++) {
            offset = content.indexOf(text, offset + 1);
        }
        expect(offset).toBeGreaterThanOrEqual(0);
        return offset + delta;
    }

    test('hover shows the declaration, value and documentation of the header', async () => {
        const document = await controller();
        expect(cppHover(document, offsetOf(document, 'motor::Mode::Off', 13))).toContain('motor::Mode::Off = 0');
        const mode = cppHover(document, offsetOf(document, 'motor::Mode = motor::kDefaultMode', 8))!;
        expect(mode).toContain('enum class motor::Mode');
        expect(mode).toContain('Operating mode of the motor.');
        expect(cppHover(document, offsetOf(document, 'motor::kMaxSpeed', 8))).toContain('constexpr std::int32_t motor::kMaxSpeed = 6000');
        expect(cppHover(document, offsetOf(document, 'valueof(moveTo).x', 16))).toContain('x coordinate');
        expect(cppHover(document, offsetOf(document, 'motor::Mode', 2))).toContain('namespace motor');
        expect(cppHover(document, offsetOf(document, '"motor_types.h"', 2))).toContain('C/C++ header');
    });

    test('go to definition leads into the header', async () => {
        const document = await controller();
        const location = cppDefinition(document, offsetOf(document, 'motor::Position', 9))!;
        expect(location.uri).toMatch(/motor_types\.h$/);
        const line = MOTOR_TYPES.split('\n')[location.selection.start.line];
        expect(line).toContain('struct Position');
    });

    test('completion of C++ names and struct members', async () => {
        const document = await controller();
        const names = cppCompletionItems(document, offsetOf(document, 'motor::kMaxSpeed', 7))!.map(item => item.label);
        expect(names).toEqual(expect.arrayContaining(['Mode', 'Position', 'kMaxSpeed', 'kParkPosition', 'detail']));
        const enumerators = cppCompletionItems(document, offsetOf(document, 'motor::Mode::Off', 13))!.map(item => item.label);
        expect(enumerators).toEqual(['Off', 'Slow', 'Fast', 'Boost']);
        const members = cppCompletionItems(document, offsetOf(document, 'valueof(moveTo).x', 16));
        expect(members).toBeUndefined(); // `valueof(e).` is completed by the default provider
        const text = document.textDocument.getText();
        const parsed = await parse(text.replace('target = measure();', 'target = measure(); target.'), { 'motor_types.h': MOTOR_TYPES });
        const at = parsed.document.textDocument.getText().indexOf('target. ') + 7;
        expect(cppCompletionItems(parsed.document, at)!.map(item => item.label)).toEqual(['x', 'y', 'z']);
    });
});

describe('C++ header imports: Node.js hosts', () => {
    test('headers are read from the file system with the settings of the nearest hsm.gen.json', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-headers-'));
        try {
            fs.mkdirSync(path.join(dir, 'models'));
            fs.mkdirSync(path.join(dir, 'include/app'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'include/app/config.h'), '#if WIDE\nusing Count = long;\n#else\nusing Count = short;\n#endif\nnamespace app { constexpr int kLimit = LIMIT; }\n');
            fs.writeFileSync(path.join(dir, 'hsm.gen.json'), JSON.stringify({
                models: ['models/*.devm'], cpp: {}, headers: { includePaths: ['include'], defines: { WIDE: '1', LIMIT: '7' }, dataModel: { longBits: 32 } }
            }));
            const model = path.join(dir, 'models/m.devm');
            fs.writeFileSync(model, 'statemachine M {\n    import "app/config.h"\n    interface:\n        var c : ::Count = app::kLimit\n    [*] -> A\n    state A\n}\n');
            const services = createHsmServices(NodeFileSystem);
            installNodeHeaderSupport(services.shared, { settings: cliHeaderSettings({ define: ['LIMIT=300000'] }) });
            const loader = new HsmModelLoader(services);
            const parsed = await loader.load(fs.readFileSync(model, 'utf-8'), pathToFileURL(model).toString());
            expect(errors(parsed)).toEqual([]);
            const storage = storageOfTypeReference((parsed.model.scopes[0].declarations[0] as VariableDeclaration).type);
            // `long` has 32 bits (dataModel of hsm.gen.json), LIMIT of the command line overrides the configuration
            expect(storage).toMatchObject({ kind: 'integer', bits: 32, signed: true });
            expect(warnings(parsed)).toEqual([]);
            const sim = new StatechartInterpreter(parsed.model);
            sim.enter();
            expect(sim.getVariable('c')).toBe(300000);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the example examples/cpp-types: model and unit tests', async () => {
        const services = createHsmServices(NodeFileSystem);
        installNodeHeaderSupport(services.shared);
        const directory = path.resolve(__dirname, '../../../examples/cpp-types');
        const workspace = new HsmTestWorkspace(services);
        const documents = await workspace.load(['conveyor.devm', 'conveyor.devmtest'].map(name => ({
            uri: pathToFileURL(path.join(directory, name)).toString(),
            text: fs.readFileSync(path.join(directory, name), 'utf-8')
        })));
        for (const loaded of documents) {
            expect(loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message), loaded.uri).toEqual([]);
        }
        const results = workspace.runDocuments(documents);
        expect(results.length).toBeGreaterThanOrEqual(5);
        expect(results.filter(r => r.status !== 'passed').map(r => `${r.name}: ${r.message}`)).toEqual([]);
    });
});
