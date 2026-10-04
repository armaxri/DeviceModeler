import { AstUtils } from 'langium';
import { describe, expect, test } from 'vitest';
import { parseCppHeader } from '../src/cpp-header/parser.js';
import type { CppAlias, CppEnum, CppNamespace, CppRecord } from '../src/cpp-header/model.js';
import { cppDefinition } from '../src/lsp/cpp-lsp.js';
import { cppLocations, cppTypeLocationsOf, referenceBaseRange, type CppNavigationKind } from '../src/lsp/cpp-navigation.js';
import * as ast from '../src/generated/ast.js';
import { errors, parse } from './helpers.js';

/** Navigation from models into imported headers (definition, declaration, type definition), see lsp/cpp-navigation.ts. */

const UNITS = `#pragma once
namespace base {
using Rpm = int;
}
`;

const SENSOR = `#pragma once
#include "units.h"
namespace hw {
enum class Channel : unsigned char;
struct Reading { base::Rpm speed = 0; int raw; };
enum class Channel : unsigned char { A, B };
typedef struct { int x; } point_t;
}
`;

const APP = `#pragma once
#include "sensor.h"
namespace app {
using hw::Channel;
struct Config { hw::Reading reading; hw::point_t at; };
}
namespace app { constexpr int kReopened = 1; }
`;

const MODEL = `statemachine Nav {
    import "app.h"
    interface:
        var cfg : app::Config
        var ch : app::Channel = app::Channel::B
        var n : integer = app::kReopened + cfg.at.x
    [*] -> A
    state A
    A -> A : always [cfg.reading.speed > n] / ch = app::Channel::A
}
`;

const HEADERS: Record<string, string> = { 'app.h': APP, 'sensor.h': SENSOR, 'units.h': UNITS };

async function model() {
    const parsed = await parse(MODEL, HEADERS);
    expect(errors(parsed)).toEqual([]);
    return parsed.document;
}

/** `file:line:name` of the targets for the position `delta` characters into the first match of `search`. */
async function targets(kind: CppNavigationKind, search: string, delta: number): Promise<string[]> {
    const document = await model();
    return cppLocations(document, MODEL.indexOf(search) + delta, kind).map(location => {
        const file = location.uri.replace(/^.*\//, '');
        const line = HEADERS[file].split('\n')[location.selection.start.line];
        return `${file}:${location.selection.start.line + 1}:${line.slice(location.selection.start.character, location.selection.end.character)}`;
    });
}

describe('navigation into C/C++ headers', () => {
    test('definition: each segment of a qualified name, the definition rather than declarations', async () => {
        expect(await targets('definition', 'app::Channel::B', 1)).toEqual(['app.h:3:app']);
        expect(await targets('definition', 'app::Channel::B', 7)).toEqual(['sensor.h:6:Channel']);
        expect(await targets('definition', 'app::Channel::B', 14)).toEqual(['sensor.h:6:B']);
        expect(await targets('definition', 'cfg.at.x', 5)).toEqual(['app.h:5:at']);
        expect(await targets('definition', 'cfg.at.x', 7)).toEqual(['sensor.h:7:x']);
        expect(await targets('definition', 'cfg.reading.speed', 13)).toEqual(['sensor.h:5:speed']);
        expect(await targets('definition', 'import "app.h"', 9)).toEqual(['app.h:1:']);
        const document = await model();
        expect(cppDefinition(document, MODEL.indexOf('app::Config') + 6)?.selection.start.line).toBe(4);
        // the origin is the segment at the position
        const origin = cppLocations(document, MODEL.indexOf('app::Channel::B') + 8, 'definition')[0].origin;
        expect(MODEL.split('\n')[origin.start.line].slice(origin.start.character, origin.end.character)).toBe('Channel');
    });

    test('declaration: all declarations, the definition first', async () => {
        expect(await targets('declaration', 'app::Channel =', 7)).toEqual(['sensor.h:6:Channel', 'sensor.h:4:Channel', 'app.h:4:Channel']);
        expect(await targets('declaration', 'app::kReopened', 1)).toEqual(['app.h:3:app', 'app.h:7:app']);
        expect(await targets('declaration', 'cfg :', 1)).toEqual([]);
    });

    test('type definition: the enum or struct of C++ names and members, aliases of built-in types', async () => {
        expect(await targets('typeDefinition', 'app::Channel::B', 14)).toEqual(['sensor.h:6:Channel']);
        expect(await targets('typeDefinition', 'cfg.at.x', 5)).toEqual(['sensor.h:7:point_t']);
        expect(await targets('typeDefinition', 'cfg.reading.speed', 13)).toEqual(['units.h:3:Rpm']);
        expect(await targets('typeDefinition', 'app::kReopened', 7)).toEqual([]);
        const document = await model();
        const variable = AstUtils.streamAst(document.parseResult.value).filter(ast.isVariableDeclaration).find(v => v.name === 'cfg')!;
        const origin = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        expect(cppTypeLocationsOf(variable, origin).map(l => l.selection.start.line)).toEqual([4]);
    });

    test('the variable name of a reference with struct members', async () => {
        const document = await model();
        const reference = AstUtils.streamAst(document.parseResult.value).filter(ast.isElementReference)
            .find(r => r.element.$refText.replace(/\s+/g, '') === 'cfg.reading.speed')!;
        const range = referenceBaseRange(reference)!;
        expect(MODEL.split('\n')[range.start.line].slice(range.start.character, range.end.character)).toBe('cfg');
    });

    test('name ranges of using-declarations and of anonymous types named by typedef', () => {
        const text = 'namespace a { struct S {}; }\nusing a::S;\ntypedef enum { X } color_t;\n';
        const header = parseCppHeader(text, 'x.h');
        const lines = text.split('\n');
        const nameAt = (d: { nameRange: { start: { line: number, character: number }, end: { character: number } } }) =>
            lines[d.nameRange.start.line].slice(d.nameRange.start.character, d.nameRange.end.character);
        const using = header.declarations.find((d): d is CppAlias => d.kind === 'alias' && d.syntax === 'usingDeclaration')!;
        expect(nameAt(using)).toBe('S');
        const color = header.declarations.find((d): d is CppEnum => d.kind === 'enum')!;
        expect(nameAt(color)).toBe('color_t');
        expect(nameAt(header.declarations[0] as CppNamespace)).toBe('a');
        expect(nameAt((header.declarations[0] as CppNamespace).members[0] as CppRecord)).toBe('S');
    });
});
