/*
 * Grammar for hierarchical state machines (HSM).
 *
 * The structure (states, regions, transitions) uses a PlantUML-like notation, the definition
 * section and all reactions (triggers, guards, effects) follow the statechart language of
 * itemis CREATE (formerly YAKINDU Statechart Tools):
 *
 *   statemachine Door {
 *       @CycleBased(200)
 *
 *       interface:
 *           in event open
 *           in event close
 *           out event opened
 *           var openCount : integer = 0
 *           operation motor(on : boolean) : void
 *
 *       [*] -> Closed
 *       state Closed {
 *           entry / motor(false)
 *       }
 *       state Opened
 *       Closed -> Opened : open [openCount < 3] / openCount += 1; raise opened
 *       Opened -> Closed : close, after 10 s
 *   }
 *
 * Vertices are referenced by (partially) qualified names: `Playing`, `Active.Playing` or
 * `Closed.Active.Playing`. A simple name is resolved in the scope of the transition first and
 * then outwards, so the same simple name may be used in different composite states.
 */
grammar Hsm

entry StateMachine:
    'statemachine' name=ID (description=STRING)? '{'
        imports+=Import*
        ('namespace' namespace=QualifiedName imports+=Import*)?
        // the definition section (annotations, interfaces, internal scope) comes first (checked by the validator)
        (annotations+=Annotation | scopes+=Scope | vertices+=Vertex | transitions+=Transition | reactions+=LocalReaction)*
    '}';

// ---------------------------------------------------------------------------------------------
// Imports

// `import "motor.hsm"` imports the state machine of another file (its name becomes a type, variables
// of that type are submachine instances), `import "motor_types.h"` a C/C++ header (its enums, structs,
// type aliases and constants can be used by their `::`-qualified names, see docs/cpp-integration.md).
// Several paths and the itemis CREATE form `import: "a" "b"` are accepted. Paths are resolved relative
// to the importing file, headers also relative to the include paths (see imports.ts, cpp-headers.ts).
Import:
    'import' (colon?=':')? paths+=ImportPath+;

ImportPath:
    path=STRING;

// ---------------------------------------------------------------------------------------------
// Definition section

Annotation:
    '@' name=ID ('(' (arguments+=Expression (',' arguments+=Expression)*)? ')')?;

Scope:
    InterfaceScope | InternalScope;

InterfaceScope:
    'interface' (name=ID)? ':' declarations+=Declaration*;

InternalScope:
    {infer InternalScope} 'internal' ':' declarations+=Declaration*;

Declaration:
    EventDeclaration | VariableDeclaration | OperationDeclaration | TypeAliasDeclaration;

EventDeclaration:
    (direction=('in' | 'out'))? 'event' name=ID (':' type=TypeReference)?;

VariableDeclaration:
    (const?='const' | 'var' readonly?='readonly'?) name=ID (':' type=TypeReference)? ('=' initialValue=Expression)?;

OperationDeclaration:
    'operation' name=ID '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')' (':' returnType=TypeReference)?;

Parameter:
    name=ID (varArgs?='...')? ':' type=TypeReference;

// `alias Name : type` (itemis CREATE): another name for a type; aliases may refer to other aliases.
TypeAliasDeclaration:
    'alias' name=ID ':' type=TypeReference;

// Types are referenced by name: the built-in types (integer, real, boolean, string, void), type
// aliases (`Name` or `Interface.Name` for aliases of a named interface), imported state machines
// (a variable of such a type is a submachine instance) and C++ types of imported headers
// (`motor::Mode`, `::Color`, `uint8_t`), see hsm-typesystem.ts and cpp-types.ts.
TypeReference:
    name=TypeReferenceName;

TypeReferenceName returns string:
    '::'? ID (('.' | '::') ID)*;

// ---------------------------------------------------------------------------------------------
// States

// Layout annotations (manual diagram layout, see docs/manual-layout.md and model-annotations.ts) are
// members of the state machine, states and regions: `@at(x, y)`, `@size(w, h)`, `@regions("vertical" |
// "horizontal")`, `@via(x1, y1, ...)` and `@label(dx, dy)` belong to the state, pseudo state, region or
// transition that follows them, `@initial(x, y)`, `@final(x, y)` and `@definitions(x, y)` to the state
// machine, state or region in whose body they are written.
Vertex:
    State | PseudoState;

