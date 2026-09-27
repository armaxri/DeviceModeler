import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { errors, parse, warnings } from './helpers.js';

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
