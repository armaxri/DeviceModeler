package devm.jetbrains.cli

import com.intellij.openapi.util.SystemInfo
import devm.jetbrains.pluginDirectory
import devm.jetbrains.settings.DevmSettings
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * The self-contained command line executable `devm` (packages/cli, a Node.js single executable application), used
 * for what runs without the page (validation of closed files, see [CliValidator]). It is searched in this order:
 *
 * 1. the setting *Settings > Tools > Device Modeler > devm executable*, if set;
 * 2. `bin/devm` (`bin/devm.exe`) in the plugin directory (only in a plugin built with `-PdevmExecutable=…`, the
 *    published plugin does not bundle it: one zip for all platforms, the executables have about 120 MB each);
 * 3. `devm` in the `PATH` (and, for an IDE started from the macOS Finder or a desktop launcher with a short
 *    `PATH`, in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`).
 */
object DevmExecutable {

    const val PLUGIN_ID = "devm.jetbrains"

    enum class Source { SETTING, BUNDLED, PATH }

    data class Located(val path: Path, val source: Source) {
        override fun toString(): String = "$path (${source.name.lowercase()})"
    }

    /** The executable, or `null` if none was found. */
    fun locate(): Located? {
        val configured = DevmSettings.get().state.executable?.trim().orEmpty()
        if (configured.isNotEmpty()) {
            val path = Path.of(configured)
            return if (Files.isRegularFile(path) && makeExecutable(path)) Located(path, Source.SETTING) else null
        }
        bundled()?.let { return Located(it, Source.BUNDLED) }
        onPath(System.getenv("PATH"), SystemInfo.isWindows, System.getProperty("user.home"))?.let { return Located(it, Source.PATH) }
        return null
    }

    /** Why [locate] found nothing (for notifications). */
    fun missingReason(): String {
        val configured = DevmSettings.get().state.executable?.trim().orEmpty()
        return if (configured.isNotEmpty()) "The devm executable of the settings does not exist or is not executable: $configured"
        else "No devm executable found (neither bundled nor in the PATH)."
    }

    /** Where the executable is searched if the setting is empty (for the settings page). */
    fun describeDefault(): String = if (bundled() != null) "the bundled executable" else "devm in the PATH"

    fun fileName(windows: Boolean = SystemInfo.isWindows): String = if (windows) "devm.exe" else "devm"

    /** `bin/devm` of the plugin directory. */
    fun bundled(): Path? {
        val path = pluginDirectory()?.resolve("bin")?.resolve(fileName()) ?: return null
        return if (Files.isRegularFile(path) && makeExecutable(path)) path else null
    }

    /** `devm` in the directories of a `PATH` (plus the usual install locations on macOS / Linux). */
    fun onPath(pathVariable: String?, windows: Boolean, home: String?): Path? {
        val directories = ArrayList<String>()
        if (pathVariable != null) {
            directories.addAll(pathVariable.split(if (windows) ";" else File.pathSeparator))
        }
        if (!windows) {
            directories.addAll(listOf("/opt/homebrew/bin", "/usr/local/bin"))
            if (home != null) {
                directories.add("$home/.local/bin")
            }
        }
        val name = fileName(windows)
        for (directory in directories) {
            if (directory.isBlank()) {
                continue
            }
            val candidate = try {
                Path.of(directory.trim().replace("\"", ""), name)
            } catch (e: Exception) {
                continue
            }
            if (Files.isRegularFile(candidate) && (windows || Files.isExecutable(candidate))) {
                return candidate
            }
        }
        return null
    }

    private fun makeExecutable(path: Path): Boolean =
        SystemInfo.isWindows || Files.isExecutable(path) || path.toFile().setExecutable(true)
}
