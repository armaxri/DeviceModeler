package devm.jetbrains.server

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.HexFormat
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * A small HTTP server on the loopback interface that serves the built web app (`packages/web/dist`, the
 * folder `webapp/` of the plugin) and the HTTP API of the embedded app (`packages/web/src/host.ts`, the same
 * protocol as the Eclipse plugin and the desktop app) to the browsers (JCEF) of the diagram editors.
 *
 * Every editor is a [HostSession] with a random token: its page is `/s/<token>/index.html?host=http` and its
 * API `/s/<token>/api/…` (the web app is built with relative URLs). Requests without a known token are
 * rejected, as are requests with a foreign `Host` header (DNS rebinding) or a foreign `Origin` (a web site
 * posting to the API), so other local processes and web sites cannot read or write project files.
 *
 * Plain JDK (`com.sun.net.httpserver`), no IntelliJ dependencies (Gson only): it is tested without an IDE.
 */
class HostServer(root: Path, port: Int) {

    companion object {
        /** Preferred port: the same origin in every IDE session (a free port if it is taken). */
        const val DEFAULT_PORT = 47915

        private const val SESSION_PREFIX = "/s/"
        private const val JSON = "application/json; charset=utf-8"
        private const val TEXT = "text/plain; charset=utf-8"
        private val CONTENT_TYPES = mapOf(
            "html" to "text/html; charset=utf-8",
            "js" to "text/javascript; charset=utf-8",
            "mjs" to "text/javascript; charset=utf-8",
            "css" to "text/css; charset=utf-8",
            "json" to "application/json; charset=utf-8",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "ttf" to "font/ttf",
            "woff" to "font/woff",
            "woff2" to "font/woff2",
            "wasm" to "application/wasm",
            "map" to "application/json; charset=utf-8",
        )
        private val gson = GsonBuilder().disableHtmlEscaping().create()

        /** True if the `Host` header names the loopback interface (with any port). */
        fun isLoopbackHost(host: String?): Boolean {
            if (host.isNullOrEmpty()) {
                return false
            }
            val name = if (host.startsWith("[")) host.substring(0, host.indexOf(']') + 1) else host.substringBefore(':')
            return name == "127.0.0.1" || name.equals("localhost", ignoreCase = true) || name == "[::1]"
        }

        /** True if the request has no `Origin` or the origin of the server itself (the page). */
        fun isSameOrigin(origin: String?, host: String?): Boolean {
            if (origin == null) {
                return true
            }
            return try {
                val uri = URI(origin)
                uri.scheme == "http" && host != null && uri.rawAuthority.equals(host, ignoreCase = true)
            } catch (e: Exception) {
                false
            }
        }
    }

    /** An error of a session with an HTTP status (e.g. 404 for a file that does not exist). */
    class HostException(val status: Int, message: String) : IOException(message)

    private val root: Path
    private val server: HttpServer
    private val executor: ExecutorService
    private val sessions = ConcurrentHashMap<String, HostSession>()
    private val random = SecureRandom()

    init {
        if (!Files.isRegularFile(root.resolve("index.html"))) {
            throw IOException("The web app is missing: ${root.resolve("index.html")} (the plugin was built without packages/web/dist)")
        }
        this.root = root.toRealPath()
        server = bind(port)
        executor = Executors.newCachedThreadPool { runnable ->
            Thread(runnable, "Device Modeler web server").apply { isDaemon = true }
        }
        server.executor = executor
        server.createContext("/") { exchange -> handle(exchange) }
        server.start()
    }

    private fun bind(port: Int): HttpServer {
        val loopback = InetAddress.getLoopbackAddress()
        if (port > 0) {
            try {
                return HttpServer.create(InetSocketAddress(loopback, port), 0)
            } catch (e: BindException) {
                // in use (e.g. a second IDE): any free port
            }
        }
        return HttpServer.create(InetSocketAddress(loopback, 0), 0)
    }

    val port: Int get() = server.address.port

