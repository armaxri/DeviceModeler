import {
    AstUtils, DefaultScopeProvider, EMPTY_SCOPE, MapScope,
    type AstNode, type AstNodeDescription, type LangiumCoreServices, type ReferenceInfo, type Scope
} from 'langium';
import * as ast from '../generated/ast.js';
import { resolvedImports, type ResolvedImport } from '../imports.js';
import { collectVertices, firstMatchScope, globalSuffixes, instanceMemberNames, instanceStateNames } from '../statemachine-scope.js';

/** Built-in names of the test language, available in all expressions of a test class. */
export const BUILTIN_VARIABLES = ['is_final'] as const;
export type BuiltinVariable = typeof BUILTIN_VARIABLES[number];

const builtinNames = new WeakMap<ast.VariableDeclaration, BuiltinVariable>();
const builtinsOfClass = new WeakMap<ast.TestClass, ast.VariableDeclaration[]>();

/** The name of a built-in variable (`is_final`), `undefined` for other declarations. */
export function builtinVariable(node: AstNode | undefined): BuiltinVariable | undefined {
    return ast.isVariableDeclaration(node) ? builtinNames.get(node) : undefined;
}

/**
 * Synthetic (read-only) declarations of the built-in variables of a test class. They are attached
 * to the test class (but not part of its content), so the linker, the type system and the
 * validator treat them like constants of type boolean.
 */
export function builtinDeclarations(testClass: ast.TestClass): ast.VariableDeclaration[] {
    let builtins = builtinsOfClass.get(testClass);
    if (!builtins) {
        builtins = BUILTIN_VARIABLES.map((name, index) => {
            const declaration = {
                $type: 'VariableDeclaration', $container: testClass, $containerProperty: 'builtins', $containerIndex: index,
                name, const: true, readonly: true
            } as unknown as ast.VariableDeclaration & { type: ast.TypeReference };
            declaration.type = {
                $type: 'TypeReference', $container: declaration, $containerProperty: 'type', name: 'boolean'
            } as unknown as ast.TypeReference;
            builtinNames.set(declaration, name);
            return declaration;
        });
        builtinsOfClass.set(testClass, builtins);
    }
    return builtins;
}

/** Whether a variable is declared in a test (local variable or parameter of a test operation). */
export function isLocalVariable(variable: ast.VariableDeclaration): boolean {
    return ast.isLocalVariableStatement(variable.$container) || ast.isTestOperation(variable.$container);
}

/** The state machine tested by the test class containing `node` (if it can be resolved). */
export function testedMachine(node: AstNode): ast.StateMachine | undefined {
    return AstUtils.getContainerOfType(node, ast.isTestClass)?.machine.ref;
}

/**
 * Name resolution of the test language.
 *
 * - `testclass T for statemachine M`: `M` is looked up in the global index, i.e. in all `.devm`
 *   documents of the workspace.
 * - Declarations (events, variables, operations) of `M` are referenced like inside `M`: by their
 *   simple name, or by `Interface.name` for named interfaces.
 * - States are referenced by their (partially) qualified name inside `M` (`Moving.Up`, or a unique
 *   suffix like `Up`), optionally prefixed with the name of the state machine (`Door.Moving.Up`).
 * - In expressions, local variables and parameters of the enclosing test operation shadow the
 *   built-in variables (`is_final`) which shadow the declarations of the state machine.
 * - Members of the submachine instances of `M` are referenced like inside `M`: `motor.speed`,
 *   `valueof(motor.failed)`, `active(motor.Running)`, `mock motor.setPwm returns (...)`; events of
 *   instances cannot be raised by a test.
 */
export class DevmTestScopeProvider extends DefaultScopeProvider {

    private readonly declarationScopes = new WeakMap<ast.StateMachine, { imports: readonly ResolvedImport[], scopes: Map<string, Scope> }>();
    private readonly vertexScopes = new WeakMap<ast.StateMachine, Scope>();

