package hsm.eclipse;

import java.util.LinkedHashMap;
import java.util.Map;

import org.eclipse.core.runtime.preferences.AbstractPreferenceInitializer;
import org.eclipse.jface.preference.IPreferenceStore;

/** Preferences of the plugin (instance scope, node {@value Activator#PLUGIN_ID}). */
public final class Preferences {

    /** Output directory of <i>Generate C++</i> relative to the model; {@code ${project}}: the project; empty: the model's folder. */
    public static final String CPP_OUTPUT_DIRECTORY = "cpp.outputDirectory";
    /** Use the namespace of the model (otherwise {@link #CPP_NAMESPACE}). */
    public static final String CPP_MODEL_NAMESPACE = "cpp.modelNamespace";
    /** Namespace of the generated class ({@code a::b}; empty: the global namespace). */
    public static final String CPP_NAMESPACE = "cpp.namespace";
    /** C++ standard: {@code 17} or {@code 11}. */
    public static final String CPP_STANDARD = "cpp.standard";
    /** Path of the {@code hsm} executable (validation of closed files); empty: the bundled one, else {@code hsm} in the PATH. */
    public static final String HSM_EXECUTABLE = "hsm.executable";
    /** Settings of the page (theme, layout direction, …) as JSON, stored by the page. */
    public static final String PAGE_SETTINGS = "page.settings";

    private Preferences() {
    }

    public static IPreferenceStore store() {
        return Activator.getDefault().getPreferenceStore();
    }

    /** The C++ settings for the page ({@code HostCppSettings} of host.ts). */
    public static Map<String, Object> cppSettings() {
        IPreferenceStore store = store();
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("outputDirectory", store.getString(CPP_OUTPUT_DIRECTORY));
        settings.put("namespace", store.getBoolean(CPP_MODEL_NAMESPACE) ? null : store.getString(CPP_NAMESPACE));
        settings.put("standard", "11".equals(store.getString(CPP_STANDARD)) ? "11" : "17");
        return settings;
    }

    /** Defaults (extension point org.eclipse.core.runtime.preferences). */
    public static class Initializer extends AbstractPreferenceInitializer {
        @Override
        public void initializeDefaultPreferences() {
            IPreferenceStore store = store();
            store.setDefault(CPP_OUTPUT_DIRECTORY, "");
            store.setDefault(CPP_MODEL_NAMESPACE, true);
            store.setDefault(CPP_NAMESPACE, "");
            store.setDefault(CPP_STANDARD, "17");
            store.setDefault(PAGE_SETTINGS, "");
            store.setDefault(HSM_EXECUTABLE, "");
        }
    }
}
