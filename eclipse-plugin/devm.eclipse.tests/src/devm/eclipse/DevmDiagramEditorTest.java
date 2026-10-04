package devm.eclipse;

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
import org.eclipse.jface.text.ITextSelection;
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
import org.eclipse.ui.texteditor.ITextEditor;
import org.eclipse.ui.views.contentoutline.IContentOutlinePage;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import devm.eclipse.builder.DevmNature;
import devm.eclipse.tools.CliValidator;
import devm.eclipse.tools.DevmExecutable;
import devm.eclipse.tools.DevmTools;
import devm.eclipse.tools.ModelProblem;

/**
 * The Device Modeler editor in a running workbench: the web app is loaded in the browser widget with the files of the
 * project ({@code ../} imports, headers of the include paths of {@code devm.gen.json}); dirty state and saving;
 * problem markers and their navigation; outline; Eclipse's edit commands; Save As, move / rename; C++
 * generation; settings of the page; external changes; the builder with a validator. Structure files (same
 * extension): the structure diagram, outline, markers, navigation to other files and the builder.
 */
public class DevmDiagramEditorTest {

    private static final String MOTOR = "statemachine Motor {\n    interface:\n        in event start\n    [*] -> Off\n    state Off\n    state Running\n    Off -> Running : start\n}\n";
    private static final String GATE = "statemachine Gate {\n    import \"../motor.devm\"\n    import \"types.h\"\n    internal:\n        var mode : t::Mode = t::Mode::On\n"
            + "    [*] -> Closed\n    state Closed\n    state Open\n    Closed -> Open : always\n}\n";
    private static final String CONFIG = "{\n  \"models\": [\"models/**/*.devm\"],\n  \"cpp\": { \"outDir\": \"gen\", \"licenseHeaderFile\": \"LICENSE.txt\" },\n"
            + "  \"headers\": { \"includePaths\": [\"include\"] }\n}\n";
    private static final String TYPES = "#pragma once\nnamespace t {\nenum class Mode { Off, On };\n}\n";
    /** Structure files: a component implemented by motor.devm, a subsystem using it (another file). */
    private static final String PARTS = "// Parts of the drive (a structure file)\n/** The motor. */\ncomponent MotorUnit {\n    behavior \"motor.devm\"\n"
            + "    in async start\n}\n";
    private static final String DRIVE = "import \"parts.devm\"\n\n/** The drive. */\nsubsystem Drive {\n    in async go\n    thread Main {\n"
            + "        motor : MotorUnit\n    }\n    delegate go -> motor.start\n}\n";

    private IProject project;

    @Before
    public void createProject() throws Exception {
        project = ResourcesPlugin.getWorkspace().getRoot().getProject("devm-test");
        if (!project.exists()) {
            project.create(null);
        }
        project.open(null);
        create("devm.gen.json", CONFIG);
        create("LICENSE.txt", "Test license");
        create("include/types.h", TYPES);
        create("models/motor.devm", MOTOR);
        create("models/door/gate.devm", GATE);
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
        DevmTools.setValidator(null);
        ui(() -> {
            PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().closeAllEditors(false);
            return null;
        });
        project.delete(true, null);
    }

