package hsm.eclipse;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IFolder;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IncrementalProjectBuilder;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.Path;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.dnd.Clipboard;
import org.eclipse.swt.dnd.TextTransfer;
import org.eclipse.swt.dnd.Transfer;
import org.eclipse.swt.widgets.Display;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchCommandConstants;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.handlers.IHandlerService;
import org.eclipse.ui.ide.IDE;
import org.eclipse.ui.views.contentoutline.IContentOutlinePage;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import hsm.eclipse.builder.HsmNature;
import hsm.eclipse.tools.HsmTools;
import hsm.eclipse.tools.ModelProblem;

/**
 * The HSM editor in a running workbench: the web app is loaded in the browser widget with the files of the
 * project ({@code ../} imports, headers of the include paths of {@code hsm.gen.json}); dirty state and saving;
 * problem markers and their navigation; outline; Eclipse's edit commands; Save As, move / rename; C++
 * generation; settings of the page; external changes; the builder with a validator.
 */
public class HsmDiagramEditorTest {

    private static final String MOTOR = "statemachine Motor {\n    interface:\n        in event start\n    [*] -> Off\n    state Off\n    state Running\n    Off -> Running : start\n}\n";
    private static final String GATE = "statemachine Gate {\n    import \"../motor.hsm\"\n    import \"types.h\"\n    internal:\n        var mode : t::Mode = t::Mode::On\n"
            + "    [*] -> Closed\n    state Closed\n    state Open\n    Closed -> Open : always\n}\n";
    private static final String CONFIG = "{\n  \"models\": [\"models/**/*.hsm\"],\n  \"cpp\": { \"outDir\": \"gen\", \"licenseHeaderFile\": \"LICENSE.txt\" },\n"
            + "  \"headers\": { \"includePaths\": [\"include\"] }\n}\n";
    private static final String TYPES = "#pragma once\nnamespace t {\nenum class Mode { Off, On };\n}\n";

    private IProject project;

    @Before
    public void createProject() throws Exception {
        project = ResourcesPlugin.getWorkspace().getRoot().getProject("hsm-test");
        if (!project.exists()) {
            project.create(null);
        }
        project.open(null);
        create("hsm.gen.json", CONFIG);
        create("LICENSE.txt", "Test license");
        create("include/types.h", TYPES);
        create("models/motor.hsm", MOTOR);
        create("models/door/gate.hsm", GATE);
    }

