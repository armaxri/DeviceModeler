package hsm.eclipse.tools;

import java.util.Optional;

/**
 * The tools of the plugin that may run without the page.
 * <ul>
 * <li>{@link #validator()}: {@link CliValidator} ({@code hsm validate --json} of the bundled executable, see
 * {@link HsmExecutable}), set by the activator; the builder validates closed files with it.</li>
 * <li>{@link #generator()}: {@link PageGenerator} (generation in the page of the editor): the same generator and
 * configuration resolution as {@code hsm generate}, with the preferences of the plugin and the files written
 * through the workspace. A generator based on {@code hsm generate} could replace it (e.g. for batch generation).</li>
 * </ul>
 * Tests or other plugins may set other implementations.
 */
public final class HsmTools {

    private static volatile ModelValidator validator;
    private static volatile ModelGenerator generator = new PageGenerator();

    private HsmTools() {
    }

    public static Optional<ModelValidator> validator() {
        return Optional.ofNullable(validator);
    }

    public static void setValidator(ModelValidator value) {
        validator = value;
    }

    public static ModelGenerator generator() {
        return generator;
    }

    public static void setGenerator(ModelGenerator value) {
        generator = value != null ? value : new PageGenerator();
    }
}
