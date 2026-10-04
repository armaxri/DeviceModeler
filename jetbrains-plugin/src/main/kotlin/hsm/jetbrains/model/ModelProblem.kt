package hsm.jetbrains.model

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** Where problems come from. */
enum class ProblemSource {
    /** The page of an opened diagram editor (the text of the editor, also unsaved). */
    PAGE,

    /** `hsm validate --json` (the saved file). */
    CLI,
}

/** Severity of a problem. */
enum class Severity {
    ERROR, WARNING, INFO;

    companion object {
        fun of(name: String?): Severity = when (name) {
            "warning" -> WARNING
            "info", "hint" -> INFO
            else -> ERROR
        }
    }
}

/**
 * A problem of a model.
 *
 * @param line 1-based line of the start (0: unknown)
 * @param column 1-based column of the start (0: unknown)
 * @param endLine 1-based line of the end (0: unknown)
 * @param endColumn 1-based column of the end (0: unknown)
 * @param offset character offset (UTF-16) of the start in the text (-1: unknown)
 * @param end character offset of the end (-1: unknown)
 */
data class ModelProblem(
    val severity: Severity,
    val message: String,
    val line: Int,
    val column: Int,
    val endLine: Int = 0,
    val endColumn: Int = 0,
    val offset: Int = -1,
    val end: Int = -1,
) {
    companion object {
        /** A problem reported by the page (`HostProblem` of packages/web/src/host.ts). */
        fun fromJson(json: JsonObject): ModelProblem = ModelProblem(
            Severity.of(json.string("severity")),
            json.string("message") ?: "",
            json.int("line", 0),
            json.int("column", 0),
            json.int("endLine", 0),
            json.int("endColumn", 0),
            json.int("offset", -1),
            json.int("end", -1),
        )
    }
}

/** An element of the outline of the page (`HostOutlineNode` of host.ts); offsets in the text of the page. */
data class OutlineNode(val label: String, val kind: String, val offset: Int, val end: Int, val children: List<OutlineNode>) {
    companion object {
        fun fromJson(json: JsonElement?): List<OutlineNode> {
            if (json == null || !json.isJsonArray) {
                return emptyList()
            }
            return json.asJsonArray.filter { it.isJsonObject }.map { it.asJsonObject }.map {
                OutlineNode(it.string("label") ?: "", it.string("kind") ?: "", it.int("offset", 0), it.int("end", 0), fromJson(it.get("children")))
            }
        }
    }
}

/** The report of the page after a validation (`HostModelReport` of host.ts). */
data class ModelReport(val textLength: Int, val problems: List<ModelProblem>, val outline: List<OutlineNode>) {
    companion object {
        fun fromJson(json: JsonObject): ModelReport {
            val problems = json.get("problems")?.takeIf { it.isJsonArray }?.asJsonArray
                ?.filter { it.isJsonObject }?.map { ModelProblem.fromJson(it.asJsonObject) } ?: emptyList()
            return ModelReport(json.int("textLength", -1), problems, OutlineNode.fromJson(json.get("outline")))
        }
    }
}

/**
 * The output of `hsm validate --json <files…>`: `{"files":[{"file","path","problems":[{"path","severity","message",
 * "line","column","endLine","endColumn","offset","end"}]}]}` (one entry per model, in the order of the command
 * line). Problems of imported models carry their own path and are left to the validation of those models.
 */
object CliOutput {

    /** The problems of the models (by index of the command line). */
    fun parse(json: String, models: Int): List<List<ModelProblem>> {
        val files = JsonParser.parseString(json).asJsonObject.getAsJsonArray("files")
            ?: throw IllegalArgumentException("no files in the output")
        require(files.size() == models) { "${files.size()} results for $models models" }
        return files.map { item ->
            val file = item.asJsonObject
            val path = file.string("path") ?: ""
            file.getAsJsonArray("problems")?.map { it.asJsonObject }
                ?.filter { (it.string("path") ?: path) == path }
                ?.map { ModelProblem.fromJson(it) } ?: emptyList()
        }
    }

    /** The JSON document of the output: its last line (other output, e.g. warnings of Node.js, comes before it). */
    fun jsonLine(stdout: String): String = stdout.trim().lines().last()
}

internal fun JsonObject.string(name: String): String? =
    get(name)?.takeIf { it.isJsonPrimitive }?.asString

internal fun JsonObject.int(name: String, default: Int): Int =
    get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt ?: default
