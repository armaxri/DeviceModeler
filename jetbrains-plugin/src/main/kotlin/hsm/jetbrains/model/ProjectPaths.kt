package hsm.jetbrains.model

/**
 * Paths of the files of a project as the embedded web app sees them: relative to the root of the session (the
 * project directory) with `/` separators. The root is the boundary: the page can import, read and write only
 * files below it (`import "../motor.hsm"` works within the project).
 */
object ProjectPaths {

    /** Files a model may import: other models and C/C++ headers. */
    val IMPORTABLE = Regex(".*\\.(hsm|h|hh|hpp|hxx|h\\+\\+|inl)", RegexOption.IGNORE_CASE)

    /** Generator configurations (`hsm generate`). */
    val GENERATOR_CONFIG = Regex("hsm\\.gen\\.json|.+\\.hsm\\.gen\\.json")

    /** `import "path"` of a model (models and C/C++ headers). */
    val IMPORT = Regex("\\bimport\\s+\"([^\"]+)\"")

    fun isModel(name: String): Boolean = name.endsWith(".hsm", ignoreCase = true)

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
