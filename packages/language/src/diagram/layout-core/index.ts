/**
 * The shared core of the manual layouts of state machine diagrams (`.devm`) and structure diagrams
 * (`.devm`): the layout data model, the text edits of layout annotations, the node hierarchy, the
 * placement of nodes and the orthogonal routing of edges (see docs/architecture.md).
 */
export * from './model.js';
export * from './tree.js';
export * from './placement.js';
export * from './routing.js';
export * from './annotation-edits.js';
export { crossesRect, distributePorts, routeOrthogonal, type FixedPort, type OrthogonalRoute, type OrthogonalRouteRequest, type RoutedEnd, type RouterRect } from './orthogonal-router.js';
