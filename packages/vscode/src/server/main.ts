// The language server of the extension (started via IPC by extension.ts, or with `--stdio`): the shared
// server of the language package, also run by `hsm lsp` of the command line executable for other IDEs.
import { startHsmLanguageServer } from '../../../language/src/node/language-server.js';

startHsmLanguageServer();
