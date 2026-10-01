package hsm.eclipse;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * A small HTTP server on the loopback interface that serves the built web app ({@code packages/web/dist}) and
 * the HTTP API of the embedded app ({@code packages/web/src/host.ts}) to the browser widgets of the editors.
 * <p>
 * Every editor is a {@link HostSession} with a random token: its page is {@code /s/<token>/index.html?host=http}
 * and its API {@code /s/<token>/api/…} (the web app is built with relative URLs). Requests without a known token
 * are rejected, so other local processes and web sites cannot read or write workspace files.
 * <p>
 * Plain JDK ({@code com.sun.net.httpserver}), no Eclipse dependencies: it can be tested without Eclipse.
 */
public final class WebServer {

    /** Preferred port: the same origin in every Eclipse session keeps the settings of the app (local storage). */
    public static final int DEFAULT_PORT = 47913;

    private static final String SESSION_PREFIX = "/s/";
    private static final Map<String, String> CONTENT_TYPES = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("mjs", "text/javascript; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("json", "application/json; charset=utf-8"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("ttf", "font/ttf"),
            Map.entry("woff", "font/woff"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("wasm", "application/wasm"),
            Map.entry("map", "application/json; charset=utf-8"));

    private final Path root;
    private final HttpServer server;
    private final ExecutorService executor;
    private final Map<String, HostSession> sessions = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    /**
     * Starts the server.
     *
     * @param root directory of the built web app (with {@code index.html})
     * @param port preferred port; if it is in use (or 0), a free port is chosen
     */
    public WebServer(Path root, int port) throws IOException {
        if (!Files.isRegularFile(root.resolve("index.html"))) {
            throw new IOException("The web app is missing: " + root.resolve("index.html")
                    + " (build packages/web and copy dist/ into the plugin, see eclipse-plugin/README.md)");
        }
        this.root = root.toRealPath();
        this.server = bind(port);
        this.executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "HSM web server");
            thread.setDaemon(true);
            return thread;
        });
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
    }

    private static HttpServer bind(int port) throws IOException {
        InetAddress loopback = InetAddress.getLoopbackAddress();
        if (port > 0) {
            try {
                return HttpServer.create(new InetSocketAddress(loopback, port), 0);
            } catch (BindException e) {
                // in use (e.g. a second Eclipse instance): any free port
            }
        }
        return HttpServer.create(new InetSocketAddress(loopback, 0), 0);
    }

    public int port() {
        return server.getAddress().getPort();
    }

    /** Registers the session of an editor; returns the URL of its page. */
    public String register(HostSession session) {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        String token = HexFormat.of().formatHex(bytes);
        sessions.put(token, session);
        return "http://127.0.0.1:" + port() + SESSION_PREFIX + token + "/index.html?host=http";
    }

    public void unregister(HostSession session) {
        sessions.values().removeIf(s -> s == session);
    }

    public void stop() {
        server.stop(0);
        executor.shutdownNow();
    }

    // ---------------------------------------------------------------------------------------------------------

    private void handle(HttpExchange exchange) throws IOException {
        try {
            if (!isLocalHost(exchange.getRequestHeaders().getFirst("Host"))) {
                // DNS rebinding: only the loopback address is served
                send(exchange, 403, "text/plain", "Forbidden");
                return;
            }
            String path = exchange.getRequestURI().getRawPath();
            if (!path.startsWith(SESSION_PREFIX)) {
                send(exchange, 404, "text/plain", "Not found");
                return;
            }
            int slash = path.indexOf('/', SESSION_PREFIX.length());
            HostSession session = slash < 0 ? null : sessions.get(path.substring(SESSION_PREFIX.length(), slash));
            if (session == null) {
                send(exchange, 404, "text/plain", "Unknown session (the editor was closed)");
                return;
            }
            String rest = URLDecoder.decode(path.substring(slash + 1), StandardCharsets.UTF_8);
            if (rest.startsWith("api/")) {
                handleApi(exchange, session, rest.substring("api/".length()));
            } else if ("GET".equals(exchange.getRequestMethod()) || "HEAD".equals(exchange.getRequestMethod())) {
                serveFile(exchange, rest.isEmpty() ? "index.html" : rest);
            } else {
                send(exchange, 405, "text/plain", "Method not allowed");
            }
        } catch (IOException | RuntimeException e) {
            try {
                send(exchange, 500, "text/plain", String.valueOf(e.getMessage()));
            } catch (IOException | RuntimeException ignored) {
                // the response was already started
            }
        } finally {
            exchange.close();
        }
    }

    private static boolean isLocalHost(String host) {
        if (host == null) {
            return false;
        }
        String name = host.replaceFirst(":\\d+$", "");
        return name.equals("127.0.0.1") || name.equalsIgnoreCase("localhost") || name.equals("[::1]");
    }

    private void handleApi(HttpExchange exchange, HostSession session, String operation) throws IOException {
        String method = exchange.getRequestMethod();
        switch (method + " " + operation) {
            case "GET document" -> {
                StringBuilder json = new StringBuilder();
                json.append("{\"fileName\":").append(Json.string(session.fileName()));
                json.append(",\"text\":").append(Json.string(session.text()));
                json.append(",\"files\":{");
                boolean first = true;
                for (Map.Entry<String, String> file : session.importableFiles().entrySet()) {
                    json.append(first ? "" : ",").append(Json.string(file.getKey())).append(':').append(Json.string(file.getValue()));
                    first = false;
                }
                json.append("}}");
                send(exchange, 200, "application/json; charset=utf-8", json.toString());
            }
            case "POST changed" -> {
                session.changed(readText(exchange));
                send(exchange, 204, null, null);
            }
            case "POST save" -> {
                session.save(readText(exchange));
                send(exchange, 204, null, null);
            }
            case "POST open" -> {
                boolean opened = session.open(readText(exchange).trim());
                send(exchange, opened ? 204 : 404, opened ? null : "text/plain", opened ? null : "Not found");
            }
            case "POST export" -> {
                String fileName = query(exchange.getRequestURI(), "fileName");
                byte[] content;
                try (InputStream in = exchange.getRequestBody()) {
                    content = in.readAllBytes();
                }
                String message = session.export(fileName == null ? "diagram" : fileName, content);
                send(exchange, 200, "application/json; charset=utf-8", "{\"message\":" + Json.string(message) + "}");
            }
            default -> send(exchange, 404, "text/plain", "Unknown operation " + method + " " + operation);
        }
    }

    private void serveFile(HttpExchange exchange, String relative) throws IOException {
        Path file = root.resolve(relative).normalize();
        if (!file.startsWith(root) || !Files.isRegularFile(file)) {
            send(exchange, 404, "text/plain", "Not found");
            return;
        }
        String name = file.getFileName().toString();
        String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        exchange.getResponseHeaders().set("Content-Type", CONTENT_TYPES.getOrDefault(extension, "application/octet-stream"));
        // the assets have content hashes in their names; index.html must always be fresh
        exchange.getResponseHeaders().set("Cache-Control", name.equals("index.html") ? "no-cache" : "max-age=31536000, immutable");
        long size = Files.size(file);
        if ("HEAD".equals(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(200, -1);
            return;
        }
        exchange.sendResponseHeaders(200, size);
        try (OutputStream out = exchange.getResponseBody()) {
            Files.copy(file, out);
        }
    }

    private static String readText(HttpExchange exchange) throws IOException {
        try (InputStream in = exchange.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String query(URI uri, String name) {
        String query = uri.getRawQuery();
        if (query == null) {
            return null;
        }
        for (String part : query.split("&")) {
            int equals = part.indexOf('=');
            if (equals > 0 && part.substring(0, equals).equals(name)) {
                return URLDecoder.decode(part.substring(equals + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static void send(HttpExchange exchange, int status, String type, String body) throws IOException {
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        if (body == null) {
            exchange.sendResponseHeaders(status, -1);
            return;
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    /** Minimal JSON encoding of strings. */
    static final class Json {
        private Json() {
        }

        static String string(String value) {
            StringBuilder result = new StringBuilder(value.length() + 16).append('"');
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                switch (c) {
                    case '"' -> result.append("\\\"");
                    case '\\' -> result.append("\\\\");
                    case '\n' -> result.append("\\n");
                    case '\r' -> result.append("\\r");
                    case '\t' -> result.append("\\t");
                    default -> {
                        if (c < 0x20 || c == ' ' || c == ' ') {
                            result.append(String.format("\\u%04x", (int) c));
                        } else {
                            result.append(c);
                        }
                    }
                }
            }
            return result.append('"').toString();
        }
    }
}
