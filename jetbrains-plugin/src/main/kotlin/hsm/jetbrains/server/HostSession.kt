package hsm.jetbrains.server

import com.google.gson.JsonObject

/**
 * The host side of one embedded web app page (one opened diagram editor). The HTTP API of [HostServer] calls
 * these methods on the threads of the server (never on the EDT). The protocol is described in
 * `packages/web/src/host.ts`; paths are relative to the root of the session (the project directory), with `/`.
 */
interface HostSession {

    /** The document: `fileName`, `path`, `text`, `files`, `configs`, `cppSettings`, `settings`, `theme` (see host.ts). */
    fun document(): Map<String, Any?>

    /** The text of another file below the root, `null` if it does not exist (or is outside of the root). */
    fun file(path: String): String?

    /** The text was changed in the page. */
    fun changed(text: String)

    /** The page asks to save the text. */
    fun save(text: String)

    /** Problems and outline of the model (`HostModelReport` of host.ts). */
    fun model(report: JsonObject)

    /** The page settings (JSON) to store. */
    fun settings(json: String)

    /** The page asks to open another file; false if it does not exist. */
    fun open(path: String): Boolean

    /** Stores an exported diagram; returns a message for the user. */
    fun export(fileName: String, content: ByteArray): String

    /** Writes generated files (`HostGeneratedFiles` of host.ts); returns a message for the user. */
    fun generated(result: JsonObject): String
}
