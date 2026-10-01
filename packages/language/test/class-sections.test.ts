import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { errors, loader, parse, warnings } from './helpers.js';
import { describeMemberType, isUsableInModel, unusableReason, writtenCppType } from '../src/class-members.js';
import { typeOfVariable, typeName } from '../src/hsm-typesystem.js';
import { StatechartInterpreter } from '../src/simulation/index.js';
import { HsmTestWorkspace } from '../src/testing/index.js';
import { generateC } from '../src/generator/c/index.js';
import { generateCpp } from '../src/generator/cpp/index.js';
import { generateTarget, parseGeneratorConfig } from '../src/generator/config.js';
import { CLASS_SECTIONS_NOT_SUPPORTED } from '../src/generator/common/statechart-generator.js';
import { describeStateMachine, generateModelDoc } from '../src/doc/model-doc.js';
import { definitionLines } from '../src/model-utils.js';
import { createHsmServices } from '../src/hsm-module.js';
import { installNodeHeaderSupport } from '../src/node/cpp-headers-node.js';

const EXAMPLE_DIRECTORY = path.resolve(__dirname, '../../../examples/cpp-class-sections');

const APP_H = [
    'namespace app {',
    'enum class Mode { Off, Slow, Fast };',
    'struct Config { unsigned int retries = 2; Mode mode = Mode::Off; };',
    'class Driver;',
    'constexpr unsigned int kMax = 3;',
    '}'
].join('\n');

/** A model importing app.h with the given definition section (and a state A with a transition on `go`). */
function model(definitions: string, effect = ''): string {
    return [
        'statemachine M {',
        '    import "app.h"',
        '    interface:',
        '        in event go',
        '        var count : integer',
        definitions,
        '    [*] -> A',
        '    state A',
        `    A -> A : go${effect ? ` / ${effect}` : ''}`,
        '}'
    ].join('\n');
}

async function parseModel(definitions: string, effect = '') {
    return parse(model(definitions, effect), { 'app.h': APP_H });
}

const MEMBERS = `
    public:
        /** Sets the configuration. */
        operation setConfig(config : const app::Config&)
        operation retries() : unsigned int
    protected:
        operation setup()
        operation attach(driver : app::Driver*) : bool
        var driver : app::Driver*
    private:
        var errorCnt : unsigned int = 1
        const maxErrors : unsigned int = app::kMax + 1
        var config : app::Config
        var ratio : double = 0.5
        var names : std::vector<std::vector<int>>
        var table : std::map<int, const char*>
        var values : std::array<int, 4>`;

describe('C++ class sections: parsing', () => {
    test('C++ types are kept as written with normalized white space', async () => {
        const parsed = await parseModel(MEMBERS);
        expect(parsed.hasSyntaxErrors).toBe(false);
        const types = Object.fromEntries(parsed.model.scopes.filter(ast.isClassScope).flatMap(s => s.declarations).flatMap(d => {
            if (ast.isVariableDeclaration(d)) {
                return [[d.name, writtenCppType(d.type!)]];
            }
            return ast.isOperationDeclaration(d) ? d.parameters.map(p => [`${d.name}.${p.name}`, writtenCppType(p.type!)]) : [];
        }));
        expect(types).toEqual({
            'setConfig.config': 'const app::Config&',
            'attach.driver': 'app::Driver*',
            driver: 'app::Driver*',
            errorCnt: 'unsigned int',
            maxErrors: 'unsigned int',
            config: 'app::Config',
            ratio: 'double',
            names: 'std::vector<std::vector<int>>',
            table: 'std::map<int, const char*>',
            values: 'std::array<int, 4>'
        });
        const setConfig = parsed.model.scopes.filter(ast.isClassScope)[0].declarations[0] as ast.OperationDeclaration;
        expect(setConfig.parameters[0].type).toMatchObject({ const: true, name: 'app::Config', reference: '&' });
        expect(parsed.model.scopes.filter(ast.isClassScope).map(s => s.access)).toEqual(['public', 'protected', 'private']);
    });

    test('the definition section lists the class sections', async () => {
        const parsed = await parseModel(MEMBERS);
        const lines = definitionLines(parsed.model);
        expect(lines).toContain('public:');
        expect(lines).toContain('  operation setConfig(config : const app::Config&)');
        expect(lines).toContain('private:');
    });

    test('casts keep their simple type syntax: `x as T < y` is a comparison', async () => {
        const parsed = await parseModel('', 'count = (count as integer < 3) ? 1 : 0');
        expect(parsed.hasSyntaxErrors).toBe(false);
        expect(errors(parsed)).toEqual([]);
    });
});