    constructor(services: LangiumCoreServices) {
        super(services);
    }

    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        if (ast.isTestClass(container)) {
            return super.getScope(context);
        }
        if (ast.isOperationCallStatement(container)) {
            const testClass = AstUtils.getContainerOfType(container, ast.isTestClass);
            return testClass ? new MapScope(testClass.operations.map(op => this.descriptions.createDescription(op, op.name))) : EMPTY_SCOPE;
        }
        const machine = testedMachine(container);
        if (!machine) {
            return EMPTY_SCOPE;
        }
        if (ast.isActiveExpression(container)) {
            return firstMatchScope(this.vertexScope(machine), this.instanceVertexScope(machine));
        }
        if (ast.isRaiseStatement(container)) {
            return this.declarationScope(machine, 'raise', ast.isEventDeclaration, false);
        }
        if (ast.isValueOfExpression(container)) {
            return this.declarationScope(machine, 'events', ast.isEventDeclaration);
        }
        if (ast.isAssertCalledStatement(container) || ast.isMockStatement(container)) {
            return this.declarationScope(machine, 'operations', ast.isOperationDeclaration);
        }
        if (ast.isElementReference(container)) {
            return this.localScope(container, this.declarationScope(machine, 'all', () => true));
        }
        return EMPTY_SCOPE;
    }

    /** Local variables and parameters visible at `node`, then the built-ins, then `outer`. */
    protected localScope(node: AstNode, outer: Scope): Scope {
        const testClass = AstUtils.getContainerOfType(node, ast.isTestClass);
        let scope = testClass
            ? new MapScope(builtinDeclarations(testClass).map(d => this.builtinDescription(d, testClass)), outer)
            : outer;
        const levels: ast.VariableDeclaration[][] = [];
        let child: AstNode = node;
        for (let current = node.$container; current; child = current, current = current.$container) {
            if (ast.isBlock(current)) {
                const index = current.statements.indexOf(child as ast.TestStatement);
                const visible = current.statements.slice(0, index < 0 ? current.statements.length : index);
                levels.push(visible.filter(ast.isLocalVariableStatement).map(s => s.declaration));
            } else if (ast.isTestOperation(current)) {
                levels.push(current.parameters);
                break;
            }
        }
        for (const declarations of levels.reverse()) {
            // later declarations with the same name shadow earlier ones
            const byName = new Map(declarations.map(d => [d.name, d]));
            scope = new MapScope([...byName.values()].map(d => this.descriptions.createDescription(d, d.name)), scope);
        }
        return scope;
    }

    protected builtinDescription(declaration: ast.VariableDeclaration, testClass: ast.TestClass): AstNodeDescription {
        const document = AstUtils.getDocument(testClass);
        return { node: declaration, name: declaration.name, type: declaration.$type, documentUri: document.uri, path: '' };
    }

    /** The declarations of the machine and (if `members` is set) of the interfaces of its submachine instances (`motor.speed`). */
    protected declarationScope(machine: ast.StateMachine, key: string, filter: (declaration: ast.Declaration) => boolean, members = true): Scope {
        // recomputed when the imports of the machine were resolved again (see imports.ts)
        const imports = resolvedImports(machine);
        let cached = this.declarationScopes.get(machine);
        if (!cached || cached.imports !== imports) {
            cached = { imports, scopes: new Map() };
            this.declarationScopes.set(machine, cached);
        }
        const scopes = cached.scopes;
        let scope = scopes.get(key);
        if (!scope) {
            const descriptions: AstNodeDescription[] = [];
            for (const machineScope of machine.scopes) {
                for (const declaration of machineScope.declarations) {
                    if (filter(declaration)) {
                        const name = ast.isInterfaceScope(machineScope) && machineScope.name ? `${machineScope.name}.${declaration.name}` : declaration.name;
                        descriptions.push(this.descriptions.createDescription(declaration, name));
                    }
                }
            }
            if (members) {
                for (const member of instanceMemberNames(machine)) {
                    if (filter(member.declaration)) {
                        descriptions.push(this.descriptions.createDescription(member.declaration, member.name));
                    }
                }
            }
            scope = new MapScope(descriptions);
            scopes.set(key, scope);
        }
        return scope;
    }

    /** States of the submachine instances: `motor.Running`, `Door.motor.Running`. */
    protected instanceVertexScope(machine: ast.StateMachine): Scope {
        return new MapScope(instanceStateNames(machine).flatMap(entry => [
            this.descriptions.createDescription(entry.vertex, entry.name),
            this.descriptions.createDescription(entry.vertex, `${machine.name}.${entry.name}`)
        ]));
    }

    /** Qualified names (`Moving.Up`, `Door.Moving.Up`), then unique suffixes (`Up`, `Door.Up`). */
    protected vertexScope(machine: ast.StateMachine): Scope {
        let scope = this.vertexScopes.get(machine);
        if (!scope) {
            const outer = new MapScope(globalSuffixes(machine).flatMap(entry => [
                this.descriptions.createDescription(entry.vertex, entry.name),
                this.descriptions.createDescription(entry.vertex, `${machine.name}.${entry.name}`)
            ]));
            const descriptions: AstNodeDescription[] = [];
            const names = new Set<string>();
            collectVertices(machine, [], entry => {
                for (const name of [entry.name, `${machine.name}.${entry.name}`]) {
                    if (!names.has(name)) {
                        names.add(name);
                        descriptions.push(this.descriptions.createDescription(entry.vertex, name));
                    }
                }
            });
            scope = new MapScope(descriptions, outer);
            this.vertexScopes.set(machine, scope);
        }
        return scope;
    }
}
