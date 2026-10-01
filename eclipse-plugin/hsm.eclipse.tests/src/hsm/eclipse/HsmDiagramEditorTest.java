package hsm.eclipse;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.widgets.Display;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.ide.IDE;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Opens a model in the HSM editor of a running workbench: the web app is loaded in the browser widget, edits of
 * the page make the editor dirty, Save writes the workspace file, an external change is shown in the page.
 */
public class HsmDiagramEditorTest {

    private static final String MOTOR = "statemachine Motor {\n    interface:\n        in event start\n    [*] -> Off\n    state Off\n    state Running\n    Off -> Running : start\n}\n";
    private static final String GATE = "statemachine Gate {\n    import \"motor.hsm\"\n    internal:\n        var motor : Motor\n    [*] -> Closed\n    state Closed\n}\n";

    private IProject project;

    @Before
    public void createProject() throws Exception {
        project = ResourcesPlugin.getWorkspace().getRoot().getProject("hsm-test");
        if (!project.exists()) {
            project.create(null);
        }
        project.open(null);
        project.getFile("motor.hsm").create(new ByteArrayInputStream(MOTOR.getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
        project.getFile("gate.hsm").create(new ByteArrayInputStream(GATE.getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
    }

    @After
    public void deleteProject() throws Exception {
        ui(() -> {
            PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().closeAllEditors(false);
            return null;
        });
        project.delete(true, null);
    }

    @Test
    public void editSaveAndExternalChange() throws Exception {
        IFile file = project.getFile("gate.hsm");
        IEditorPart part = ui(() -> {
            IWorkbenchPage page = PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage();
            try {
                return IDE.openEditor(page, file);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        assertTrue("default editor of .hsm: " + part.getClass(), part instanceof HsmDiagramEditor);
        HsmDiagramEditor editor = (HsmDiagramEditor) part;
        Browser browser = browserOf(editor);

        // the page loads the file, the import resolves against motor.hsm of the same folder (no errors)
        waitFor(() -> "page loaded: " + eval(browser, "return location.href + ' | ' + document.readyState + ' | app: ' + !!window.hsmApp"
                + " + ' | status: ' + (document.getElementById('status-message') || {}).textContent"
                + " + ' | problems: ' + (document.getElementById('status-problems') || {}).textContent;"),
                () -> Boolean.TRUE.equals(eval(browser, "return !!window.hsmApp && !!window.hsmApp.diagram"
                        + " && /^(✓|0 errors)/.test(document.getElementById('status-problems').textContent);")));
        assertEquals(GATE, eval(browser, "return window.hsmApp.getText();"));
        assertEquals("true", eval(browser, "return String(document.getElementById('btn-open').hidden);"));
        assertFalse(ui(editor::isDirty));

        // an edit in the page: dirty
        eval(browser, "window.hsmApp.applyTextEdits([{ offset: 0, length: 0, text: '// edited\\n' }]); return null;");
        waitFor("dirty", () -> ui(editor::isDirty));

        // Save (Eclipse): the text of the page is written to the file
        ui(() -> {
            editor.doSave(null);
            return null;
        });
        assertEquals("// edited\n" + GATE, read(file));
        assertFalse(ui(editor::isDirty));

        // Ctrl+S in the page
        eval(browser, "window.hsmApp.applyTextEdits([{ offset: 0, length: 0, text: '// again\\n' }]); return null;");
        waitFor("dirty again", () -> ui(editor::isDirty));
        eval(browser, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); return null;");
        waitFor("saved by the page", () -> read(file).startsWith("// again\n") && !ui(editor::isDirty));

        // external change of the file: shown in the page
        file.setContents(new ByteArrayInputStream("// external\n".concat(GATE).getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
        waitFor("external change in the page", () -> String.valueOf(eval(browser, "return window.hsmApp.getText();")).startsWith("// external\n"));
        assertFalse(ui(editor::isDirty));
    }

    // ---------------------------------------------------------------------------------------------------------

    private static Browser browserOf(HsmDiagramEditor editor) throws Exception {
        Field field = HsmDiagramEditor.class.getDeclaredField("browser");
        field.setAccessible(true);
        Browser browser = (Browser) field.get(editor);
        assertTrue("browser created", browser != null);
        return browser;
    }

    private static Object eval(Browser browser, String script) {
        return ui(() -> {
            try {
                return browser.evaluate(script);
            } catch (Exception e) {
                return null;
            }
        });
    }

    private static String read(IFile file) {
        try (InputStream in = file.getContents(true)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static <T> T ui(Supplier<T> supplier) {
        AtomicReference<T> result = new AtomicReference<>();
        AtomicReference<RuntimeException> error = new AtomicReference<>();
        Display.getDefault().syncExec(() -> {
            try {
                result.set(supplier.get());
            } catch (RuntimeException e) {
                error.set(e);
            }
        });
        if (error.get() != null) {
            throw error.get();
        }
        return result.get();
    }

    private static void waitFor(String what, Supplier<Boolean> condition) throws InterruptedException {
        waitFor(() -> what, condition);
    }

    /** Waits up to a minute for the condition; the message describes the state on a timeout. */
    private static void waitFor(Supplier<String> what, Supplier<Boolean> condition) throws InterruptedException {
        long end = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < end) {
            if (Boolean.TRUE.equals(condition.get())) {
                return;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("Timeout: " + what.get());
    }
}
