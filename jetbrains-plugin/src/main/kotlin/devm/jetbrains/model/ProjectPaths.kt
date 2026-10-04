package devm.jetbrains.model

/**
 * Paths of the files of a project as the embedded web app sees them: relative to the root of the session (the
 * project directory) with `/` separators. The root is the boundary: the page can import, read and write only
 * files below it (`import "../motor.devm"` works within the project).
 */
object ProjectPaths {

    /** Files a model may import: other models (state machines and structure files) and C/C++ headers. */
    val IMPORTABLE = Regex(".*\\.(devm|h|hh|hpp|hxx|h\\+\\+|inl)", RegexOption.IGNORE_CASE)

    /** Generator configurations (`devm generate`). */
    val GENERATOR_CONFIG = Regex("devm\\.gen\\.json|.+\\.devm\\.gen\\.json")

    /** `import "path"` of a model or structure file (models and C/C++ headers). */
    val IMPORT = Regex("\\bimport\\s+\"([^\"]+)\"")

    /** `.devm`: a state machine or a structure file (the same language, see [isStructureText]). */
    fun isModel(name: String): Boolean = name.endsWith(".devm", ignoreCase = true)

    /**
     * Whether the text of a `.devm` file is a structure file, not a state machine: the decision of the parser by
     * the first token (`isStructureText` of packages/language/src/devm-parser.ts; an empty file is a structure file).
     */
    fun isStructureText(text: CharSequence): Boolean {
        var i = 0
        while (i < text.length) {
            when {
                text[i].isWhitespace() -> i++
                text.startsWith("//", i) -> {
                    while (i < text.length && text[i] != '\n') i++
                }
                text.startsWith("/*", i) -> {
                    val end = text.indexOf("*/", i + 2)
                    if (end < 0) return true
                    i = end + 2
                }
                else -> {
                    val keyword = "statemachine"
                    val after = i + keyword.length
                    val word = after < text.length && (text[after] == '_' || text[after] in 'a'..'z' || text[after] in 'A'..'Z' || text[after] in '0'..'9')
                    return !(text.startsWith(keyword, i) && !word)
                }
            }
        }
        return true
    }

    fun isImportable(name: String): Boolean = IMPORTABLE.matches(name)

    fun isGeneratorConfig(name: String): Boolean = GENERATOR_CONFIG.matches(name)

    /**
     * The normalized segments of a path relative to the root (`a/./b//c` → `[a, b, c]`); `null` if it leaves the
     * root (`..`), is absolute on Windows (`C:`) or is empty. A leading `/` is ignored (relative to the root).
     */
    fun segments(path: String): List<String>? {
        val segments = path.replace('\\', '/').split('/').filter { it.isNotEmpty() && it != "." }
        if (segments.isEmpty() || segments.any { it == ".." || it.contains(':') || it.contains('\u0000') }) {
            return null
        }
        return segments
    }

    /** True if a file name may be used for an exported diagram (no path, not hidden). */
    fun isValidFileName(name: String): Boolean =
        name.isNotBlank() && !name.startsWith(".") && !name.contains('/') && !name.contains('\\') && !name.contains(':') && !name.contains('\u0000')

    /** The importers among models: models whose imports name one of the files (by path relative to the model, or by name). */
    fun imports(modelDirectory: String, text: String, changed: Set<String>): Boolean {
        val names = changed.map { it.substringAfterLast('/') }.toSet()
        for (match in IMPORT.findAll(text)) {
            val imported = normalize("$modelDirectory/${match.groupValues[1]}")
            // a header can also be found through an include path: compare the file names, too
            if (imported in changed || imported.substringAfterLast('/') in names) {
                return true
            }
        }
        return false
    }

    /** Resolves `.` and `..` of an absolute or relative path with `/` separators. */
    fun normalize(path: String): String {
        val result = ArrayList<String>()
        for (segment in path.replace('\\', '/').split('/')) {
            when (segment) {
                "", "." -> {}
                ".." -> if (result.isNotEmpty()) result.removeAt(result.size - 1)
                else -> result.add(segment)
            }
        }
        return (if (path.startsWith("/")) "/" else "") + result.joinToString("/")
    }
}
