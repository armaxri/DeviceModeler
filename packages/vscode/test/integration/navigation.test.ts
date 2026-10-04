import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { positionOf, startLspServer, type LspServer } from './lsp-harness.js';

/*
 * Navigation into C/C++ headers with the language server of the extension (what VS Code requests for
 * F12 / Ctrl+Click / Peek Definition, Go to Declaration, Go to Type Definition and document links):
 * headers next to the model, included by other headers and found through the include paths of
 * devm.gen.json (in a directory with a space in its name).
 */

const UNITS = `#pragma once
#include <cstdint>
namespace base {
/// Rotational speed.
using Rpm = std::int32_t;
typedef unsigned char Byte;
}
`;

const SENSOR = `#pragma once
#include "base/units.h"
namespace hw {
enum class Channel : std::uint8_t;
struct Reading {
    base::Rpm speed = 0;
    int raw;
};
enum class Channel : std::uint8_t { A, B };
constexpr int kLimit = 10;
typedef enum { LOW, HIGH } level_t;
}
`;

const APP = `#pragma once
#include "hw/sensor.h"
namespace app {
namespace cfg = hw;
using hw::Channel;
struct Config { hw::Reading reading; base::Rpm max = 100; };
enum Color { Red, Green };
namespace inner { constexpr int kDepth = 2; }
}
namespace app { constexpr int kReopened = 1; }
`;

const NAV = `statemachine Nav {
    import "app.h"
    interface:
        in event read : hw::Reading
        var cfg : app::Config
        var ch : app::Channel = app::Channel::B
        var col : app::Color = app::Red
        var speed : base::Rpm = hw::kLimit
        var d : integer = app::inner::kDepth + app::kReopened
        var alias2 : app::cfg::Channel = app::cfg::Channel::A
        var level : hw::level_t
    [*] -> A
    state A
    A -> A : read [valueof(read).speed > cfg.reading.speed] / cfg.max = speed; col = 1 as app::Color
}
`;

const NAV_TEST = `testclass NavTest for statemachine Nav {
    @Test
    operation reads() {
        enter
        assert cfg.reading.raw == 0
        assert col == app::Red
    }
}
`;

const FILES: Record<string, string> = {
    'third party/include/base/units.h': UNITS,
    'models/hw/sensor.h': SENSOR,
    'models/app.h': APP,
    'models/nav.devm': NAV,
    'tests/nav.devmtest': NAV_TEST,
    'devm.gen.json': JSON.stringify({ models: ['models/*.devm'], cpp: {}, headers: { includePaths: ['third party/include'] } })
};

interface Link {
    targetUri: string;
    targetRange: Range;
    targetSelectionRange: Range;
    originSelectionRange?: Range;
}
interface Range {
    start: { line: number, character: number };
    end: { line: number, character: number };
}

let server: LspServer;

beforeAll(async () => {
    server = await startLspServer(FILES);
    for (const capability of ['definitionProvider', 'declarationProvider', 'typeDefinitionProvider', 'documentLinkProvider']) {
        expect(server.capabilities[capability], capability).toBeTruthy();
    }
    server.open('models/nav.devm', 'devm', NAV);
    const diagnostics = await server.diagnosticsFor(server.uriOf('models/nav.devm'));
    expect(diagnostics.filter(d => d.severity === 1)).toEqual([]);
}, 120000);

afterAll(async () => server?.stop());

type Method = 'definition' | 'declaration' | 'typeDefinition';

async function request(method: Method, search: string, delta: number, file = 'models/nav.devm', text = NAV): Promise<Link[]> {
    const result = await server.connection.sendRequest<Link[] | null>(`textDocument/${method}`, {
        textDocument: { uri: server.uriOf(file) }, position: positionOf(text, search, delta)
    });
    return result ?? [];
}

/** `file:line:name` of a link (the text of the selection range in the header), and the text of its origin in the model. */
function describeLink(link: Link, model = NAV): string {
    const file = Object.keys(FILES).find(f => server.uriOf(f) === link.targetUri) ?? link.targetUri;
    const lines = (FILES[file] ?? '').split('\n');
    const selection = link.targetSelectionRange;
    const name = lines[selection.start.line]?.slice(selection.start.character, selection.end.character);
    const origin = link.originSelectionRange;
    const originText = origin ? model.split('\n')[origin.start.line].slice(origin.start.character, origin.end.character) : '?';
    return `${file}:${selection.start.line + 1}:${name} <- ${originText}`;
}

async function targets(method: Method, search: string, delta: number, file?: string, text?: string): Promise<string[]> {
    return (await request(method, search, delta, file, text)).map(link => describeLink(link, text));
}