    /** Registers the session of an editor; returns the URL of its page. */
    fun register(session: HostSession): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        val token = HexFormat.of().formatHex(bytes)
        sessions[token] = session
        return "http://127.0.0.1:$port$SESSION_PREFIX$token/index.html?host=http"
    }

    fun unregister(session: HostSession) {
        sessions.values.removeIf { it === session }
    }

    fun stop() {
        server.stop(0)
        executor.shutdownNow()
    }

    // ---------------------------------------------------------------------------------------------------------

    private fun handle(exchange: HttpExchange) {
        try {
            val host = exchange.requestHeaders.getFirst("Host")
            if (!isLoopbackHost(host)) {
                // DNS rebinding: only the loopback address is served
                send(exchange, 403, TEXT, "Forbidden")
                return
            }
            if (!isSameOrigin(exchange.requestHeaders.getFirst("Origin"), host)) {
                send(exchange, 403, TEXT, "Forbidden: foreign origin")
                return
            }
            val path = exchange.requestURI.rawPath
            if (!path.startsWith(SESSION_PREFIX)) {
                send(exchange, 404, TEXT, "Not found")
                return
            }
            val slash = path.indexOf('/', SESSION_PREFIX.length)
            val session = if (slash < 0) null else sessions[path.substring(SESSION_PREFIX.length, slash)]
            if (session == null) {
                send(exchange, 404, TEXT, "Unknown session (the editor was closed)")
                return
            }
            val rest = URLDecoder.decode(path.substring(slash + 1), StandardCharsets.UTF_8)
            if (rest.startsWith("api/")) {
                handleApi(exchange, session, rest.removePrefix("api/"))
            } else if (exchange.requestMethod == "GET" || exchange.requestMethod == "HEAD") {
                serveFile(exchange, rest.ifEmpty { "index.html" })
            } else {
                send(exchange, 405, TEXT, "Method not allowed")
            }
        } catch (e: HostException) {
            trySend(exchange, e.status, e.message)
        } catch (e: Exception) {
            trySend(exchange, 500, e.message ?: e.toString())
        } finally {
            exchange.close()
        }
    }

    private fun trySend(exchange: HttpExchange, status: Int, message: String?) {
        try {
            send(exchange, status, TEXT, message ?: "Error")
        } catch (ignored: Exception) {
            // the response was already started
        }
    }

    private fun handleApi(exchange: HttpExchange, session: HostSession, operation: String) {
        when ("${exchange.requestMethod} $operation") {
            "GET document" -> send(exchange, 200, JSON, gson.toJson(session.document()))
            "GET file" -> {
                val text = query(exchange.requestURI, "path")?.let { session.file(it) }
                if (text == null) send(exchange, 404, TEXT, "Not found") else send(exchange, 200, TEXT, text)
            }
            "POST changed" -> {
                session.changed(readText(exchange))
                send(exchange, 204, null, null)
            }
            "POST save" -> {
                session.save(readText(exchange))
                send(exchange, 204, null, null)
            }
            "POST model" -> {
                session.model(parseObject(readText(exchange)))
                send(exchange, 204, null, null)
            }
            "POST settings" -> {
                val json = readText(exchange)
                parseObject(json)
                session.settings(json)
                send(exchange, 204, null, null)
            }
            "POST open" -> {
                val position = OpenPosition.of { query(exchange.requestURI, it) }
                val location = query(exchange.requestURI, "location")?.takeIf { it.isNotBlank() }
                if (session.open(readText(exchange).trim(), position, location)) send(exchange, 204, null, null) else send(exchange, 404, TEXT, "Not found")
            }
            "POST export" -> {
                val fileName = query(exchange.requestURI, "fileName") ?: "diagram"
                val content = exchange.requestBody.use { it.readAllBytes() }
                send(exchange, 200, JSON, gson.toJson(mapOf("message" to session.export(fileName, content))))
            }
            "POST generate" -> {
                val message = session.generated(parseObject(readText(exchange)))
                send(exchange, 200, JSON, gson.toJson(mapOf("message" to message)))
            }
            else -> send(exchange, 404, TEXT, "Unknown operation ${exchange.requestMethod} $operation")
        }
    }

    private fun parseObject(json: String): JsonObject {
        val element = try {
            JsonParser.parseString(json)
        } catch (e: Exception) {
            throw HostException(400, "Invalid JSON: ${e.message}")
        }
        if (!element.isJsonObject) {
            throw HostException(400, "A JSON object was expected")
        }
        return element.asJsonObject
    }

    private fun serveFile(exchange: HttpExchange, relative: String) {
        val file = root.resolve(relative).normalize()
        if (!file.startsWith(root) || !Files.isRegularFile(file)) {
            send(exchange, 404, TEXT, "Not found")
            return
        }
        val name = file.fileName.toString()
        val extension = name.substringAfterLast('.').lowercase(Locale.ROOT)
        exchange.responseHeaders.set("Content-Type", CONTENT_TYPES[extension] ?: "application/octet-stream")
        // the assets have content hashes in their names; index.html must always be fresh
        exchange.responseHeaders.set("Cache-Control", if (name == "index.html") "no-cache" else "max-age=31536000, immutable")
        if (exchange.requestMethod == "HEAD") {
            exchange.sendResponseHeaders(200, -1)
            return
        }
        exchange.sendResponseHeaders(200, Files.size(file))
        exchange.responseBody.use { Files.copy(file, it) }
    }

    private fun readText(exchange: HttpExchange): String =
        exchange.requestBody.use { String(it.readAllBytes(), StandardCharsets.UTF_8) }

    private fun query(uri: URI, name: String): String? {
        val query = uri.rawQuery ?: return null
        for (part in query.split('&')) {
            val equals = part.indexOf('=')
            if (equals > 0 && part.substring(0, equals) == name) {
                return URLDecoder.decode(part.substring(equals + 1), StandardCharsets.UTF_8)
            }
        }
        return null
    }

    private fun send(exchange: HttpExchange, status: Int, type: String?, body: String?) {
        if (!exchange.responseHeaders.containsKey("Cache-Control")) {
            exchange.responseHeaders.set("Cache-Control", "no-store")
        }
        if (body == null) {
            exchange.sendResponseHeaders(status, -1)
            return
        }
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", type)
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}
