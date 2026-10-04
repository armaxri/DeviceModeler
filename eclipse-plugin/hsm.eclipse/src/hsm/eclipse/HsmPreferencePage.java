package hsm.eclipse;

import org.eclipse.jface.preference.BooleanFieldEditor;
import org.eclipse.jface.preference.ComboFieldEditor;
import org.eclipse.jface.preference.FieldEditorPreferencePage;
import org.eclipse.jface.preference.FileFieldEditor;
import org.eclipse.jface.preference.StringFieldEditor;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPreferencePage;

/**
 * <i>Preferences > HSM Modeler</i>: C++ generation of models that no {@code hsm.gen.json} lists, and the {@code hsm}
 * executable for the validation of closed files.
 */
public class HsmPreferencePage extends FieldEditorPreferencePage implements IWorkbenchPreferencePage {

    public HsmPreferencePage() {
        super(GRID);
        setDescription("C++ generation (Generate C++) of models that are not listed in a generator configuration "
                + "(hsm.gen.json or *.hsm.gen.json in the folder of the model or above; it takes precedence).\n\n"
                + "The hsm executable validates closed files (Configure > Enable / Disable HSM Validation of a project). "
                + "Empty: the executable installed with the plugin for this platform, else hsm in the PATH.");
    }

    @Override
    public void init(IWorkbench workbench) {
        setPreferenceStore(Preferences.store());
    }

    @Override
    protected void createFieldEditors() {
        addField(new StringFieldEditor(Preferences.CPP_OUTPUT_DIRECTORY, "Output folder (relative to the model, ${project}/… for the project; empty: folder of the model):",
                getFieldEditorParent()));
        addField(new BooleanFieldEditor(Preferences.CPP_MODEL_NAMESPACE, "Use the namespace of the model", getFieldEditorParent()));
        addField(new StringFieldEditor(Preferences.CPP_NAMESPACE, "Namespace (e.g. app::sm; empty: global namespace):", getFieldEditorParent()));
        addField(new ComboFieldEditor(Preferences.CPP_STANDARD, "C++ standard:", new String[][] { { "C++17", "17" }, { "C++11", "11" } },
                getFieldEditorParent()));
        FileFieldEditor executable = new FileFieldEditor(Preferences.HSM_EXECUTABLE, "hsm executable (empty: bundled / PATH):", true,
                FileFieldEditor.VALIDATE_ON_KEY_STROKE, getFieldEditorParent());
        executable.setEmptyStringAllowed(true);
        addField(executable);
    }
}