describe('C++ class sections: validation', () => {
    test('members, methods and their use in the model', async () => {
        const parsed = await parseModel(MEMBERS, 'errorCnt++; setup(); setConfig(config); count = retries() + errorCnt + maxErrors; config.retries = errorCnt; ratio *= 2');
        expect(errors(parsed)).toEqual([]);
        // members of the class sections are also used by the C++ code: no "never used" infos
        expect(parsed.diagnostics.filter(d => d.severity === 3).map(d => d.message)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
    });

    test('types of the model: C++ types of the headers and fundamental types; others make a member unusable', async () => {
        const parsed = await parseModel(MEMBERS);
        const members = new Map(parsed.model.scopes.filter(ast.isClassScope).flatMap(s => s.declarations).map(d => [d.name, d]));
        expect(typeName(typeOfVariable(members.get('errorCnt') as ast.VariableDeclaration))).toBe('integer');
        expect(typeName(typeOfVariable(members.get('ratio') as ast.VariableDeclaration))).toBe('real');
        expect(typeName(typeOfVariable(members.get('config') as ast.VariableDeclaration))).toBe('app::Config');
        expect(typeName(typeOfVariable(members.get('values') as ast.VariableDeclaration))).toBe('std::array<int, 4>');
        expect(describeMemberType((members.get('errorCnt') as ast.VariableDeclaration).type!)).toBe('unsigned int (integer)');
        expect(['setConfig', 'retries', 'setup', 'errorCnt', 'config', 'values'].map(name => isUsableInModel(members.get(name)!))).toEqual([true, true, true, true, true, true]);
        expect(unusableReason(members.get('driver')!)).toContain("its type 'app::Driver*' is not a type of the model: 'app::Driver*' is not supported (pointer type)");
        expect(unusableReason(members.get('attach')!)).toContain("the type of the parameter 'driver' 'app::Driver*'");
        expect(unusableReason(members.get('names')!)).toContain('std::vector');
        expect(unusableReason(members.get('table')!)).toBeDefined();
    });

    test('members whose types the model does not know cannot be used in the model', async () => {
        const parsed = await parseModel(MEMBERS, 'attach(driver)');
        expect(errors(parsed)).toEqual([
            "The member 'attach' cannot be used in the model: the type of the parameter 'driver' 'app::Driver*' is not a type of the model: 'app::Driver*' is not supported (pointer type). It can only be used by the C++ code of the application.",
            "The member 'driver' cannot be used in the model: its type 'app::Driver*' is not a type of the model: 'app::Driver*' is not supported (pointer type). It can only be used by the C++ code of the application."
        ]);
        const unknown = await parseModel('    private:\n        var helper : app::Helper', 'count = helper');
        expect(errors(unknown)).toEqual([expect.stringContaining("The member 'helper' cannot be used in the model: its type 'app::Helper' is not a type of the model")]);
        const text = await parseModel('    private:\n        var name : const char*\n        operation label() : const char*', 'count = label() == "x" ? 1 : 0; count = name == "y" ? 1 : 0');
        expect(errors(text)).toEqual([
            expect.stringContaining("The member 'label' cannot be used in the model: the return type 'const char*' cannot hold the strings of the model (std::string)"),
            expect.stringContaining("The member 'name' cannot be used in the model: its type 'const char*' cannot hold the strings of the model (std::string)")
        ]);
        const reference = await parseModel('    public:\n        operation fill(target : app::Config&)', 'fill(app::kMax)');
        expect(errors(reference)).toEqual([expect.stringContaining("the type of the parameter 'target' is a non-const reference ('app::Config&')")]);
    });

    test('C++ type syntax is only allowed in the class sections', async () => {
        const parsed = await parseModel('        var a : const integer\n        operation f(x : app::Config&) : void\n        var b : std::array<int, 2>\n        var c : int');
        expect(errors(parsed)).toEqual([
            "C++ type syntax ('const', references, pointers, template arguments) can only be used in the C++ class sections (public:, protected:, private:).",
            "C++ type syntax ('const', references, pointers, template arguments) can only be used in the C++ class sections (public:, protected:, private:).",
            "C++ type syntax ('const', references, pointers, template arguments) can only be used in the C++ class sections (public:, protected:, private:).",
            expect.stringContaining("Unknown type 'int'")
        ]);
    });

    test('declarations of the class sections', async () => {
        const parsed = await parseModel([
            '    private:',
            '        in event e',
            '        alias Count : integer',
            '        var r : const app::Config& = app::kMax',
            '        const q : app::Config&',
            '        var c : const unsigned int = 1',
            '        static var s : int',
            '        static operation f()',
            '        const k : unsigned int',
            '        var v : std::vector<int'
        ].join('\n'));
        expect(errors(parsed)).toEqual([
            "Events cannot be declared in 'private:'; the class sections contain variables, constants and operations (members of the generated C++ class).",
            "Type aliases cannot be declared in 'private:'; the class sections contain variables, constants and operations (members of the generated C++ class).",
            "The reference member 'r' cannot have an initial value: it is bound by the constructor of the generated class.",
            "The reference member 'q' cannot be declared with 'const'; write 'var q : const T&' for a reference to a constant.",
            "Declare the constant member with 'const c : unsigned int' instead of 'const' in the type.",
            "Static members are not supported: 's' cannot be 'static' (declare it without 'static').",
            "Static members are not supported: 'f' cannot be 'static' (declare it without 'static').",
            "Constant 'k' must have an initial value.",
            "The angle brackets of the template arguments of 'std::vector<int' are not balanced."
        ]);
    });

    test('const operations are member functions of the class sections; references to constants cannot be assigned', async () => {
        const parsed = await parseModel([
            '        const operation g() : integer',
            '    public:',
            '        const operation ready() : bool',
            '        var settings : const app::Config&',
            '        var target : app::Config&'
        ].join('\n'), 'count = ready() ? settings.retries : 0; target.retries = 1; settings.retries = 2; settings = target');
        expect(errors(parsed)).toEqual([
            "Only the operations of the C++ class sections (public:, protected:, private:) can be const member functions; remove 'const'.",
            "Cannot assign a value to 'settings.retries': it is a reference to a constant ('const app::Config&').",
            "Cannot assign a value to 'settings': it is a reference to a constant ('const app::Config&')."
        ]);
    });

    test('headers in angle brackets are only included', async () => {
        const withIncludes = (definitions: string, effect = '') => model(definitions, effect).replace('    import "app.h"', '    import "app.h"\n    import "<vector>"\n    import "<sys/types.h>"');
        const parsed = await parse(withIncludes('    private:\n        var values : std::vector<int>'), { 'app.h': APP_H });
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
        const header = generateCpp(parsed.model).files.find(f => f.path === 'M.h')!.content;
        expect(header).toContain('#include "app.h"\n#include <vector>\n#include <sys/types.h>\n');
        const used = await parse(withIncludes('    private:\n        var values : std::vector<int>', 'count = values'), { 'app.h': APP_H });
        expect(errors(used)).toEqual([expect.stringContaining("The member 'values' cannot be used in the model")]);
        expect(generateC((await parse('statemachine M {\n    import "<vector>"\n    [*] -> A\n    state A\n}')).model).diagnostics.map(d => d.message).join())
            .toContain('C++ header types are not supported by the C generator');
    });

    test('initial values of members are evaluated when the object is constructed', async () => {
        const parsed = await parseModel([
            '    public:',
            '        operation f() : integer',
            '    private:',
            '        var a : int = app::kMax * 2',
            '        var b : int = a + 1',
            '        var c : int = d',
            '        var d : int = count',
            '        var e : int = f()',
            '        var g : int = g'
        ].join('\n'));
        expect(errors(parsed)).toEqual([
            "The initial value of the member 'c' is evaluated when the object is constructed: 'd' is declared later (use literals, C++ constants and the members declared before).",
            "The initial value of the member 'd' is evaluated when the object is constructed: 'count' is not a member of a class section (use literals, C++ constants and the members declared before).",
            "The initial value of the member 'e' is evaluated when the object is constructed: operations cannot be called (use literals, C++ constants and the members declared before).",
            "The initial value of the member 'g' is evaluated when the object is constructed: 'g' is declared here (use literals, C++ constants and the members declared before)."
        ]);
    });

    test('names are unique across interfaces, the internal scope and the class sections; constants cannot be assigned', async () => {
        const parsed = await parseModel('    private:\n        var count : int\n        const limit : int = 3', 'limit = 4');
        expect(errors(parsed)).toEqual([
            "Duplicate declaration 'count'.",
            "Cannot assign a value to the constant 'limit'."
        ]);
    });
});

describe('C++ class sections: simulation', () => {
    test('members are initialized when the interpreter is created and are not reset by enter()', async () => {
        const parsed = await parseModel(MEMBERS, 'errorCnt++; count += 1; setConfig(config)');
        expect(errors(parsed)).toEqual([]);
        const calls: string[] = [];
        const sim = new StatechartInterpreter(parsed.model, { operations: { setConfig: (config: unknown) => { calls.push(JSON.stringify(config)); } } });
        expect(sim.getVariable('errorCnt')).toBe(1);
        expect(sim.getVariable('maxErrors')).toBe(4);
        sim.setVariable('errorCnt', 5);
        sim.enter();
        sim.raise('go');
        sim.runCycle();
        expect(sim.variables).toMatchObject({ errorCnt: 6, count: 1, ratio: 0.5, config: { retries: 2, mode: 'app::Mode::Off' } });
        expect(Object.keys(sim.variables)).not.toContain('driver');
        expect(calls).toEqual(['{"retries":2,"mode":"app::Mode::Off"}']);
        sim.exit();
        sim.enter();
        expect(sim.variables).toMatchObject({ errorCnt: 6, count: 0 });
    });

    test('unsigned members wrap around like in C++', async () => {
        const parsed = await parseModel('    private:\n        var small : unsigned char = 255', 'small++');
        expect(errors(parsed)).toEqual([]);
        const sim = new StatechartInterpreter(parsed.model);
        sim.enter();
        sim.raise('go');
        sim.runCycle();
        expect(sim.getVariable('small')).toBe(0);
    });

    test('the example examples/cpp-class-sections: model and unit tests', async () => {
        const services = createHsmServices(NodeFileSystem);
        installNodeHeaderSupport(services.shared);
        const workspace = new HsmTestWorkspace(services);
        const documents = await workspace.load(['controller.hsm', 'controller.hsmtest'].map(name => ({
            uri: pathToFileURL(path.join(EXAMPLE_DIRECTORY, name)).toString(),
            text: fs.readFileSync(path.join(EXAMPLE_DIRECTORY, name), 'utf-8')
        })));
        for (const loaded of documents) {
            expect(loaded.diagnostics.filter(d => d.severity === 1).map(d => d.message), loaded.uri).toEqual([]);
        }
        const results = workspace.runDocuments(documents);
        expect(results).toHaveLength(3);
        expect(results.filter(r => r.status !== 'passed').map(r => `${r.name}: ${r.message}`)).toEqual([]);
    });

    test('unit tests cannot mock or check members the model cannot use', async () => {
        const workspace = new HsmTestWorkspace();
        const documents = await workspace.load([
            { uri: 'memory:///class/m.hsm', text: model(MEMBERS) },
            { uri: 'memory:///class/app.h', text: APP_H },
            { uri: 'memory:///class/t.hsmtest', text: 'testclass T for statemachine M {\n    @Test\n    operation t() {\n        mock attach returns (true)\n        assert called setup\n        assert driver == driver\n    }\n}' }
        ]);
        const test = documents[documents.length - 1];
        expect(test.diagnostics.filter(d => d.severity === 1).map(d => d.message)).toEqual([
            expect.stringContaining("The member 'attach' cannot be used in the model"),
            expect.stringContaining("The member 'driver' cannot be used in the model"),
            expect.stringContaining("The member 'driver' cannot be used in the model")
        ]);
    });
});

describe('C++ class sections: formatting and documentation', () => {
    test('the formatter indents the class sections and normalizes C++ types', async () => {
        const text = 'statemachine M{import "app.h"\npublic:\n/** Doc. */\noperation f( a :const  app::Config & , b : std::map < int ,const char * > ) :unsigned int\nprivate: var x:std::vector<std::vector<int> > [*]->A state A}';
        const parsed = await parse(text, { 'app.h': APP_H });
        expect(parsed.hasSyntaxErrors).toBe(false);
        const edits = await loader.services.Hsm.lsp.Formatter!.formatDocument(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() },
            options: { tabSize: 4, insertSpaces: true }
        });
        expect(TextDocument.applyEdits(parsed.document.textDocument, edits)).toBe([
            'statemachine M {',
            '    import "app.h"',
            '    public:',
            '        /** Doc. */',
            '        operation f(a : const app::Config&, b : std::map<int, const char*>) : unsigned int',
            '    private:',
            '        var x : std::vector<std::vector<int>>',
            '    [*] -> A',
            '    state A',
            '}'
        ].join('\n'));
    });

    test('the model documentation shows the class sections with the C++ types', async () => {
        const parsed = await parseModel(MEMBERS);
        const doc = describeStateMachine(parsed.model);
        expect(doc.scopes.map(s => s.kind)).toEqual(['interface', 'public', 'protected', 'private']);
        expect(doc.scopes[1].operations[0]).toMatchObject({ name: 'setConfig', signature: 'setConfig(config : const app::Config&) : void', documentation: 'Sets the configuration.' });
        expect(doc.scopes[3].variables[0]).toMatchObject({ name: 'errorCnt', type: 'unsigned int', initialValue: '1' });
        expect(generateModelDoc(doc)).toContain('### C++ class section `public:`');
    });

    test('the examples of the documentation are valid', async () => {
        const docs = path.resolve(__dirname, '../../../docs');
        const language = fs.readFileSync(path.join(docs, 'language.md'), 'utf-8');
        const section = language.slice(language.indexOf('## C++ class sections'));
        const example = /```\n([\s\S]*?)```/.exec(section)![1];
        const header = 'namespace EpicProject {\nstruct Config { unsigned int maxErrors = 3; };\nclass Driver;\n}';
        const parsed = await parse(example, { 'path/to/header.h': header });
        expect(errors(parsed)).toEqual([]);
        expect(generateCpp(parsed.model).diagnostics).toEqual([]);
        // the implementation in docs/cpp-generator.md is the one of the example
        const generator = fs.readFileSync(path.join(docs, 'cpp-generator.md'), 'utf-8');
        const implementation = /```cpp\n\/\/ ControllerMethods\.cpp[^\n]*\n([\s\S]*?)```/.exec(generator)![1];
        const file = fs.readFileSync(path.join(EXAMPLE_DIRECTORY, 'ControllerMethods.cpp'), 'utf-8');
        expect(file.slice(file.indexOf('#include'))).toBe(implementation);
    });
});

