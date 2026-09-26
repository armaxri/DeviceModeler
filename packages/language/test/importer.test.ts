import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { isPseudoState, isState, type Transition } from '../src/generated/ast.js';
import { qualifiedName } from '../src/hsm-scope.js';
import { importSct } from '../src/importer/sct-importer.js';
import { parseXml } from '../src/importer/xml.js';
import { allTransitions, allVertices } from '../src/model-utils.js';
import { parse } from './helpers.js';

const fixtures = path.resolve(__dirname, 'importer/fixtures');

async function importAndParse(xml: string) {
    const result = importSct(xml);
    const parsed = await parse(result.text);
    const syntaxErrors = [...parsed.document.parseResult.lexerErrors, ...parsed.document.parseResult.parserErrors].map(e => e.message);
    const linkingErrors = parsed.diagnostics.filter(d => d.message.startsWith('Could not resolve reference')).map(d => d.message);
    return { ...result, parsed, syntaxErrors, linkingErrors };
}

/** Counts the elements of the itemis model directly from the XML text (independent of the importer). */
function countXml(xml: string) {
    const model = xml.substring(xml.indexOf('<sgraph:Statechart'), xml.indexOf('</sgraph:Statechart>'));
    // attribute values may contain '>'
    const vertices = [...model.matchAll(/<vertices(?:\s+[\w:]+="[^"]*")*\s*\/?>/g)].map(m => m[0]);
    const type = (v: string) => /xsi:type="sgraph:(\w+)"/.exec(v)?.[1];
    const attribute = (v: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(v)?.[1];
    const states = vertices.filter(v => type(v) === 'State').map(v => attribute(v, 'name') ?? '');
    const pseudoStates = vertices.filter(v => {
        switch (type(v)) {
            case 'Choice': case 'Synchronization': case 'Exit':
                return true;
            case 'Entry': {
                const name = attribute(v, 'name') ?? '';
                return attribute(v, 'kind') !== undefined || (name !== '' && name !== 'default');
            }
            default:
                return false;
        }
    }).length;
    const transitions = [...model.matchAll(/<outgoingTransitions(?:\s+[\w:]+="[^"]*")*\s*\/?>/g)].map(m => m[0]);
    // itemis allows one transition to handle several exit nodes (`# ex1 > ex2 >`): HSM needs one transition per exit node
    const extraExitTransitions = transitions
        .map(t => (attribute(t, 'specification') ?? '').replace(/&gt;/g, '>'))
        .map(spec => spec.includes('#') ? (spec.substring(spec.indexOf('#')).match(/\w+\s*>/g) ?? []).length : 0)
        .reduce((sum, exits) => sum + Math.max(0, exits - 1), 0);
    const topLevelRegions = (model.match(/^ {4}<regions\s/gm) ?? []).length;
    return { states, pseudoStates, transitions: transitions.length + extraExitTransitions, topLevelRegions };
}

describe('sct fixtures', () => {
    const files = fs.readdirSync(fixtures).filter(f => f.endsWith('.sct')).sort();

    test('there are fixtures', () => {
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    for (const file of files) {
        test(`${file} is imported`, async () => {
            const xml = fs.readFileSync(path.join(fixtures, file), 'utf-8');
            const { parsed, syntaxErrors, linkingErrors } = await importAndParse(xml);
            expect(syntaxErrors).toEqual([]);
            expect(linkingErrors).toEqual([]);

            const expected = countXml(xml);
            const wrapped = expected.topLevelRegions > 1 ? 1 : 0;
            const vertices = allVertices(parsed.model);
            const states = vertices.filter(isState);
            expect(states.length).toBe(expected.states.length + wrapped);
            expect(vertices.filter(isPseudoState).length).toBe(expected.pseudoStates);
            expect(allTransitions(parsed.model).length).toBe(expected.transitions + wrapped);
            // names are preserved: either directly or as description of a renamed state
            for (const name of expected.states.filter(n => n.trim())) {
                expect(states.some(s => s.name === name.trim() || s.description === name.trim()), `state '${name}'`).toBe(true);
            }
        });
    }
});

// ---------------------------------------------------------------------------------------------
// Builders for small itemis models

let ids = 0;

function statechart(specification: string, ...regions: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<xmi:XMI xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:sgraph="http://www.yakindu.org/sct/sgraph/2.0.0">
  <sgraph:Statechart xmi:id="sc" specification="${escape(specification)}" name="Test">
    ${regions.join('\n')}
  </sgraph:Statechart>
</xmi:XMI>`;
}

function region(name: string | undefined, ...vertices: string[]): string {
    return `<regions xmi:id="r${ids++}"${name !== undefined ? ` name="${escape(name)}"` : ''}>${vertices.join('\n')}</regions>`;
}

function state(id: string, name: string, options: { spec?: string, transitions?: string[], regions?: string[] } = {}): string {
    return `<vertices xsi:type="sgraph:State" xmi:id="${id}" name="${escape(name)}" specification="${escape(options.spec ?? '')}">`
        + `${(options.transitions ?? []).join('')}${(options.regions ?? []).join('')}</vertices>`;
}

function vertex(type: string, id: string, attributes: Record<string, string>, ...transitions: string[]): string {
    const attrs = Object.entries(attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join('');
    return `<vertices xsi:type="sgraph:${type}" xmi:id="${id}"${attrs}>${transitions.join('')}</vertices>`;
}

function entry(target: string, spec = ''): string {
    return vertex('Entry', `e${ids++}`, {}, transition(target, spec));
}

function transition(target: string, spec = ''): string {
    return `<outgoingTransitions xmi:id="t${ids++}" specification="${escape(spec)}" target="${target}"/>`;
}

function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#xA;');
}

function transitionTexts(transitions: Transition[]): string[] {
    return transitions.map(t => t.$cstNode!.text.replace(/\s+/g, ' '));
}

// ---------------------------------------------------------------------------------------------

describe('xml parser', () => {
    test('attributes, entities, comments and CDATA', () => {
        const root = parseXml(`<?xml version="1.0"?>\n<!-- c --><a x="1 &lt; 2&#xA;" y='&quot;q&quot;'><b/><![CDATA[<raw>]]><c>t&amp;t</c></a>`);
        expect(root.name).toBe('a');
        expect(root.attributes).toEqual({ x: '1 < 2\n', y: '"q"' });
        expect(root.children.map(c => c.name)).toEqual(['b', 'c']);
        expect(root.text).toBe('<raw>');
        expect(root.children[1].text).toBe('t&t');
    });

    test('errors', () => {
        expect(() => parseXml('<a><b></a>')).toThrow(/unexpected closing tag/);
        expect(() => parseXml('<a>')).toThrow(/missing closing tag/);
    });
});

describe('sct importer', () => {
    test('names with spaces and keywords are sanitized', async () => {
        const xml = statechart('interface:\nin event go',
            region('main region',
                entry('s1'),
                state('s1', 'Door Open', { transitions: [transition('s2', 'go')] }),
                state('s2', 'entry', { transitions: [transition('s3', 'go [active(main_region.Closed) || active(Test.main_region.Closed.inner.Locked)]')] }),
                state('s3', 'Door-Open'),
                state('s4', 'Closed', { regions: [region('inner', entry('s5'), state('s5', 'Locked'))] })));
        const { text, warnings, parsed, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        expect(text).toContain('state Door_Open "Door Open"');
        expect(text).toContain('state entry_ "entry"');
        expect(text).toContain('state Door_Open_2 "Door-Open"');
        expect(text).toContain('Door_Open -> entry_ : go');
        expect(warnings).toContain(`State 'Door Open' was renamed to 'Door_Open'.`);
        expect(warnings).toContain(`State 'Door-Open' was renamed to 'Door_Open_2' (duplicate name).`);
        // `active(...)`: itemis uses region names, HSM does not
        expect(transitionTexts(allTransitions(parsed.model))).toContain('entry_ -> Door_Open_2 : go [active(Closed) || active(Locked)]');
    });

    test('several top-level regions are wrapped into a composite state', async () => {
        const xml = statechart('',
            region('left', entry('a'), state('a', 'A')),
            region('right', entry('b'), state('b', 'B')));
        const { text, warnings, syntaxErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(text).toMatch(/\[\*\] -> Main\s+state Main \{\s+region left \{\s+\[\*\] -> A\s+state A\s+\}\s+region right \{/);
        expect(warnings[0]).toContain('wrapped into the composite state \'Main\'');
        expect(importSct(xml, { mainStateName: 'Root' }).text).toContain('state Root {');
    });

    test('single regions are transparent, orthogonal regions are kept', async () => {
        const xml = statechart('',
            region('main region', entry('c'),
                state('c', 'C', { regions: [region('only', entry('c1'), state('c1', 'C1'))] }),
                state('d', 'D', { regions: [region('r 1', entry('d1'), state('d1', 'D1')), region('', entry('d2'), state('d2', 'D2'))] })));
        const { text, syntaxErrors, parsed } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(text).not.toContain('region only');
        expect(text).toContain('region r_1 {');
        expect(text).toMatch(/region \{\s+\[\*\] -> D2/);
        expect(allVertices(parsed.model).filter(isState).map(qualifiedName)).toEqual(['C', 'C.C1', 'D', 'D.D1', 'D.D2']);
    });

    test('history, choice, junction and synchronization', async () => {
        const xml = statechart('interface:\nin event e\nvar x : integer',
            region('main', entry('a'),
                state('a', 'A', {
                    transitions: [transition('ch', 'e')],
                    regions: [region('r',
                        vertex('Entry', 'h1', { kind: 'SHALLOW_HISTORY' }, transition('a1')),
                        vertex('Entry', 'h2', { kind: 'DEEP_HISTORY' }, transition('a1')),
                        vertex('Entry', 'h3', { kind: 'SHALLOW_HISTORY', name: 'default' }, transition('a1')),
                        entry('a1'),
                        state('a1', 'A1'))]
                }),
                vertex('Choice', 'ch', {}, transition('a', '[x > 1]'), transition('j', 'else')),
                vertex('Choice', 'j', { kind: 'STATIC' }, transition('a', 'default'))));
        const { text, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        expect(text).toContain('history H\n');
        expect(text).toContain('deephistory DH\n');
        expect(text).toContain('history default_\n');
        expect(text).toContain('H -> A1');
        expect(text).toContain('choice Choice1');
        expect(text).toContain('junction Junction1');
        expect(text).toContain('Choice1 -> Junction1 : else');
    });

    test('entry points and exit nodes', async () => {
        const xml = statechart('interface:\nin event e\nin event f',
            region('main', entry('a'),
                state('a', 'A', { transitions: [transition('c', 'e # > alt'), transition('c', 'f # >default')] }),
                state('c', 'C', {
                    transitions: [transition('a', '# done >'), transition('a', ''), transition('a', 'e # x1 > x2 >')],
                    regions: [region('r',
                        entry('c1'),
                        vertex('Entry', 'alt', { name: 'alt' }, transition('c2')),
                        state('c1', 'C1', { transitions: [transition('done', 'e'), transition('dx', 'f')] }),
                        state('c2', 'C2', { transitions: [transition('x1', 'e'), transition('x2', 'f')] }),
                        vertex('Exit', 'done', { name: 'done' }),
                        vertex('Exit', 'dx', {}),
                        vertex('Exit', 'x1', { name: 'x1' }),
                        vertex('Exit', 'x2', { name: 'x2' }))]
                })));
        const { text, warnings, parsed, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        expect(text).toContain('entry alt');
        expect(text).toContain('exit Exit1');
        const transitions = transitionTexts(allTransitions(parsed.model));
        expect(transitions).toContain('A -> C : e # >alt');
        expect(transitions).toContain('A -> C : f');
        expect(transitions).toContain('alt -> C2');
        expect(transitions).toContain('C -> A # done>');
        // the unnamed exit is the default exit: it is handled by transitions without trigger
        expect(transitions).toContain('C -> A # Exit1>');
        // one itemis transition handling two exit nodes becomes two transitions
        expect(transitions).toContain('C -> A : e # x1>');
        expect(transitions).toContain('C -> A : e # x2>');
        expect(warnings.join('\n')).toContain('handles several exit nodes (x1, x2)');
        // priority order of the transitions leaving C is kept
        expect(transitions.filter(t => t.startsWith('C -> A'))).toEqual(['C -> A # done>', 'C -> A # Exit1>', 'C -> A : e # x1>', 'C -> A : e # x2>']);
    });

    test('entering through a named history, unknown entry points', async () => {
        const xml = statechart('interface:\nin event e\nin event f',
            region('main', entry('a'),
                state('a', 'A', { transitions: [transition('b', 'e # > hist'), transition('b', 'f # >unknown')] }),
                state('b', 'B', {
                    regions: [region('r', entry('b1'), vertex('Entry', 'h', { name: 'hist', kind: 'SHALLOW_HISTORY' }, transition('b1')), state('b1', 'B1'))]
                })));
        const { parsed, warnings, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        expect(transitionTexts(allTransitions(parsed.model)).sort()).toEqual(['A -> B : f', 'A -> hist : e', '[*] -> A', '[*] -> B1', 'hist -> B1']);
        expect(warnings.join('\n')).toContain(`'B' has no entry point named 'unknown'`);
    });

    test('final states', async () => {
        const xml = statechart('interface:\nin event e\nin event f',
            region('main', entry('a'),
                state('a', 'A', {
                    transitions: [transition('f1', 'e'), transition('f2', 'f')],
                    regions: [region('r', entry('b'), state('b', 'B', { transitions: [transition('bf', 'e')] }), vertex('FinalState', 'bf', {}))]
                }),
                vertex('FinalState', 'f1', {}),
                vertex('FinalState', 'f2', {})));
        const { text, warnings, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        expect(text).toMatch(/state A \{\s+\[\*\] -> B\s+state B\s+B -> \[\*\] : e\s+\}/);
        expect(text).toContain('A -> [*] : e\n');
        expect(text).toContain('A -> [*] : f\n');
        expect(warnings.join('\n')).toContain('has 2 final states');
    });

    test('local reactions are split and normalized', async () => {
        const spec = [
            '// counts',
            'entry / x = 1',
            '  y = 2;',
            '  z = x +',
            '    y',
            'exit / x = 0 // reset',
            'e [x > 1 &&',
            '   y > 1] / x++',
            'every 1 s / raise done',
            'after 2.5f s / y = 3.0d'
        ].join('\n');
        const xml = statechart('interface:\nin event e\nout event done\nvar x : integer\nvar y : integer\nvar z : integer',
            region('main', entry('a'), state('a', 'A', { spec })));
        const { text, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        expect(text).toContain([
            '    state A {',
            '        // counts',
            '        entry / x = 1; y = 2; z = x + y',
            '        exit / x = 0 // reset',
            '        e [x > 1 && y > 1] / x += 1',
            '        every 1 s / raise done',
            '        after 2.5 s / y = 3.0',
            '    }'
        ].join('\n'));
    });

    test('definition section: namespace first, annotations before scopes', async () => {
        const specification = 'interface:\n\tin event e\n@EventDriven\n@SuperSteps(yes)\ninternal:\n  var x : integer\n  oncycle / x += 1';
        const xml = `${statechart(specification, region('main', entry('a'), state('a', 'A')))}`.replace('name="Test"', 'name="Test" namespace="my.ns"');
        const { text, warnings, syntaxErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(text).toContain([
            'statemachine Test {',
            '    namespace my.ns',
            '',
            '    @EventDriven',
            '    // TODO import: @SuperSteps(yes)',
            '',
            '    interface:',
            '        in event e',
            '    internal:',
            '        var x : integer',
            '        // TODO import: oncycle / x += 1',
            ''
        ].join('\n'));
        expect(warnings.join('\n')).toContain('@SuperSteps(yes)');
        expect(warnings.join('\n')).toContain('Local reactions of the statechart are not supported');
    });

    test('references use the shortest unambiguous names', async () => {
        const xml = statechart('interface:\nin event e',
            region('main', entry('p'),
                state('p', 'P', { transitions: [transition('qa', 'e')], regions: [region('r', entry('pa'), state('pa', 'A', { transitions: [transition('qa', 'e'), transition('pa', 'e')] }))] }),
                state('q', 'Q', { regions: [region('r', entry('qa'), state('qa', 'A'))] })));
        const { parsed, syntaxErrors, linkingErrors } = await importAndParse(xml);
        expect(syntaxErrors).toEqual([]);
        expect(linkingErrors).toEqual([]);
        const transitions = allTransitions(parsed.model).filter(t => !t.initial);
        expect(transitions.map(t => `${qualifiedName(t.source!.ref!)} -> ${qualifiedName(t.target!.ref!)}`))
            .toEqual(['P -> Q.A', 'P.A -> Q.A', 'P.A -> P.A']);
        // transitions of P.A are declared in the machine (to keep their priority), so they need qualified names
        expect(transitionTexts(transitions)).toEqual(['P -> Q.A : e', 'P.A -> Q.A : e', 'P.A -> P.A : e']);
    });

    test('unsupported submachine states and invalid input', () => {
        const xml = statechart('', region('main', entry('a'), vertex('State', 'a', { name: 'A', referencedStatechart: 'Other.sct' })));
        const { text, warnings } = importSct(xml);
        expect(text).toContain('// TODO import: submachine state');
        expect(warnings.join('\n')).toContain('submachine state');
        expect(() => importSct('<a/>')).toThrow(/does not contain an itemis CREATE statechart/);
    });
});