// `state Moving : motor` binds the submachine instance `motor` (a variable whose type is an imported
// state machine) to the state: the instance runs while the state is active.
State:
    'state' name=ID (':' submachine=[VariableDeclaration:QualifiedName])? (description=STRING)? ('{'
        (annotations+=Annotation | reactions+=LocalReaction | vertices+=Vertex | transitions+=Transition | regions+=Region)*
    '}')?;

// Orthogonal (concurrent) region of a composite state.
Region:
    'region' (name=ID)? '{'
        (annotations+=Annotation | vertices+=Vertex | transitions+=Transition)*
    '}';

// `entry` and `exit` pseudo states are the named entry points / exit nodes of itemis CREATE.
PseudoState:
    kind=PseudoStateKind name=ID;

PseudoStateKind returns string:
    'choice' | 'junction' | 'history' | 'deephistory' | 'sync' | 'entry' | 'exit';

// Reaction of a state which does not leave the state, e.g. `entry / x = 0` or `tick [x > 3] / raise done`.
LocalReaction:
    (triggers+=Trigger (',' triggers+=Trigger)*)? ('[' guard=Expression ']')? '/' effect=Effect;

// `[*]` as source denotes the initial pseudo state (default entry) of the enclosing scope,
// `[*]` as target denotes the final state of the enclosing scope.
// `# >E` selects the entry point E of the target state, `# X>` fires when the exit node X
// of the source state is reached. As in itemis CREATE, one transition may handle several exit
// nodes (`# X1> X2>`); of several entry points (`# >E1 >E2`) only the first one is used.
Transition:
    (initial?='[*]' | source=[Vertex:QualifiedName]) '->' (final?='[*]' | target=[Vertex:QualifiedName])
    (':' spec=ReactionSpec)?
    ('#' (('>' entryPoints+=ID) | (exitPoints+=ID '>'))+)?;

// ---------------------------------------------------------------------------------------------
// Reactions: triggers [guard] / effect

ReactionSpec:
    {infer ReactionSpec}
    (triggers+=Trigger (',' triggers+=Trigger)*)?
    ('[' guard=Expression ']')?
    ('/' effect=Effect)?;

Trigger:
    EventTrigger | TimeTrigger | BuiltinTrigger;

EventTrigger:
    event=[EventDeclaration:QualifiedName];

// `after 10 s` fires once after the state was entered, `every 200 ms` periodically.
// The unit (s, ms, us, ns) is checked by the validator.
TimeTrigger:
    kind=('after' | 'every') value=PrimaryExpression unit=ID;

BuiltinTrigger:
    kind=('entry' | 'exit' | 'always' | 'oncycle' | 'else' | 'default');

Effect:
    statements+=Statement (';' statements+=Statement)* ';'?;

Statement:
    RaiseStatement | ExpressionStatement;

RaiseStatement:
    'raise' event=[EventDeclaration:QualifiedName] (':' value=Expression)?;

ExpressionStatement:
    expression=Expression;

// ---------------------------------------------------------------------------------------------
// Expressions (precedence from low to high)

Expression:
    AssignmentExpression;

AssignmentExpression infers Expression:
    ConditionalExpression ({infer AssignmentExpression.left=current} operator=AssignmentOperator value=AssignmentExpression)?;

AssignmentOperator returns string:
    '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '<<=' | '>>=' | '&=' | '|=' | '^=';

ConditionalExpression infers Expression:
    LogicalOrExpression ({infer ConditionalExpression.condition=current} '?' trueCase=ConditionalExpression ':' falseCase=ConditionalExpression)?;

LogicalOrExpression infers Expression:
    LogicalAndExpression ({infer BinaryExpression.left=current} operator='||' right=LogicalAndExpression)*;

LogicalAndExpression infers Expression:
    BitwiseOrExpression ({infer BinaryExpression.left=current} operator='&&' right=BitwiseOrExpression)*;

BitwiseOrExpression infers Expression:
    BitwiseXorExpression ({infer BinaryExpression.left=current} operator='|' right=BitwiseXorExpression)*;