    private void create(String path, String text) throws CoreException {
        IFile file = project.getFile(path);
        if (file.getParent() instanceof IFolder folder && !folder.exists()) {
            createFolder(folder);
        }
        file.create(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
    }

    private static void createFolder(IFolder folder) throws CoreException {
        if (folder.getParent() instanceof IFolder parent && !parent.exists()) {
            createFolder(parent);
        }
        folder.create(true, true, null);
    }

    @After
    public void deleteProject() throws Exception {
        HsmTools.setValidator(null);
        ui(() -> {
            PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().closeAllEditors(false);
            return null;
        });
        project.delete(true, null);
    }

    @Test
    public void editor() throws Exception {
        IFile file = project.getFile("models/door/gate.hsm");
        HsmDiagramEditor editor = open(file);
        Browser browser = browserOf(editor);

        // the page loads the file; "../motor.hsm" and "types.h" (include path of hsm.gen.json) resolve
        waitFor(() -> "page loaded: " + eval(browser, "return location.href + ' | ' + document.readyState + ' | app: ' + !!window.hsmApp"
                + " + ' | problems: ' + (document.getElementById('status-problems') || {}).title;"),
                () -> Boolean.TRUE.equals(eval(browser, "return !!window.hsmApp && !!window.hsmApp.diagram"
                        + " && /^(✓|0 errors)/.test(document.getElementById('status-problems').textContent);")));
        assertEquals(GATE, eval(browser, "return window.hsmApp.getText();"));
        assertEquals("true", eval(browser, "return String(document.getElementById('btn-open').hidden);"));
        assertFalse(ui(editor::isDirty));
        waitFor("no error markers", () -> errorMarkers(file).length == 0);

        // outline
        IContentOutlinePage outlinePage = ui(() -> editor.getAdapter(IContentOutlinePage.class));
        assertTrue(outlinePage instanceof HsmOutlinePage);
        List<HsmOutlinePage.Node> outline = ((HsmOutlinePage) outlinePage).nodes();
        assertEquals("Gate", outline.get(0).label());
        assertTrue(outline.get(0).children().stream().anyMatch(n -> n.label().equals("Closed") && n.kind().equals("state")));
        assertTrue(outline.get(0).children().stream().anyMatch(n -> n.kind().equals("transition") && n.label().startsWith("Closed -> Open")));

        // an error in the page: a marker; Eclipse's Undo (page) removes it again
        eval(browser, "window.hsmApp.applyTextEdits([{ offset: window.hsmApp.getText().indexOf('    state Open'), length: 0, text: '    state Closed\\n' }]); window.hsmApp.diagram.scheduleUpdate(0); return null;");
        waitFor("dirty", () -> ui(editor::isDirty));
        waitFor("error marker", () -> errorMarkers(file).length > 0);
        IMarker marker = errorMarkers(file)[0];
        int start = marker.getAttribute(IMarker.CHAR_START, -1);
        assertTrue("marker with offsets", start > 0);
        assertTrue(marker.getAttribute(IMarker.LINE_NUMBER, -1) > 0);

        // double-click on the marker: the range is selected in the page
        ui(() -> {
            IDE.gotoMarker(editor, marker);
            return null;
        });
        waitFor("marker revealed", () -> Integer.valueOf(start).equals(number(eval(browser,
                "const e = window.hsmApp.editor; return e.getModel().getOffsetAt(e.getSelection().getStartPosition());"))));

        command(IWorkbenchCommandConstants.EDIT_UNDO);
        waitFor("undone", () -> GATE.equals(eval(browser, "return window.hsmApp.getText();")));
        waitFor("error marker removed", () -> errorMarkers(file).length == 0);
        waitFor("not dirty", () -> !ui(editor::isDirty));

        // select all + copy (Eclipse commands): the text in the clipboard; paste inserts the clipboard
        eval(browser, "window.hsmApp.editor.focus(); return null;");
        command(IWorkbenchCommandConstants.EDIT_SELECT_ALL);
        command(IWorkbenchCommandConstants.EDIT_COPY);
        waitFor("copied", () -> GATE.equals(clipboard()));
        setClipboard("// pasted\n");
        eval(browser, "window.hsmApp.editor.setPosition({ lineNumber: 1, column: 1 }); return null;");
        command(IWorkbenchCommandConstants.EDIT_PASTE);
        waitFor("pasted", () -> ("// pasted\n" + GATE).equals(eval(browser, "return window.hsmApp.getText();")));
        command(IWorkbenchCommandConstants.EDIT_UNDO);
        waitFor("paste undone", () -> GATE.equals(eval(browser, "return window.hsmApp.getText();")));
        command(IWorkbenchCommandConstants.EDIT_FIND_AND_REPLACE);
        waitFor("find widget", () -> Boolean.TRUE.equals(eval(browser, "return !!document.querySelector('.find-widget.visible');")));

        // save (Eclipse) and Ctrl+S in the page
        eval(browser, "window.hsmApp.applyTextEdits([{ offset: 0, length: 0, text: '// edited\\n' }]); return null;");
        waitFor("dirty", () -> ui(editor::isDirty));
        ui(() -> {
            editor.doSave(null);
            return null;
        });
        assertEquals("// edited\n" + GATE, ProjectFiles.read(file));
        assertFalse(ui(editor::isDirty));
        eval(browser, "window.hsmApp.applyTextEdits([{ offset: 0, length: 0, text: '// again\\n' }]); return null;");
        waitFor("dirty again", () -> ui(editor::isDirty));
        eval(browser, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); return null;");
        waitFor("saved by the page", () -> read(file).startsWith("// again\n") && !ui(editor::isDirty));

        // external change of the file: shown in the page
        file.setContents(new ByteArrayInputStream("// external\n".concat(GATE).getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
        waitFor("external change in the page", () -> String.valueOf(eval(browser, "return window.hsmApp.getText();")).startsWith("// external\n"));
        assertFalse(ui(editor::isDirty));

        // settings of the page are stored in the preferences
        eval(browser, "const s = document.getElementById('direction-select'); s.value = 'RIGHT'; s.dispatchEvent(new Event('change')); return null;");
        waitFor("settings stored", () -> Preferences.store().getString(Preferences.PAGE_SETTINGS).contains("\"RIGHT\""));
        eval(browser, "const s = document.getElementById('direction-select'); s.value = 'DOWN'; s.dispatchEvent(new Event('change')); return null;");

        // C++ generation (command of the active editor): hsm.gen.json → gen/, license header file, header include
        command("hsm.eclipse.generateCpp");
        IFile header = project.getFile("gen/Gate.h");
        waitFor(() -> "generated: " + eval(browser, "return document.getElementById('status-message').textContent;"), header::exists);
        String generated = read(header);
        assertTrue(generated, generated.contains("Test license"));
        assertTrue(generated, generated.contains("#include \"types.h\""));
        assertTrue(project.getFile("gen/Gate.cpp").exists());

        // rename: the editor follows the file
        file.move(new Path("gate-renamed.hsm"), true, null);
        IFile renamed = project.getFile("models/door/gate-renamed.hsm");
        waitFor("editor follows the rename", () -> renamed.equals(editor.file()));
        assertEquals("gate-renamed.hsm", ui(editor::getPartName));
        waitFor("page follows the rename", () -> "gate-renamed.hsm".equals(eval(browser, "return document.getElementById('file-name').textContent;")));

        // move to another folder: imports are resolved against the new location ("../motor.hsm" is now missing)
        renamed.move(project.getFullPath().append("gate-moved.hsm"), true, null);
        IFile moved = project.getFile("gate-moved.hsm");
        waitFor("editor follows the move", () -> moved.equals(editor.file()));
        waitFor("import error after the move", () -> errorMarkers(moved).length > 0);

        // Save As
        IFile copy = project.getFile("models/sub/copy.hsm");
        ui(() -> {
            editor.saveAs(copy);
            return null;
        });
        assertTrue(copy.exists());
        assertEquals(copy, editor.file());
        assertTrue(moved.exists());
        waitFor("no errors in models/ again", () -> errorMarkers(copy).length == 0 && Boolean.TRUE.equals(eval(browser,
                "return /^(✓|0 errors)/.test(document.getElementById('status-problems').textContent);")));
    }

    @Test
    public void builderWithValidator() throws Exception {
        HsmTools.setValidator((model, monitor) -> List.of(new ModelProblem(IMarker.SEVERITY_WARNING, "checked " + model.getName(), 2, 1, -1, -1)));
        HsmNature.toggle(project);
        project.build(IncrementalProjectBuilder.FULL_BUILD, null);
        IMarker[] markers = project.getFile("models/motor.hsm").findMarkers(ProblemMarkers.TYPE, false, IResource.DEPTH_ZERO);
        assertEquals(1, markers.length);
        assertEquals("checked motor.hsm", markers[0].getAttribute(IMarker.MESSAGE));
        assertEquals(2, markers[0].getAttribute(IMarker.LINE_NUMBER, -1));
    }

    // ---------------------------------------------------------------------------------------------------------

    private static HsmDiagramEditor open(IFile file) {
        IEditorPart part = ui(() -> {
            IWorkbenchPage page = PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage();
            try {
                return IDE.openEditor(page, file);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        assertTrue("default editor of .hsm: " + part.getClass(), part instanceof HsmDiagramEditor);
        return (HsmDiagramEditor) part;
    }

    private static IMarker[] errorMarkers(IFile file) {
        try {
            if (!file.exists()) {
                return new IMarker[0];
            }
            return java.util.Arrays.stream(file.findMarkers(ProblemMarkers.TYPE, false, IResource.DEPTH_ZERO))
                    .filter(m -> m.getAttribute(IMarker.SEVERITY, -1) == IMarker.SEVERITY_ERROR).toArray(IMarker[]::new);
        } catch (CoreException e) {
            throw new RuntimeException(e);
        }
    }

    private static void command(String id) {
        ui(() -> {
            try {
                PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().getActiveEditor().getSite()
                        .getService(IHandlerService.class).executeCommand(id, null);
            } catch (Exception e) {
                throw new RuntimeException(id + ": " + e, e);
            }
            return null;
        });
    }

    private static String clipboard() {
        return ui(() -> {
            Clipboard clipboard = new Clipboard(Display.getCurrent());
            try {
                return (String) clipboard.getContents(TextTransfer.getInstance());
            } finally {
                clipboard.dispose();
            }
        });
    }

    private static void setClipboard(String text) {
        ui(() -> {
            Clipboard clipboard = new Clipboard(Display.getCurrent());
            try {
                clipboard.setContents(new Object[] { text }, new Transfer[] { TextTransfer.getInstance() });
            } finally {
                clipboard.dispose();
            }
            return null;
        });
    }

    private static Integer number(Object value) {
        return value instanceof Number n ? n.intValue() : null;
    }

    private static Browser browserOf(HsmDiagramEditor editor) throws Exception {
        Field field = HsmDiagramEditor.class.getDeclaredField("browser");
        field.setAccessible(true);
        Browser browser = (Browser) field.get(editor);
        assertNotNull("browser created", browser);
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
        try {
            return ProjectFiles.read(file);
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
