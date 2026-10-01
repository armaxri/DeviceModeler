package hsm.eclipse.tools;

import java.util.Optional;

/**
 * The tools of the plugin that may run without the page: the integration point for the bundled self-contained
 * executable (branch {@code claude/bundled-executables}).
 * <ul>
 * <li>{@link #validator()}: none yet, so the builder only keeps markers of the editors. Set a validator based on
 * {@code hsm validate} to validate closed files.</li>
 * <li>{@link #generator()}: {@link PageGenerator} (generation in the page of the editor). A generator based on
 * {@code hsm generate} can replace it.</li>
 * </ul>
 * The implementations are set here (e.g. by the activator after locating the executable, or from a preference).
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
