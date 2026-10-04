import 'reflect-metadata';
import 'sprotty/css/sprotty.css';
import './styles/app.css';
import './styles/diagram-styles.js';
import './styles/simulation.css';
import './styles/side-panel.css';
import './styles/tooltips.css';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { DevmApp } from './app.js';
import { installTooltips } from './ui/tooltips.js';

self.MonacoEnvironment = {
    getWorker: () => new EditorWorker()
};

// styled tooltips in every host (native ones do not show in some embedded browsers, ui/tooltips.ts)
installTooltips();

const app = new DevmApp();
app.start().catch(error => {
    console.error(error);
    document.getElementById('status-message')!.textContent = `Failed to start: ${error instanceof Error ? error.message : error}`;
});

// exposed for debugging and automated tests
(window as unknown as { devmApp: DevmApp }).devmApp = app;
