package hsm.jetbrains

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Computable
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/** Runs a computation in a read action (any thread; API of all supported platform versions). */
inline fun <T> readAction(crossinline compute: () -> T): T =
    ApplicationManager.getApplication().runReadAction(Computable { compute() })

/**
 * The directory of the installed plugin (with `lib/`, `webapp/` and optionally `bin/`): found from the jar of the
 * plugin classes, without internal plugin manager API. `null` if the classes are not loaded from a plugin jar
 * (tests).
 */
fun pluginDirectory(): Path? = try {
    // jar:file:/…/<plugin>/lib/hsm-jetbrains-<version>.jar!/hsm/jetbrains/HsmNotifications.class
    val url = HsmNotifications::class.java.getResource("HsmNotifications.class")?.toString()
    val jar = if (url != null && url.startsWith("jar:") && url.contains("!/")) Path.of(URI(url.substring(4, url.indexOf("!/")))) else null
    jar?.parent?.parent?.takeIf { Files.isRegularFile(jar) && jar.parent.fileName.toString() == "lib" }
} catch (e: Exception) {
    null
}
