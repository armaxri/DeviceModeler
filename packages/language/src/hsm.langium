/*
 * Grammar for hierarchical state machines (HSM).
 *
 * The notation is inspired by PlantUML state diagrams:
 *
 *   statemachine Door {
 *       [*] -> Closed
 *       state Closed {
 *           entry / "lock()"
 *       }
 *       state Opened
 *       Closed -> Opened : open [ "isUnlocked()" ] / "startMotor()"
 *   }
 *
 * State names are unique within a state machine, so transitions can refer to
 * any state regardless of the nesting level (like in PlantUML).
 */
grammar Hsm

entry StateMachine:
    'statemachine' name=ID (description=STRING)? '{'
        (vertices+=Vertex | transitions+=Transition)*
    '}';

// A vertex is anything a transition may start at or end in.
Vertex:
    State | PseudoState;

State:
    'state' name=ID (description=STRING)? ('{'
        (behaviors+=Behavior | vertices+=Vertex | transitions+=Transition | regions+=Region)*
    '}')?;

// Orthogonal (concurrent) region of a composite state.
Region:
    'region' (name=ID)? '{'
        (vertices+=Vertex | transitions+=Transition)*
    '}';

PseudoState:
    kind=PseudoStateKind name=ID;

PseudoStateKind returns string:
    'choice' | 'junction' | 'history' | 'deephistory';

Behavior:
    StateAction | InternalTransition;

// entry / exit actions and do activities of a state
StateAction:
    kind=('entry' | 'exit' | 'do') '/' action=STRING;

// Reaction to an event which does not leave the state.
InternalTransition:
    'on' event=ID ('[' guard=STRING ']')? ('/' effect=STRING)?;

// `[*]` as source denotes the initial pseudo state of the enclosing scope,
// `[*]` as target denotes the final state of the enclosing scope.
Transition:
    (initial?='[*]' | source=[Vertex:ID]) '->' (final?='[*]' | target=[Vertex:ID])
    (':' (event=ID)? ('[' guard=STRING ']')? ('/' effect=STRING)?)?;

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
