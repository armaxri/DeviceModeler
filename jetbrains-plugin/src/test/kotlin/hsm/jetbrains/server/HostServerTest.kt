package hsm.jetbrains.server

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/** The loopback server of the diagram editors: tokens, Host / Origin checks, path confinement, the protocol. */
class HostServerTest {

    private class FakeSession : HostSession {
        val calls = ArrayList<String>()
        var text = "statemachine A {}"

        override fun document(): Map<String, Any?> = linkedMapOf("fileName" to "a.hsm", "path" to "models/a.hsm", "text" to text,
            "files" to mapOf("models/b.hsm" to "statemachine B {}"), "theme" to "dark")
        override fun file(path: String): String? = if (path == "LICENSE.txt") "license" else null
        override fun changed(text: String) {
            calls.add("changed:$text")
        }
        override fun save(text: String) {
            if (text == "fail") throw IOException("disk full")
            calls.add("save:$text")
        }
        override fun model(report: JsonObject) {
            calls.add("model:${report.get("textLength")}")
        }
        override fun settings(json: String) {
            calls.add("settings:$json")
        }
        override fun open(path: String): Boolean = path == "models/b.hsm"
        override fun export(fileName: String, content: ByteArray): String = "Exported $fileName (${content.size} bytes)."
        override fun generated(result: JsonObject): String = "Generated ${result.getAsJsonArray("files").size()} files."
    }

    private lateinit var directory: Path
    private lateinit var server: HostServer
    private val session = FakeSession()
    private lateinit var page: String
    private val client: HttpClient = HttpClient.newHttpClient()

    @Before
    fun setUp() {
        directory = Files.createTempDirectory("hsm-server")
        val webApp = Files.createDirectories(directory.resolve("webapp"))
        Files.writeString(webApp.resolve("index.html"), "<html>app</html>")
        Files.createDirectories(webApp.resolve("assets"))
        Files.writeString(webApp.resolve("assets/app.js"), "console.log(1)")
        Files.writeString(directory.resolve("secret.txt"), "secret")
        server = HostServer(webApp, 0)
        page = server.register(session)
    }

    @After
    fun tearDown() {
        server.stop()
        directory.toFile().deleteRecursively()
    }

    private val base: String get() = page.substringBefore("index.html")

    private fun get(url: String): HttpResponse<String> =
        client.send(HttpRequest.newBuilder(URI(url)).GET().build(), HttpResponse.BodyHandlers.ofString())