BitwiseXorExpression infers Expression:
    BitwiseAndExpression ({infer BinaryExpression.left=current} operator='^' right=BitwiseAndExpression)*;

BitwiseAndExpression infers Expression:
    EqualityExpression ({infer BinaryExpression.left=current} operator='&' right=EqualityExpression)*;

EqualityExpression infers Expression:
    RelationalExpression ({infer BinaryExpression.left=current} operator=('==' | '!=') right=RelationalExpression)*;

RelationalExpression infers Expression:
    ShiftExpression ({infer BinaryExpression.left=current} operator=('<' | '<=' | '>' | '>=') right=ShiftExpression)*;

ShiftExpression infers Expression:
    AdditiveExpression ({infer BinaryExpression.left=current} operator=('<<' | '>>') right=AdditiveExpression)*;

AdditiveExpression infers Expression:
    MultiplicativeExpression ({infer BinaryExpression.left=current} operator=('+' | '-') right=MultiplicativeExpression)*;

MultiplicativeExpression infers Expression:
    UnaryExpression ({infer BinaryExpression.left=current} operator=('*' | '/' | '%') right=UnaryExpression)*;

UnaryExpression infers Expression:
    {infer UnaryExpression} operator=('!' | '~' | '-' | '+') operand=UnaryExpression
    | CastExpression;

CastExpression infers Expression:
    PostfixExpression ({infer CastExpression.operand=current} 'as' type=TypeReference)*;

// `x++` / `x--`: increments / decrements the variable, the value is the value before the operation
PostfixExpression infers Expression:
    AccessExpression ({infer PostfixExpression.operand=current} operator=('++' | '--'))?;

// Member access `valueof(e).x`, `motor::kHome.y` and element access `a[i]` of values of C++ struct and
// array types. (`pos.x` directly after a name is part of the name of the element reference, see
// ElementReference and hsm-linker.ts.)
AccessExpression infers Expression:
    PrimaryExpression (
        {infer MemberAccessExpression.receiver=current} '.' member=ID
        | {infer IndexExpression.receiver=current} '[' index=Expression ']'
    )*;

PrimaryExpression infers Expression:
    Literal
    | ParenthesizedExpression
    | ValueOfExpression
    | ActiveExpression
    | CppReference
    | ElementReference;

ParenthesizedExpression:
    '(' expression=Expression ')';

// value of the last occurrence of an event with payload
ValueOfExpression:
    'valueof' '(' event=[EventDeclaration:QualifiedName] ')';

// whether a state is currently active
ActiveExpression:
    'active' '(' state=[Vertex:QualifiedName] ')';

// variable, constant, operation call or event (an event in an expression is true if it is present).
// The name may continue with members of a value of a C++ struct type: `pos.x`, `cfg.home.y`; the
// linker resolves the longest prefix that names a declaration, the rest are members (see
// `referenceMembers` in cpp-types.ts).
ElementReference:
    element=[Declaration:QualifiedName] (call?='(' (arguments+=Argument (',' arguments+=Argument)*)? ')')?;

// A constant or enumerator of an imported C++ header by its qualified name: `motor::kMaxSpeed`,
// `motor::Mode::Fast`, `::HAL_OK` (names of the global namespace need the leading `::`).
CppReference:
    name=CppName;

CppName returns string:
    '::' ID ('::' ID)* | ID '::' ID ('::' ID)*;

Argument:
    (parameter=ID '=')? value=ConditionalExpression;

Literal:
    BoolLiteral | IntLiteral | RealLiteral | HexLiteral | StringLiteral | NullLiteral;

BoolLiteral:
    value=('true' | 'false');

IntLiteral:
    value=INT;

RealLiteral:
    value=REAL;

HexLiteral:
    value=HEX;

StringLiteral:
    value=STRING;

// `null`: only compatible with `string` (it denotes the empty string, see docs/semantics.md §2)
NullLiteral:
    {infer NullLiteral} 'null';

QualifiedName returns string:
    ID ('.' ID)*;

// ---------------------------------------------------------------------------------------------
// Terminals

hidden terminal WS: /\s+/;
terminal HEX: /0[xX][0-9a-fA-F]+/;
terminal REAL: /[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?/;
terminal INT returns number: /[0-9]+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
