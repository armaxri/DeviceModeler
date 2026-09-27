/**
 * C++ header analyzer: extracts the types and constants of C++ headers (namespaces, enums, structs,
 * aliases, constants) for the C++ integration of state machine models, resolves them across headers
 * and evaluates constant expressions. Pure TypeScript without Node dependencies (runs in the
 * browser, too). See `docs/cpp-integration.md` for the supported subset.
 *
 * @module
 */
export * from './model.js';
export { parseCppHeader, forEachCppDeclaration } from './parser.js';
export { CppTypeIndex, type CppConstantInfo, type CppEvaluationResult, type CppTypeDeclaration, type CppTypeIndexOptions } from './type-index.js';
export { cppHeaderReport, cppValueToJson, describeCppType } from './report.js';
