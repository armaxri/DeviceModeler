package hsm.jetbrains.server

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import hsm.jetbrains.cli.HsmExecutable
import hsm.jetbrains.pluginDirectory
import java.io.IOException
import java.nio.file.Path

/**
 * The [HostServer] of the IDE (one for all projects), started with the first diagram editor. It serves the web
 * app of the plugin directory (`webapp/`, copied from packages/web/dist by the build).
 *
 * Why an own loopback server and not a JCEF resource handler (custom scheme): the web app and its protocol stay
 * exactly as in the Eclipse plugin and the desktop app (relative `api/…` URLs, `fetch` with POST bodies, which
 * custom scheme handlers of CEF do not pass reliably), and the server is a plain JDK class that is tested without
 * an IDE. The server only answers on 127.0.0.1, only below `/s/<token>/` of an open editor, and only to requests
 * with a loopback `Host` and without a foreign `Origin`.
 */
@Service(Service.Level.APP)
class HsmWebServer : Disposable {

    @Volatile
    private var server: HostServer? = null

    /** The running server (started on first use). */
    @Synchronized
    @Throws(IOException::class)
    fun server(): HostServer = server ?: HostServer(webApp(), Integer.getInteger("hsm.server.port", HostServer.DEFAULT_PORT)).also { server = it }

    override fun dispose() {
        server?.stop()
        server = null
    }

    companion object {
        fun get(): HsmWebServer = service()

        /** The folder of the web app: `-Dhsm.webapp=…` (development) or `webapp/` of the plugin directory. */
        fun webApp(): Path {
            System.getProperty("hsm.webapp")?.let { return Path.of(it) }
            val plugin = pluginDirectory() ?: throw IOException("The directory of the plugin ${HsmExecutable.PLUGIN_ID} was not found")
            return plugin.resolve("webapp")
        }
    }
}
