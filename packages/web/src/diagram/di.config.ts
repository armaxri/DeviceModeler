import 'reflect-metadata';
import { Container, ContainerModule } from 'inversify';
import {
    configureActionHandler, configureModelElement, configureViewerOptions, labelEditUiModule, loadDefaultModules,
    moveFeature, MoveMouseListener, ScrollMouseListener, SelectMouseListener, SGraphView, TYPES, LocalModelSource, undoRedoModule, selectFeature
} from 'sprotty';
import { SelectAction, SelectAllAction } from 'sprotty-protocol';
import { DiagramTypes, StateMachineGraph, TransitionEdge, VertexNode } from './model.js';
import {
    ChoiceView, DefinitionView, EntryPointView, ExitPointView, FinalView, HistoryView, InitialView, JunctionView, RegionView, StateView, SyncView,
    TransitionView
} from './views.js';
import { DiagramCallbacks, HsmMouseListener, HsmMoveMouseListener, HsmScrollMouseListener, HsmSelectMouseListener, SelectionTracker } from './listeners.js';

export function createDiagramContainer(baseDiv: string, callbacks: DiagramCallbacks): Container {
    const hsmModule = new ContainerModule((bind, unbind, isBound, rebind) => {
        bind(TYPES.ModelSource).to(LocalModelSource).inSingletonScope();
        bind(DiagramCallbacks).toConstantValue(callbacks);
        bind(HsmMouseListener).toSelf().inSingletonScope();
        bind(TYPES.MouseListener).toService(HsmMouseListener);
        rebind(SelectMouseListener).to(HsmSelectMouseListener).inSingletonScope();
        rebind(MoveMouseListener).to(HsmMoveMouseListener).inSingletonScope();
        rebind(ScrollMouseListener).to(HsmScrollMouseListener).inSingletonScope();

        const context = { bind, unbind, isBound, rebind };
        configureModelElement(context, DiagramTypes.graph, StateMachineGraph, SGraphView);
        configureModelElement(context, DiagramTypes.state, VertexNode, StateView);
        configureModelElement(context, DiagramTypes.region, VertexNode, RegionView, { disable: [moveFeature] });
        configureModelElement(context, DiagramTypes.initial, VertexNode, InitialView);
        configureModelElement(context, DiagramTypes.final, VertexNode, FinalView);
        configureModelElement(context, DiagramTypes.choice, VertexNode, ChoiceView);
        configureModelElement(context, DiagramTypes.junction, VertexNode, JunctionView);
        configureModelElement(context, DiagramTypes.history, VertexNode, HistoryView);
        configureModelElement(context, DiagramTypes.deephistory, VertexNode, HistoryView);
        configureModelElement(context, DiagramTypes.sync, VertexNode, SyncView);
        configureModelElement(context, DiagramTypes.entry, VertexNode, EntryPointView);
        configureModelElement(context, DiagramTypes.exit, VertexNode, ExitPointView);
        configureModelElement(context, DiagramTypes.definition, VertexNode, DefinitionView);
        configureModelElement(context, DiagramTypes.transition, TransitionEdge, TransitionView, { enable: [selectFeature] });

        configureViewerOptions(context, {
            needsClientLayout: false,
            needsServerLayout: false,
            baseDiv,
            hiddenDiv: `${baseDiv}_hidden`,
            zoomLimits: { min: 0.1, max: 4 },
            horizontalScrollLimits: { min: -100000, max: 100000 },
            verticalScrollLimits: { min: -100000, max: 100000 }
        });
        configureActionHandler(context, SelectAction.KIND, SelectionTracker);
        configureActionHandler(context, SelectAllAction.KIND, SelectionTracker);
    });
    const container = new Container();
    // Undo / redo is handled by the text editor: the text is the single source of truth.
    loadDefaultModules(container, { exclude: [undoRedoModule, labelEditUiModule] });
    container.load(hsmModule);
    return container;
}
