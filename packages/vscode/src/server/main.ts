import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createDevmLanguageServerServices, installHeaderSupport } from './devm-lsp.js';

// The language server of the Device Modeler: the model files (.devm: state machines and structure
// files) and the unit tests of state machines (.devmtest). Started by the extension via IPC, or with
// `--stdio` by other clients. All .devm / .devmtest files of the workspace folders are indexed, so test
// classes resolve the state machines of other files and structure files link the component types, ports
// and state machines of other files (references and renames across files).
const connection = createConnection(ProposedFeatures.all);
const { shared } = createDevmLanguageServerServices({ connection, ...NodeFileSystem });
// imported C/C++ headers: read from the file system, settings of devm.gen.json and devm.headers.*
installHeaderSupport(shared);
startLanguageServer(shared);