    @Test
    public void editor() throws Exception {
        IFile file = project.getFile("models/door/gate.devm");
        DevmDiagramEditor editor = open(file);
        Browser browser = browserOf(editor);

        // the page loads the file; "../motor.devm" and "types.h" (include path of devm.gen.json) resolve
        waitFor(() -> "page loaded: " + eval(browser, "return location.href + ' | ' + document.readyState + ' | app: ' + !!window.devmApp"
                + " + ' | problems: ' + (document.getElementById('status-problems') || {}).title;"),
                () -> Boolean.TRUE.equals(eval(browser, "return !!window.devmApp && !!window.devmApp.diagram"
                        + " && /^(✓|0 errors)/.test(document.getElementById('status-problems').textContent);")));
        assertEquals(GATE, eval(browser, "return window.devmApp.getText();"));
        assertEquals("true", eval(browser, "return String(document.getElementById('btn-open').hidden);"));
        assertFalse(ui(editor::isDirty));
        waitFor("no error markers", () -> errorMarkers(file).length == 0);

        // outline
        IContentOutlinePage outlinePage = ui(() -> editor.getAdapter(IContentOutlinePage.class));
        assertTrue(outlinePage instanceof DevmOutlinePage);
        List<DevmOutlinePage.Node> outline = ((DevmOutlinePage) outlinePage).nodes();
        assertEquals("Gate", outline.get(0).label());
        assertTrue(outline.get(0).children().stream().anyMatch(n -> n.label().equals("Closed") && n.kind().equals("state")));
        assertTrue(outline.get(0).children().stream().anyMatch(n -> n.kind().equals("transition") && n.label().startsWith("Closed -> Open")));

        // an error in the page: a marker; Eclipse's Undo (page) removes it again
        eval(browser, "window.devmApp.applyTextEdits([{ offset: window.devmApp.getText().indexOf('    state Open'), length: 0, text: '    state Closed\\n' }]); window.devmApp.diagram.scheduleUpdate(0); return null;");
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
                "const e = window.devmApp.editor; return e.getModel().getOffsetAt(e.getSelection().getStartPosition());"))));

        command(IWorkbenchCommandConstants.EDIT_UNDO);
        waitFor("undone", () -> GATE.equals(eval(browser, "return window.devmApp.getText();")));
        waitFor("error marker removed", () -> errorMarkers(file).length == 0);
        waitFor("not dirty", () -> !ui(editor::isDirty));

        // select all + copy (Eclipse commands): the text in the clipboard; paste inserts the clipboard
        eval(browser, "window.devmApp.editor.focus(); return null;");
        command(IWorkbenchCommandConstants.EDIT_SELECT_ALL);
        command(IWorkbenchCommandConstants.EDIT_COPY);
        waitFor("copied", () -> GATE.equals(clipboard()));
        setClipboard("// pasted\n");
        eval(browser, "window.devmApp.editor.setPosition({ lineNumber: 1, column: 1 }); return null;");
        command(IWorkbenchCommandConstants.EDIT_PASTE);
        waitFor("pasted", () -> ("// pasted\n" + GATE).equals(eval(browser, "return window.devmApp.getText();")));
        command(IWorkbenchCommandConstants.EDIT_UNDO);
        waitFor("paste undone", () -> GATE.equals(eval(browser, "return window.devmApp.getText();")));
        command(IWorkbenchCommandConstants.EDIT_FIND_AND_REPLACE);
        waitFor("find widget", () -> Boolean.TRUE.equals(eval(browser, "return !!document.querySelector('.find-widget.visible');")));

        // save (Eclipse) and Ctrl+S in the page
        eval(browser, "window.devmApp.applyTextEdits([{ offset: 0, length: 0, text: '// edited\\n' }]); return null;");
        waitFor("dirty", () -> ui(editor::isDirty));
        ui(() -> {
            editor.doSave(null);
            return null;
        });
        assertEquals("// edited\n" + GATE, ProjectFiles.read(file));
        assertFalse(ui(editor::isDirty));
        eval(browser, "window.devmApp.applyTextEdits([{ offset: 0, length: 0, text: '// again\\n' }]); return null;");
        waitFor("dirty again", () -> ui(editor::isDirty));
        eval(browser, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); return null;");
        waitFor("saved by the page", () -> read(file).startsWith("// again\n") && !ui(editor::isDirty));

        // external change of the file: shown in the page
        file.setContents(new ByteArrayInputStream("// external\n".concat(GATE).getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
        waitFor("external change in the page", () -> String.valueOf(eval(browser, "return window.devmApp.getText();")).startsWith("// external\n"));
        assertFalse(ui(editor::isDirty));

        // settings of the page are stored in the preferences
        eval(browser, "const s = document.getElementById('direction-select'); s.value = 'RIGHT'; s.dispatchEvent(new Event('change')); return null;");
        waitFor("settings stored", () -> Preferences.store().getString(Preferences.PAGE_SETTINGS).contains("\"RIGHT\""));
        eval(browser, "const s = document.getElementById('direction-select'); s.value = 'DOWN'; s.dispatchEvent(new Event('change')); return null;");

        // C++ generation (command of the active editor): devm.gen.json → gen/, license header file, header include
        command("devm.eclipse.generateCpp");
        IFile header = project.getFile("gen/Gate.h");
        waitFor(() -> "generated: " + eval(browser, "return document.getElementById('status-message').textContent;"), header::exists);
        String generated = read(header);
        assertTrue(generated, generated.contains("Test license"));
        assertTrue(generated, generated.contains("#include \"types.h\""));
        assertTrue(project.getFile("gen/Gate.cpp").exists());

        // rename: the editor follows the file
        file.move(new Path("gate-renamed.devm"), true, null);
        IFile renamed = project.getFile("models/door/gate-renamed.devm");
        waitFor("editor follows the rename", () -> renamed.equals(editor.file()));
        assertEquals("gate-renamed.devm", ui(editor::getPartName));
        waitFor("page follows the rename", () -> "gate-renamed.devm".equals(eval(browser, "return document.getElementById('file-name').textContent;")));

        // move to another folder: imports are resolved against the new location ("../motor.devm" is now missing)
        renamed.move(project.getFullPath().append("gate-moved.devm"), true, null);
        IFile moved = project.getFile("gate-moved.devm");
        waitFor("editor follows the move", () -> moved.equals(editor.file()));
        waitFor("import error after the move", () -> errorMarkers(moved).length > 0);

        // Save As
        IFile copy = project.getFile("models/sub/copy.devm");
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

    /**
     * Go to definition in the page's text editor: a C++ name opens the header in the editor of its type (the
     * text editor without CDT) with the declaration selected, an import path opens the imported model in the Device Modeler
     * editor (api/open with a position).
     */
    @Test
    public void navigationFromThePage() throws Exception {
        IFile file = project.getFile("models/door/gate.devm");
        DevmDiagramEditor editor = open(file);
        Browser browser = browserOf(editor);
        waitFor("page loaded", () -> Boolean.TRUE.equals(eval(browser, "return !!window.devmApp && !!window.devmApp.diagram"
                + " && /^(✓|0 errors)/.test(document.getElementById('status-problems').textContent);")));

        // F12 on `Mode` of `t::Mode::On`: include/types.h, `Mode` of `enum class Mode { Off, On };` selected
        eval(browser, "const e = window.devmApp.editor; const m = e.getModel(); e.setPosition(m.getPositionAt(m.getValue().indexOf('t::Mode::On') + 4));"
                + " e.focus(); e.trigger('test', 'editor.action.revealDefinition', null); return null;");
        IFile header = project.getFile("include/types.h");
        waitFor(() -> "header opened: " + ui(() -> String.valueOf(activeEditor())), () -> ui(() -> header.equals(activeEditor().getEditorInput().getAdapter(IFile.class))));
        ITextEditor text = ui(() -> activeEditor().getAdapter(ITextEditor.class));
        assertNotNull("a text editor for the header", text);
        ITextSelection selection = ui(() -> (ITextSelection) text.getSelectionProvider().getSelection());
        assertEquals(2, selection.getStartLine());
        assertEquals("Mode", selection.getText());

        // the import path of a model: the Device Modeler editor of motor.devm
        ui(() -> {
            PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().activate(editor);
            return null;
        });
        eval(browser, "const e = window.devmApp.editor; const m = e.getModel(); e.setPosition(m.getPositionAt(m.getValue().indexOf('motor.devm')));"
                + " e.focus(); e.trigger('test', 'editor.action.revealDefinition', null); return null;");
        IFile motor = project.getFile("models/motor.devm");
        waitFor("model opened", () -> ui(() -> activeEditor() instanceof DevmDiagramEditor devm && motor.equals(devm.file())));

        // the host API with a position (as the page sends it): line 5, column 11 of motor.devm selects `Off`
        DevmDiagramEditor motorEditor = (DevmDiagramEditor) ui(DevmDiagramEditorTest::activeEditor);
        Browser motorBrowser = browserOf(motorEditor);
        waitFor("motor page loaded", () -> Boolean.TRUE.equals(eval(motorBrowser, "return !!window.devmApp && !!window.devmApp.diagram;")));
        assertTrue(editor.open("models/motor.devm", new HostSession.Position(5, 11, 5, 14)));
        waitFor("position revealed", () -> "Off".equals(eval(motorBrowser,
                "const e = window.devmApp.editor; return e.getModel().getValueInRange(e.getSelection());")));
        assertFalse(editor.open("models/missing.h", null));
    }

    private static IEditorPart activeEditor() {
        return PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().getActiveEditor();
    }

    @Test
    public void builderWithValidator() throws Exception {
        DevmTools.setValidator((model, monitor) -> List.of(new ModelProblem(IMarker.SEVERITY_WARNING, "checked " + model.getName(), 2, 1, -1, -1)));
        DevmNature.toggle(project);
        project.build(IncrementalProjectBuilder.FULL_BUILD, null);
        IMarker[] markers = project.getFile("models/motor.devm").findMarkers(ProblemMarkers.TYPE, false, IResource.DEPTH_ZERO);
        assertEquals(1, markers.length);
        assertEquals("checked motor.devm", markers[0].getAttribute(IMarker.MESSAGE));
        assertEquals(2, markers[0].getAttribute(IMarker.LINE_NUMBER, -1));
    }

    /**
     * The builder with the devm executable (the platform fragment of the build, a preference or the PATH): closed
     * files get markers with ranges; the models importing a changed header are validated again.
     */
    @Test
    public void builderWithExecutable() throws Exception {
        Assume.assumeTrue("no devm executable (build packages/cli first: npm run build:exe)", DevmExecutable.locate().isPresent());
        DevmTools.setValidator(new CliValidator());
        create("models/broken.devm", "statemachine Broken {\n    [*] -> Missing\n    state Idle\n}\n");
        DevmNature.toggle(project);
        project.build(IncrementalProjectBuilder.FULL_BUILD, null);

        IMarker[] broken = errorMarkers(project.getFile("models/broken.devm"));
        assertTrue("an error in broken.devm", broken.length > 0);
        assertEquals(2, broken[0].getAttribute(IMarker.LINE_NUMBER, -1));
        String text = "statemachine Broken {\n    [*] -> Missing\n    state Idle\n}\n";
        assertTrue(text.substring(broken[0].getAttribute(IMarker.CHAR_START, 0), broken[0].getAttribute(IMarker.CHAR_END, 0)).contains("Missing"));
        // ../motor.devm and types.h through the include path of devm.gen.json
        assertEquals(0, errorMarkers(project.getFile("models/door/gate.devm")).length);

        // a changed header: the (closed, unchanged) importing model is validated again
        project.getFile("include/types.h").setContents(new ByteArrayInputStream("#pragma once\nnamespace t {\n}\n".getBytes(StandardCharsets.UTF_8)),
                IResource.FORCE, null);
        // (the auto build may have taken the change already)
        org.eclipse.core.runtime.jobs.Job.getJobManager().join(ResourcesPlugin.FAMILY_AUTO_BUILD, null);
        project.build(IncrementalProjectBuilder.INCREMENTAL_BUILD, null);
        waitFor("gate.devm: t::Mode is missing", () -> errorMarkers(project.getFile("models/door/gate.devm")).length > 0);
    }

    /**
     * A structure file in the Device Modeler editor: the page shows the structure diagram, reports problems and
     * the outline of the structure; go to definition of a component type opens the structure file declaring it,
     * the behavior path of a component its state machine (both in the Device Modeler editor, api/open).
     */
    @Test
    public void structureFile() throws Exception {
        create("models/parts.devm", PARTS);
        create("models/drive.devm", DRIVE);
        IFile file = project.getFile("models/drive.devm");
        DevmDiagramEditor editor = open(file);
        Browser browser = browserOf(editor);
        waitFor(() -> "page loaded: " + eval(browser, "return (document.getElementById('status-problems') || {}).title;"),
                () -> Boolean.TRUE.equals(eval(browser, "return !!window.devmApp && !!window.devmApp.diagram"
                        + " && /^(✓|0 errors)/.test(document.getElementById('status-problems').textContent);")));
        assertEquals(DRIVE, eval(browser, "return window.devmApp.getText();"));

        // the structure diagram (internal block diagram of the subsystem) with the instance of the other file
        // (the class is set before the layout; the diagram itself is rendered in an animation frame, which WebKit
        // does not run while the workbench window is not visible, e.g. on a locked screen)
        waitFor("structure diagram", () -> Boolean.TRUE.equals(eval(browser,
                "return document.getElementById('diagram-area').classList.contains('structure-diagram');")));
        if (Boolean.TRUE.equals(eval(browser, "return document.visibilityState === 'visible';"))) {
            waitFor(() -> "structure diagram rendered: " + eval(browser, "return document.getElementById('sprotty').outerHTML.substring(0, 300);"),
                    () -> Boolean.TRUE.equals(eval(browser, "const svg = document.querySelector('#sprotty svg.ibd');"
                            + " return !!svg && svg.textContent.includes('motor : MotorUnit');")));
        } else {
            System.out.println("structureFile: the page is not visible (no animation frames), the rendered diagram is not checked");
        }
        waitFor("no error markers", () -> errorMarkers(file).length == 0);

        // outline of the structure
        DevmOutlinePage outlinePage = (DevmOutlinePage) ui(() -> editor.getAdapter(IContentOutlinePage.class));
        waitFor("outline", () -> ui(() -> !outlinePage.nodes().isEmpty()));
        List<DevmOutlinePage.Node> outline = ui(outlinePage::nodes);
        assertEquals("subsystem Drive", outline.get(0).label());
        assertEquals("subsystem", outline.get(0).kind());
        DevmOutlinePage.Node thread = outline.get(0).children().stream().filter(n -> n.kind().equals("thread")).findFirst().orElseThrow();
        assertEquals("motor : MotorUnit", thread.children().get(0).label());
        assertTrue(outline.get(0).children().stream().anyMatch(n -> n.kind().equals("delegation")));

        // an unknown port: an error marker; undone again
        eval(browser, "window.devmApp.applyTextEdits([{ offset: window.devmApp.getText().indexOf('motor.start'), length: 11, text: 'motor.stop' }]);"
                + " window.devmApp.diagram.scheduleUpdate(0); return null;");
        waitFor("error marker", () -> errorMarkers(file).length > 0);
        command(IWorkbenchCommandConstants.EDIT_UNDO);
        waitFor("undone", () -> DRIVE.equals(eval(browser, "return window.devmApp.getText();")));
        waitFor("error marker removed", () -> errorMarkers(file).length == 0);
        waitFor("not dirty", () -> !ui(editor::isDirty));

        // F12 on the component type of the instance: parts.devm in the Device Modeler editor
        eval(browser, "const e = window.devmApp.editor; const m = e.getModel(); e.setPosition(m.getPositionAt(m.getValue().indexOf('MotorUnit') + 2));"
                + " e.focus(); e.trigger('test', 'editor.action.revealDefinition', null); return null;");
        IFile parts = project.getFile("models/parts.devm");
        waitFor(() -> "parts.devm opened: " + ui(() -> String.valueOf(activeEditor())),
                () -> ui(() -> activeEditor() instanceof DevmDiagramEditor devm && parts.equals(devm.file())));
        DevmDiagramEditor partsEditor = (DevmDiagramEditor) ui(DevmDiagramEditorTest::activeEditor);
        Browser partsBrowser = browserOf(partsEditor);
        waitFor("parts page loaded", () -> Boolean.TRUE.equals(eval(partsBrowser, "return !!window.devmApp && !!window.devmApp.diagram"
                + " && document.getElementById('diagram-area').classList.contains('structure-diagram');")));
        // the definition is selected (api/open with the position of the declaration)
        waitFor(() -> "declaration selected: " + eval(partsBrowser, "const e = window.devmApp.editor; return e.getModel().getValueInRange(e.getSelection());"),
                () -> String.valueOf(eval(partsBrowser, "const e = window.devmApp.editor; return e.getModel().getValueInRange(e.getSelection());")).contains("MotorUnit")
                        || Integer.valueOf(3).equals(number(eval(partsBrowser, "return window.devmApp.editor.getSelection().startLineNumber;"))));

        // the host API with a position: line 5 of parts.devm selects the port `start`
        assertTrue(editor.open("models/parts.devm", new HostSession.Position(5, 14, 5, 19)));
        waitFor("position revealed", () -> "start".equals(eval(partsBrowser,
                "const e = window.devmApp.editor; return e.getModel().getValueInRange(e.getSelection());")));

        // Generate C++ of a structure file: nothing is generated (a structure file has no code of its own)
        assertTrue(ProjectFiles.isStructureFile(parts));
        assertFalse(ProjectFiles.isStructureFile(project.getFile("models/motor.devm")));
        assertTrue(ProjectFiles.isStructureText("\uFEFF// comment\nimport \"x.devm\"\n"));
        assertFalse(ProjectFiles.isStructureText("/* a\n state machine */\n// of the door\nstatemachine Door {\n}\n"));
    }

    /**
     * The builder with the devm executable and structure files: a structure file is validated against the state
     * machine of its components (behavior); a change of that state machine validates the structure file again.
     */
    @Test
    public void builderWithStructureFiles() throws Exception {
        Assume.assumeTrue("no devm executable (build packages/cli first: npm run build:exe)", DevmExecutable.locate().isPresent());
        DevmTools.setValidator(new CliValidator());
        create("models/parts.devm", PARTS);
        create("models/drive.devm", DRIVE);
        DevmNature.toggle(project);
        project.build(IncrementalProjectBuilder.FULL_BUILD, null);
        assertEquals(0, errorMarkers(project.getFile("models/parts.devm")).length);
        assertEquals(0, errorMarkers(project.getFile("models/drive.devm")).length);

        // the event `start` of the behavior disappears: the port `start` of MotorUnit has no counterpart
        project.getFile("models/motor.devm").setContents(new ByteArrayInputStream(MOTOR.replace("start", "run").getBytes(StandardCharsets.UTF_8)),
                IResource.FORCE, null);
        org.eclipse.core.runtime.jobs.Job.getJobManager().join(ResourcesPlugin.FAMILY_AUTO_BUILD, null);
        project.build(IncrementalProjectBuilder.INCREMENTAL_BUILD, null);
        waitFor("parts.devm: the port start has no event in motor.devm", () -> errorMarkers(project.getFile("models/parts.devm")).length > 0);
        assertTrue(errorMarkers(project.getFile("models/parts.devm"))[0].getAttribute(IMarker.MESSAGE, "").contains("start"));
    }

    // ---------------------------------------------------------------------------------------------------------

    private static DevmDiagramEditor open(IFile file) {
        IEditorPart part = ui(() -> {
            IWorkbenchPage page = PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage();
            try {
                return IDE.openEditor(page, file);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        assertTrue("default editor of .devm: " + part.getClass(), part instanceof DevmDiagramEditor);
        return (DevmDiagramEditor) part;
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

    private static Browser browserOf(DevmDiagramEditor editor) throws Exception {
        Field field = DevmDiagramEditor.class.getDeclaredField("browser");
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
