/*
 * The language of the Device Modeler (file extension `.devm`). A `.devm` file contains either a state
 * machine (statemachine.langium) or structure elements: structs, interfaces, components, subsystems and systems
 * (structure.langium), never both. The entry rule is the alternative of the two kinds, decided by the first
 * token (`statemachine` starts a state machine file, everything else - also an empty file - is a
 * structure file); text of the other kind after the model is reported by the parser
 * (devm-parser.ts: "A .devm file contains either a state machine or structure elements").
 *
 * Both grammars use the same keywords for different constructs (`import`, `interface`, `event`,
 * annotations `@...`); as the kind of the file is decided by the entry rule, every construct is parsed
 * by the rule of its kind and the surface syntax of both kinds stays as it is. The keywords of one kind
 * are accepted as names in the other kind (StateMachineId, StructureId).
 */
grammar Devm
import './statemachine'
import './structure'

entry DevmFile:
    StateMachine | StructureModel;
