import 'reflect-metadata';
import 'sprotty/css/sprotty.css';
import './styles/app.css';
import './styles/diagram-styles.js';
import './styles/simulation.css';
import './styles/side-panel.css';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { HsmApp } from './app.js';

self.MonacoEnvironment = {
    getWorker: () => new EditorWorker()
};

const app = new HsmApp();
app.start().catch(error => {
    console.error(error);
    document.getElementById('status-message')!.textContent = `Failed to start: ${error instanceof Error ? error.message : error}`;
});

// exposed for debugging and automated tests
(window as unknown as { hsmApp: HsmApp }).hsmApp = app;