    private fun post(url: String, body: String, origin: String? = null): HttpResponse<String> {
        val request = HttpRequest.newBuilder(URI(url)).POST(HttpRequest.BodyPublishers.ofString(body))
        origin?.let { request.header("Origin", it) }
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString())
    }

    /** A raw request (for headers HttpClient does not allow to set and paths it would normalize). */
    private fun raw(requestLine: String, host: String): String {
        Socket("127.0.0.1", server.port).use { socket ->
            socket.getOutputStream().write("$requestLine\r\nHost: $host\r\nConnection: close\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
            return String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8)
        }
    }

    @Test
    fun servesThePageWithItsToken() {
        assertTrue(page.matches(Regex("http://127\\.0\\.0\\.1:\\d+/s/[0-9a-f]{32}/index\\.html\\?host=http")))
        val response = get(page)
        assertEquals(200, response.statusCode())
        assertEquals("<html>app</html>", response.body())
        assertEquals("no-cache", response.headers().firstValue("Cache-Control").orElse(""))
        val asset = get(base + "assets/app.js")
        assertEquals(200, asset.statusCode())
        assertTrue(asset.headers().firstValue("Content-Type").orElse("").startsWith("text/javascript"))
    }

    @Test
    fun rejectsUnknownTokensAndClosedSessions() {
        assertEquals(404, get("http://127.0.0.1:${server.port}/s/0123456789abcdef0123456789abcdef/index.html").statusCode())
        assertEquals(404, get("http://127.0.0.1:${server.port}/index.html").statusCode())
        server.unregister(session)
        assertEquals(404, get(page).statusCode())
        assertEquals(404, get(base + "api/document").statusCode())
    }

    @Test
    fun rejectsForeignHostHeaders() {
        val path = URI(page).rawPath
        assertTrue(raw("GET $path HTTP/1.1", "127.0.0.1:${server.port}").startsWith("HTTP/1.1 200"))
        assertTrue(raw("GET $path HTTP/1.1", "localhost:${server.port}").startsWith("HTTP/1.1 200"))
        // DNS rebinding: a foreign name resolving to 127.0.0.1
        assertTrue(raw("GET $path HTTP/1.1", "evil.example:${server.port}").startsWith("HTTP/1.1 403"))
    }

    @Test
    fun rejectsForeignOrigins() {
        assertEquals(403, post(base + "api/changed", "x", origin = "http://evil.example").statusCode())
        assertEquals(403, post(base + "api/changed", "x", origin = "http://127.0.0.1:1").statusCode())
        assertEquals(204, post(base + "api/changed", "y", origin = "http://127.0.0.1:${server.port}").statusCode())
        assertEquals(listOf("changed:y"), session.calls)
    }

    @Test
    fun staysInsideTheWebApp() {
        val token = URI(page).rawPath.split('/')[2]
        val host = "127.0.0.1:${server.port}"
        assertTrue(raw("GET /s/$token/..%2f..%2fsecret.txt HTTP/1.1", host).startsWith("HTTP/1.1 404"))
        assertTrue(raw("GET /s/$token/../secret.txt HTTP/1.1", host).startsWith("HTTP/1.1 404"))
        assertFalse(raw("GET /s/$token/%2e%2e/secret.txt HTTP/1.1", host).contains("secret\n"))
    }

    @Test
    fun answersTheProtocol() {
        val document = JsonParser.parseString(get(base + "api/document").body()).asJsonObject
        assertEquals("a.hsm", document.get("fileName").asString)
        assertEquals("models/a.hsm", document.get("path").asString)
        assertEquals("statemachine A {}", document.get("text").asString)
        assertEquals("statemachine B {}", document.getAsJsonObject("files").get("models/b.hsm").asString)

        assertEquals("license", get(base + "api/file?path=LICENSE.txt").body())
        assertEquals(404, get(base + "api/file?path=..%2Fsecret.txt").statusCode())

        assertEquals(204, post(base + "api/changed", "text ä").statusCode())
        assertEquals(204, post(base + "api/save", "saved").statusCode())
        assertEquals(500, post(base + "api/save", "fail").statusCode())
        assertEquals(204, post(base + "api/model", """{"textLength":5,"problems":[],"outline":[]}""").statusCode())
        assertEquals(400, post(base + "api/model", "no json").statusCode())
        assertEquals(204, post(base + "api/settings", """{"theme":"dark"}""").statusCode())
        assertEquals(400, post(base + "api/settings", "[1").statusCode())
        assertEquals(204, post(base + "api/open", "models/b.hsm").statusCode())
        assertEquals(404, post(base + "api/open", "models/c.hsm").statusCode())
        val export = post(base + "api/export?fileName=gate.svg", "<svg/>")
        assertEquals("Exported gate.svg (6 bytes).", JsonParser.parseString(export.body()).asJsonObject.get("message").asString)
        val generate = post(base + "api/generate", """{"files":[{"path":"a.h","content":""}],"messages":[]}""")
        assertEquals("Generated 1 files.", JsonParser.parseString(generate.body()).asJsonObject.get("message").asString)
        assertEquals(404, post(base + "api/unknown", "").statusCode())
        assertEquals(405, post(base + "index.html", "").statusCode())

        assertEquals(listOf("changed:text ä", "save:saved", "model:5", "settings:{\"theme\":\"dark\"}"), session.calls)
    }

    @Test
    fun checksHostAndOrigin() {
        assertTrue(HostServer.isLoopbackHost("127.0.0.1:1234"))
        assertTrue(HostServer.isLoopbackHost("LOCALHOST"))
        assertTrue(HostServer.isLoopbackHost("[::1]:80"))
        assertFalse(HostServer.isLoopbackHost("127.0.0.1.evil.example"))
        assertFalse(HostServer.isLoopbackHost(null))
        assertTrue(HostServer.isSameOrigin(null, "127.0.0.1:1"))
        assertTrue(HostServer.isSameOrigin("http://127.0.0.1:1", "127.0.0.1:1"))
        assertFalse(HostServer.isSameOrigin("null", "127.0.0.1:1"))
        assertFalse(HostServer.isSameOrigin("https://127.0.0.1:1", "127.0.0.1:1"))
    }

    @Test
    fun needsTheWebApp() {
        val empty = Files.createDirectories(directory.resolve("empty"))
        val error = try {
            HostServer(empty, 0)
            null
        } catch (e: IOException) {
            e
        }
        assertTrue(error?.message.orEmpty().contains("web app is missing"))
    }
}
