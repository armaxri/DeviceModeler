import 'reflect-metadata';
import 'sprotty/css/sprotty.css';
import '@hsm-web/styles/app.css';
import '@hsm-web/styles/diagram-styles.js';
import '@hsm-web/styles/simulation.css';
import '@hsm-web/styles/side-panel.css';
import './webview.css';
import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerSource from 'elkjs/lib/elk-worker.min.js?raw';
import { DiagramController } from '@hsm-web/diagram-controller.js';
import { HsmModelService } from '@hsm-web/model-service.js';
import { WebviewHost, type VsCodeApi } from './webview-host.js';

declare function acquireVsCodeApi(): VsCodeApi;

type ElkConstructor = typeof ElkApi;

/** ELK in a web worker created from a blob (webviews cannot load workers from extension resources). */
function createElk(): InstanceType<ElkConstructor> {
    const module = ElkApi as unknown as ElkConstructor | { default: ElkConstructor };
    const Constructor = typeof module === 'function' ? module : module.default;
    const workerUrl = URL.createObjectURL(new Blob([elkWorkerSource], { type: 'text/javascript' }));
    return new Constructor({ workerUrl });
}

const vscode = acquireVsCodeApi();
const host = new WebviewHost(vscode);
const controller = new DiagramController({
    host,
    language: new HsmModelService(),
    settings: { direction: 'DOWN', routing: 'SPLINES', theme: 'classic', priorities: true },
    elk: createElk()
});
host.connect(controller);
controller.start();
host.ready();

// exposed for debugging and automated tests
(window as unknown as { hsmDiagram: DiagramController }).hsmDiagram = controller;
