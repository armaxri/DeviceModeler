import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createHsmLanguageServerServices } from './hsm-lsp.js';

// The language server of both languages (.hsm and .hsmtest). Started by the extension via IPC, or with
// `--stdio` by other clients. All .hsm / .hsmtest files of the workspace folders are indexed, so test
// classes resolve the state machines of other files.
const connection = createConnection(ProposedFeatures.all);
const { shared } = createHsmLanguageServerServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);
