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
        ('namespace' namespace=QualifiedName)?
        annotations+=Annotation*
        scopes+=Scope*
        (vertices+=Vertex | transitions+=Transition)*
    '}';

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
    EventDeclaration | VariableDeclaration | OperationDeclaration;

EventDeclaration:
    (direction=('in' | 'out'))? 'event' name=ID (':' type=TypeReference)?;

VariableDeclaration:
    (const?='const' | 'var' readonly?='readonly'?) name=ID (':' type=TypeReference)? ('=' initialValue=Expression)?;

OperationDeclaration:
    'operation' name=ID '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')' (':' returnType=TypeReference)?;

Parameter:
    name=ID (varArgs?='...')? ':' type=TypeReference;

// Types are referenced by name (integer, real, boolean, string, void) so that further types can be added later.
TypeReference:
    name=ID;

// ---------------------------------------------------------------------------------------------
// States

Vertex:
    State | PseudoState;

State:
    'state' name=ID (description=STRING)? ('{'
        (reactions+=LocalReaction | vertices+=Vertex | transitions+=Transition | regions+=Region)*
    '}')?;

// Orthogonal (concurrent) region of a composite state.
Region:
    'region' (name=ID)? '{'
        (vertices+=Vertex | transitions+=Transition)*
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
// of the source state is reached.
Transition:
    (initial?='[*]' | source=[Vertex:QualifiedName]) '->' (final?='[*]' | target=[Vertex:QualifiedName])
    (':' spec=ReactionSpec)?
    ('#' (('>' entryPoint=ID) | (exitPoint=ID '>')))?;

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
    PrimaryExpression ({infer CastExpression.operand=current} 'as' type=TypeReference)*;

PrimaryExpression infers Expression:
    Literal
    | ParenthesizedExpression
    | ValueOfExpression
    | ActiveExpression
    | ElementReference;

ParenthesizedExpression:
    '(' expression=Expression ')';

// value of the last occurrence of an event with payload
ValueOfExpression:
    'valueof' '(' event=[EventDeclaration:QualifiedName] ')';

// whether a state is currently active
ActiveExpression:
    'active' '(' state=[Vertex:QualifiedName] ')';

// variable, constant or operation call
ElementReference:
    element=[Declaration:QualifiedName] (call?='(' (arguments+=Argument (',' arguments+=Argument)*)? ')')?;

Argument:
    (parameter=ID '=')? value=ConditionalExpression;

Literal:
    BoolLiteral | IntLiteral | RealLiteral | HexLiteral | StringLiteral;

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
