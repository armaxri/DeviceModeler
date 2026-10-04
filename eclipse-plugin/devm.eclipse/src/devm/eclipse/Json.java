package devm.eclipse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON support for the HTTP API of the embedded web app (no library dependency):
 * {@link #parse(String)} returns {@code Map<String, Object>}, {@code List<Object>}, {@code String},
 * {@code Double}, {@code Boolean} or {@code null}; {@link #write(Object)} writes these (and other numbers).
 */
public final class Json {

    private final String text;
    private int pos;

    private Json(String text) {
        this.text = text;
    }

    public static Object parse(String text) {
        Json parser = new Json(text);
        parser.skipWhitespace();
        Object value = parser.value();
        parser.skipWhitespace();
        if (parser.pos != text.length()) {
            throw parser.error("end of input expected");
        }
        return value;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Accessors for parsed values

    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(Object value) {
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
    }

    @SuppressWarnings("unchecked")
    public static List<Object> array(Object value) {
        return value instanceof List<?> list ? (List<Object>) list : List.of();
    }

    public static String string(Object value, String fallback) {
        return value instanceof String string ? string : fallback;
    }

    public static int integer(Object value, int fallback) {
        return value instanceof Number number ? number.intValue() : fallback;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Writing

    public static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String string) {
            quote(string, out);
        } else if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
            out.append(value);
        } else if (value instanceof Number number) {
            double d = number.doubleValue();
            out.append(d == Math.rint(d) && Math.abs(d) < 1e15 ? String.valueOf((long) d) : String.valueOf(d));
        } else if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                out.append(first ? "" : ",");
                quote(String.valueOf(entry.getKey()), out);
                out.append(':');
                write(entry.getValue(), out);
                first = false;
            }
            out.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : iterable) {
                out.append(first ? "" : ",");
                write(item, out);
                first = false;
            }
            out.append(']');
        } else {
            quote(value.toString(), out);
        }
    }

    public static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 16);
        quote(value, out);
        return out.toString();
    }

    private static void quote(String value, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20 || c == ' ' || c == ' ') {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Parsing

    private Object value() {
        if (pos >= text.length()) {
            throw error("value expected");
        }
        char c = text.charAt(pos);
        switch (c) {
            case '{':
                return parseObject();
            case '[':
                return parseArray();
            case '"':
                return parseString();
            case 't':
                return literal("true", Boolean.TRUE);
            case 'f':
                return literal("false", Boolean.FALSE);
            case 'n':
                return literal("null", null);
            default:
                return parseNumber();
        }
    }

    private Map<String, Object> parseObject() {
        Map<String, Object> result = new LinkedHashMap<>();
        pos++;
        skipWhitespace();
        if (peek() == '}') {
            pos++;
            return result;
        }
        while (true) {
            skipWhitespace();
            if (peek() != '"') {
                throw error("property name expected");
            }
            String key = parseString();
            skipWhitespace();
            expect(':');
            skipWhitespace();
            result.put(key, value());
            skipWhitespace();
            if (peek() == ',') {
                pos++;
            } else {
                expect('}');
                return result;
            }
        }
    }

    private List<Object> parseArray() {
        List<Object> result = new ArrayList<>();
        pos++;
        skipWhitespace();
        if (peek() == ']') {
            pos++;
            return result;
        }
        while (true) {
            skipWhitespace();
            result.add(value());
            skipWhitespace();
            if (peek() == ',') {
                pos++;
            } else {
                expect(']');
                return result;
            }
        }
    }

    private String parseString() {
        pos++;
        StringBuilder out = new StringBuilder();
        while (pos < text.length()) {
            char c = text.charAt(pos++);
            if (c == '"') {
                return out.toString();
            }
            if (c != '\\') {
                out.append(c);
                continue;
            }
            if (pos >= text.length()) {
                break;
            }
            char e = text.charAt(pos++);
            switch (e) {
                case 'n' -> out.append('\n');
                case 'r' -> out.append('\r');
                case 't' -> out.append('\t');
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case 'u' -> {
                    if (pos + 4 > text.length()) {
                        throw error("invalid escape");
                    }
                    out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                    pos += 4;
                }
                default -> out.append(e);
            }
        }
        throw error("unterminated string");
    }

    private Double parseNumber() {
        int start = pos;
        while (pos < text.length() && "+-0123456789.eE".indexOf(text.charAt(pos)) >= 0) {
            pos++;
        }
        if (start == pos) {
            throw error("unexpected character '" + text.charAt(pos) + "'");
        }
        try {
            return Double.valueOf(text.substring(start, pos));
        } catch (NumberFormatException e) {
            throw error("invalid number");
        }
    }

    private Object literal(String word, Object value) {
        if (!text.startsWith(word, pos)) {
            throw error(word + " expected");
        }
        pos += word.length();
        return value;
    }

    private char peek() {
        return pos < text.length() ? text.charAt(pos) : '\0';
    }

    private void expect(char c) {
        if (peek() != c) {
            throw error("'" + c + "' expected");
        }
        pos++;
    }

    private void skipWhitespace() {
        while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) {
            pos++;
        }
    }

    private IllegalArgumentException error(String message) {
        return new IllegalArgumentException("JSON: " + message + " at " + pos);
    }
}