describe('navigation into C/C++ headers', () => {
    it('leads from each segment of a qualified name to its own declaration', async () => {
        expect(await targets('definition', 'hw::Reading', 1)).toEqual(['models/hw/sensor.h:3:hw <- hw']);
        expect(await targets('definition', 'hw::Reading', 5)).toEqual(['models/hw/sensor.h:5:Reading <- Reading']);
        expect(await targets('definition', 'app::Channel::B', 1)).toEqual(['models/app.h:3:app <- app']);
        expect(await targets('definition', 'app::inner::kDepth', 7)).toEqual(['models/app.h:8:inner <- inner']);
        expect(await targets('definition', 'app::inner::kDepth', 13)).toEqual(['models/app.h:8:kDepth <- kDepth']);
        expect(await targets('definition', 'app::kReopened', 6)).toEqual(['models/app.h:10:kReopened <- kReopened']);
        expect(await targets('definition', 'app::Red', 6)).toEqual(['models/app.h:7:Red <- Red']);
        expect(await targets('definition', 'as app::Color', 9)).toEqual(['models/app.h:7:Color <- Color']);
    });

    it('finds headers through nested includes and the include paths of devm.gen.json', async () => {
        expect(await targets('definition', 'base::Rpm =', 7)).toEqual(['third party/include/base/units.h:5:Rpm <- Rpm']);
        expect(await targets('definition', 'hw::kLimit', 5)).toEqual(['models/hw/sensor.h:10:kLimit <- kLimit']);
        const [link] = await request('definition', 'base::Rpm =', 7);
        expect(link.targetUri).toMatch(/^file:\/\/.*third%20party\/include\/base\/units\.h$/);
    });

    it('prefers definitions: the enum definition over the opaque declaration, the target of a using-declaration', async () => {
        expect(await targets('definition', 'app::Channel::B', 7)).toEqual(['models/hw/sensor.h:9:Channel <- Channel']);
        expect(await targets('definition', 'app::Channel::B', 14)).toEqual(['models/hw/sensor.h:9:B <- B']);
        // through the namespace alias `cfg`
        expect(await targets('definition', 'app::cfg::Channel::A', 6)).toEqual(['models/app.h:4:cfg <- cfg']);
        expect(await targets('definition', 'app::cfg::Channel::A', 12)).toEqual(['models/hw/sensor.h:9:Channel <- Channel']);
        // the name of `typedef enum { … } level_t;`
        expect(await targets('definition', 'hw::level_t', 5)).toEqual(['models/hw/sensor.h:11:level_t <- level_t']);
    });

    it('lists all declarations (definition first) for Go to Declaration', async () => {
        expect(await targets('declaration', 'app::Channel = ', 7)).toEqual([
            'models/hw/sensor.h:9:Channel <- Channel', 'models/hw/sensor.h:4:Channel <- Channel', 'models/app.h:5:Channel <- Channel'
        ]);
        expect(await targets('declaration', 'app::kReopened', 1)).toEqual(['models/app.h:3:app <- app', 'models/app.h:10:app <- app']);
        // declarations of the model are their definitions
        expect(await targets('declaration', 'cfg.max', 1)).toEqual(['models/nav.devm:5:cfg <- cfg']);
    });

    it('navigates from struct members to the fields, only the variable name links to the variable', async () => {
        expect(await targets('definition', 'valueof(read).speed', 15)).toEqual(['models/hw/sensor.h:6:speed <- speed']);
        expect(await targets('definition', 'cfg.reading.speed', 5)).toEqual(['models/app.h:6:reading <- reading']);
        expect(await targets('definition', 'cfg.reading.speed', 13)).toEqual(['models/hw/sensor.h:6:speed <- speed']);
        const [variable] = await request('definition', 'cfg.reading.speed', 1);
        expect(variable.targetUri).toBe(server.uriOf('models/nav.devm'));
        expect(describeLink(variable)).toMatch(/<- cfg$/);
    });

    it('goes to the C++ type of variables, events, members, constants and enumerators', async () => {
        expect(await targets('typeDefinition', 'var cfg', 5)).toEqual(['models/app.h:6:Config <- cfg']);
        expect(await targets('typeDefinition', 'cfg.max', 1)).toEqual(['models/app.h:6:Config <- cfg']);
        expect(await targets('typeDefinition', 'read [', 1)).toEqual(['models/hw/sensor.h:5:Reading <- read']);
        expect(await targets('typeDefinition', 'cfg.reading.speed', 5)).toEqual(['models/hw/sensor.h:5:Reading <- reading']);
        // an alias of a built-in type: the alias
        expect(await targets('typeDefinition', 'cfg.reading.speed', 13)).toEqual(['third party/include/base/units.h:5:Rpm <- speed']);
        expect(await targets('typeDefinition', 'speed;', 1)).toEqual(['third party/include/base/units.h:5:Rpm <- speed']);
        expect(await targets('typeDefinition', 'app::Red', 6)).toEqual(['models/app.h:7:Color <- Red']);
        expect(await targets('typeDefinition', 'app::Channel::B', 14)).toEqual(['models/hw/sensor.h:9:Channel <- B']);
        // built-in types have no declaration
        expect(await targets('typeDefinition', 'hw::kLimit', 5)).toEqual([]);
    });

    it('opens the imported header from the import path (definition and document link)', async () => {
        const [link] = await request('definition', '"app.h"', 2);
        expect(link.targetUri).toBe(server.uriOf('models/app.h'));
        expect(link.originSelectionRange).toEqual({ start: { line: 1, character: 11 }, end: { line: 1, character: 18 } });
        const links = await server.connection.sendRequest<Array<{ range: Range, target: string }>>('textDocument/documentLink', {
            textDocument: { uri: server.uriOf('models/nav.devm') }
        });
        expect(links).toEqual([expect.objectContaining({ range: link.originSelectionRange, target: server.uriOf('models/app.h') })]);
    });

    it('navigates from test files', async () => {
        server.open('tests/nav.devmtest', 'devmtest', NAV_TEST);
        await server.diagnosticsFor(server.uriOf('tests/nav.devmtest'));
        expect(await targets('definition', 'cfg.reading.raw', 13, 'tests/nav.devmtest', NAV_TEST)).toEqual(['models/hw/sensor.h:7:raw <- raw']);
        expect(await targets('definition', 'app::Red', 6, 'tests/nav.devmtest', NAV_TEST)).toEqual(['models/app.h:7:Red <- Red']);
        expect(await targets('typeDefinition', 'cfg.reading.raw', 5, 'tests/nav.devmtest', NAV_TEST)).toEqual(['models/hw/sensor.h:5:Reading <- reading']);
    });
});
