/*
 * Unit test language for the state machines of the Device Modeler (file extension `.devmtest`),
 * modeled after SCTUnit of itemis CREATE:
 *
 *   testclass DoorTest for statemachine Door {
 *       @SetUp
 *       operation init() { enter }
 *
 *       @Test
 *       operation opens() {
 *           assert active(Door.Closed)
 *           raise open
 *           proceed 1 cycle
 *           assert active(Moving.Up) message "the door opens"
 *           assert !called stopMotor
 *       }
 *   }
 *
 * The expressions are the expressions of the HSM language (imported from `hsm.langium`). Names are
 * resolved against the declarations of the referenced state machine and the local variables and
 * parameters of the test operation.
 */
grammar HsmTest
import './hsm'

entry TestModel:
    testClasses+=TestClass*;

TestClass:
    'testclass' name=HsmId 'for' 'statemachine' machine=[StateMachine:HsmId] '{'
        operations+=TestOperation*
    '}';

// `@Test` marks a test, `@SetUp` an operation executed before every test; other operations are helpers.
TestOperation:
    annotations+=Annotation*
    'operation' name=HsmId '(' (parameters+=TestParameter (',' parameters+=TestParameter)*)? ')' body=Block;

// Parameters are variables of the operation, so that they can be referenced in expressions.
TestParameter infers VariableDeclaration:
    name=HsmId ':' type=TypeReference;

Block:
    {infer Block} '{' (statements+=TestStatement ';'?)* '}';

TestStatement:
    EnterStatement
    | ExitStatement
    | RaiseStatement
    | ProceedStatement
    | AssertCalledStatement
    | AssertStatement
    | MockStatement
    | LocalVariableStatement
    | IfStatement
    | WhileStatement
    | OperationCallStatement
    | AssignmentStatement;

EnterStatement:
    {infer EnterStatement} 'enter';

ExitStatement:
    {infer ExitStatement} 'exit';

// `proceed 2 cycles` or `proceed 200 ms` (the unit is checked by the validator: cycle(s), s, ms, us, ns)
ProceedStatement:
    'proceed' value=PrimaryExpression unit=ID;

AssertStatement:
    'assert' expression=Expression ('message' message=STRING)?;

// `assert called op`, `assert called op with (1, true) times 2`, `assert !called op`
AssertCalledStatement:
    'assert' negated?='!'? 'called' operation=[OperationDeclaration:QualifiedName]
    ('with' '(' (arguments+=Expression (',' arguments+=Expression)*)? ')')?
    ('times' times=Expression)?
    ('message' message=STRING)?;

// `mock op returns (true)` or, for specific arguments, `mock op(1) returns (true)`
MockStatement:
    'mock' operation=[OperationDeclaration:QualifiedName]
    (withArguments?='(' (arguments+=Expression (',' arguments+=Expression)*)? ')')?
    'returns' '(' value=Expression ')';

LocalVariableStatement:
    declaration=VariableDeclaration;

IfStatement:
    'if' '(' condition=Expression ')' then=Block ('else' (else=Block | elseIf=IfStatement))?;

WhileStatement:
    'while' '(' condition=Expression ')' body=Block;

OperationCallStatement:
    operation=[TestOperation:HsmId] '(' (arguments+=Expression (',' arguments+=Expression)*)? ')';

// assignments (`x = 1`, `i += 1`) and `x++` / `x--`
AssignmentStatement:
    expression=TestAssignment;

TestAssignment infers Expression:
    TestTarget (
        {infer AssignmentExpression.left=current} operator=AssignmentOperator value=Expression
        | {infer PostfixExpression.operand=current} operator=('++' | '--')
    );

// the assigned variable, optionally with members / elements of C++ struct / array values (`pos.x`, `a[1]`)
TestTarget infers Expression:
    ElementReference (
        {infer MemberAccessExpression.receiver=current} '.' member=HsmId
        | {infer IndexExpression.receiver=current} '[' index=Expression ']'
    )*;