describe('C++ class sections: code generation', () => {
    test('the members are declared in the generated class with their access and doc comments', async () => {
        const parsed = await parseModel(MEMBERS, 'errorCnt++; setup(); setConfig(config); count = retries()');
        const result = generateCpp(parsed.model);
        expect(result.diagnostics).toEqual([]);
        const header = result.files.find(f => f.path === 'M.h')!.content;
        const section = (access: string) => header.slice(header.indexOf(`\n${access}:\n    // declared in the model`), header.indexOf('\n\n', header.indexOf(`\n${access}:\n    // declared in the model`) + 1));
        expect(section('public')).toBe([
            '',
            'public:',
            '    // declared in the model (public:)',
            '    /** Sets the configuration. */',
            '    virtual void setConfig(const app::Config& config);',
            '    virtual unsigned int retries();'
        ].join('\n'));
        expect(header).toContain([
            'protected:',
            '    // declared in the model (protected:)',
            '    virtual void setup();',
            '    virtual bool attach(app::Driver* driver);',
            '    app::Driver* driver{};'
        ].join('\n'));
        expect(header).toContain([
            'private:',
            '    // declared in the model (private:)',
            '    unsigned int errorCnt = 1;',
            '    const unsigned int maxErrors = static_cast<unsigned int>(int_add(app::kMax, 1));',
            '    app::Config config{};',
            '    double ratio = 0.5;',
            '    std::vector<std::vector<int>> names{};',
            '    std::map<int, const char*> table{};',
            '    std::array<int, 4> values{};'
        ].join('\n'));
        // no callbacks, getters or setters for the members of the class sections
        expect(header).not.toContain('OperationCallback');
        expect(header).not.toContain('get_errorCnt');
        const source = result.files.find(f => f.path === 'M.cpp')!.content;
        expect(source).toContain('errorCnt = static_cast<unsigned int>(int_add(errorCnt, 1));');
        expect(source).toContain('setup();');
        expect(source).toContain('setConfig(config);');
        expect(source).toContain('sc::integer t1 = retries();');
        // the members are not reset by enter()
        expect(source).not.toMatch(/errorCnt = 1;|config = app::Config\{\}/);
    });

    test('multi-line doc comments are re-indented, Doxygen commands are kept', async () => {
        const parsed = await parseModel('    protected:\n/**\n   * @brief Setup function.\n      * Details.\n */\n        operation setup()');
        const header = generateCpp(parsed.model).files.find(f => f.path === 'M.h')!.content;
        expect(header).toContain([
            '    /**',
            '     * @brief Setup function.',
            '     * Details.',
            '     */',
            '    virtual void setup();'
        ].join('\n'));
    });

    test('const member functions, non-virtual member functions (option) and reference members bound by the constructor', async () => {
        const parsed = await parseModel([
            '    public:',
            '        const operation ready(limit : unsigned int) : bool',
            '    private:',
            '        var settings : const app::Config&',
            '        var driver : app::Driver&',
            '        var n : int = 1'
        ].join('\n'), 'count = ready(n) ? settings.retries : 0');
        expect(errors(parsed)).toEqual([]);
        const result = generateCpp(parsed.model, { virtualMethods: false });
        const header = result.files.find(f => f.path === 'M.h')!.content;
        expect(header).toContain('    bool ready(unsigned int limit) const;');
        expect(header).toContain('    M(const app::Config& settings_, app::Driver& driver_);');
        expect(header).not.toContain('    M();');
        expect(header).toContain('    const app::Config& settings;\n    app::Driver& driver;\n    int n = 1;');
        const source = result.files.find(f => f.path === 'M.cpp')!.content;
        expect(source).toContain('M::M(const app::Config& settings_, app::Driver& driver_) : settings(settings_), driver(driver_) {');
        // the option of hsm.gen.json
        const config = parseGeneratorConfig({ models: ['*.hsm'], cpp: { virtualMethods: false } });
        expect(config.diagnostics).toEqual([]);
        expect(generateTarget(parsed.model, 'cpp', config.config!.cpp!).files.find(f => f.path === 'M.h')!.content).toContain('    bool ready(unsigned int limit) const;');
        expect(generateTarget(parsed.model, 'cpp', {}).files.find(f => f.path === 'M.h')!.content).toContain('    virtual bool ready(unsigned int limit) const;');
        expect(parseGeneratorConfig({ models: ['*.hsm'], cpp: { virtualMethods: 'no' } }).diagnostics.map(d => d.message).join()).toContain('must be true or false');
        // a single reference member: explicit constructor
        const single = await parseModel('    private:\n        var settings : const app::Config&');
        expect(generateCpp(single.model).files.find(f => f.path === 'M.h')!.content).toContain('    explicit M(const app::Config& settings_);');
    });

    test('names of members must be C++ identifiers that do not clash with the generated class', async () => {
        const keyword = await parseModel('    private:\n        var register : integer');
        expect(keyword.hasSyntaxErrors).toBe(false);
        expect(generateCpp(keyword.model).diagnostics.map(d => d.message)).toEqual([expect.stringContaining("The member name 'register' is a C++ keyword")]);
        const clash = await parseModel('    public:\n        operation enter()');
        expect(generateCpp(clash.model).diagnostics.map(d => d.message)).toEqual([
            "The generated C++ identifier 'enter' is not unique; rename a state, event, variable, operation or interface (the member 'enter' of a class section is used by the generated class)"
        ]);
        const data = await parseModel('    private:\n        var running : boolean');
        expect(generateCpp(data.model).diagnostics.map(d => d.message)).toEqual([expect.stringContaining("'running' is not unique")]);
    });

    test('the C generator reports the class sections', async () => {
        const parsed = await parse('statemachine M {\n    public:\n        operation f()\n    [*] -> A\n    state A {\n        entry / f()\n    }\n}');
        expect(errors(parsed)).toEqual([]);
        expect(generateC(parsed.model).diagnostics.map(d => d.message).join()).toContain(CLASS_SECTIONS_NOT_SUPPORTED);
    });
});
