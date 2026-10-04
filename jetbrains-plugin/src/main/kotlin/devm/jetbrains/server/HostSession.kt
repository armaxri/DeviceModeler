package devm.jetbrains.server

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

    /**
     * The page asks to open another file below the root (a model, or a C/C++ header of a go to definition) in the
     * editor for its type, at [position] if one is given; false if it does not exist.
     */
    fun open(path: String, position: OpenPosition?): Boolean

    /** Stores an exported diagram; returns a message for the user. */
    fun export(fileName: String, content: ByteArray): String

    /** Writes generated files (`HostGeneratedFiles` of host.ts); returns a message for the user. */
    fun generated(result: JsonObject): String
}

/**
 * A position of `api/open`: 1-based lines and columns (UTF-16 code units, as in Monaco and IntelliJ documents);
 * the end is the end of the range to select (the start if the page sent no range).
 */
data class OpenPosition(val line: Int, val column: Int, val endLine: Int, val endColumn: Int) {
    companion object {
        /** The position of the query parameters `line`, `column`, `endLine`, `endColumn`; null without a line. */
        fun of(parameter: (String) -> String?): OpenPosition? {
            fun number(name: String) = parameter(name)?.trim()?.toIntOrNull() ?: -1
            val line = number("line")
            if (line < 1) return null
            val column = maxOf(1, number("column"))
            val endLine = number("endLine")
            val endColumn = number("endColumn")
            return if (endLine >= line && endColumn >= 1) OpenPosition(line, column, endLine, endColumn) else OpenPosition(line, column, line, column)
        }
    }
}
