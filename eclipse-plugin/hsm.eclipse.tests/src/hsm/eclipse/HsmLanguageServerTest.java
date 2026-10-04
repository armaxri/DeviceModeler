package hsm.eclipse;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IFolder;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.content.IContentType;
import org.eclipse.jface.text.IDocument;
import org.eclipse.jface.text.ITextViewer;
import org.eclipse.jface.text.Region;
import org.eclipse.lsp4e.operations.hover.LSPTextHover;
import org.eclipse.swt.custom.StyleRange;
import org.eclipse.swt.widgets.Display;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IFileEditorInput;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.handlers.IHandlerService;
import org.eclipse.ui.ide.IDE;
import org.eclipse.ui.texteditor.ITextEditor;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import hsm.eclipse.tools.HsmExecutable;

/**
 * Language support in Eclipse's Generic Editor (plugin hsm.eclipse.lsp): LSP4E starts {@code hsm lsp --stdio} of
 * the hsm executable for .hsm / .hsmtest files; diagnostics as markers, hover with the documentation of a header,
 * F3 (open hyperlink) into the header found through the include paths of {@code hsm.gen.json}, formatting, TM4E
 * highlighting. The HSM Modeler stays the default editor of .hsm.
 */
public class HsmLanguageServerTest {

    private static final String GENERIC_EDITOR = "org.eclipse.ui.genericeditor.GenericEditor";
    private static final String LSP_MARKER = "org.eclipse.lsp4e.diagnostic";
    private static final String CONFIG = "{\n  \"headers\": { \"includePaths\": [\"include\"] }\n}\n";
    private static final String TYPES = "#pragma once\nnamespace io {\n/** Number of steps. */\nconstexpr int kSteps = 4;\n}\n";
    private static final String GATE = "statemachine Gate {\n    import \"types.h\"\n    interface:\n        var steps : integer = io::kSteps\n"
            + "        var bad : integer = unknownName\n    [*] -> Closed\n    state Closed\n}\n";

    private IProject project;

    @Before
    public void createProject() throws Exception {
        Assume.assumeTrue("no hsm executable (build packages/cli first: npm run build:exe)", HsmExecutable.locate().isPresent());
        project = ResourcesPlugin.getWorkspace().getRoot().getProject("hsm-lsp-test");
        if (!project.exists()) {
            project.create(null);
        }
        project.open(null);
        create("hsm.gen.json", CONFIG);
        create("include/types.h", TYPES);
        create("models/gate.hsm", GATE);
        create("models/gate.hsmtest", "testclass GateTest for statemachine Gate {\n}\n");
        // without CDT a header has no editor: the text editor instead of the system editor of the OS
        IDE.setDefaultEditor(project.getFile("include/types.h"), "org.eclipse.ui.DefaultTextEditor");
    }

    @After
    public void deleteProject() throws Exception {
        if (project == null) {
            return;
        }
        ui(() -> {
            PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage().closeAllEditors(false);
            return null;
        });
        project.delete(true, null);
    }

    @Test
    public void editorAssociations() throws Exception {
        IContentType hsm = Platform.getContentTypeManager().getContentType("hsm.eclipse.hsm");
        IContentType hsmTest = Platform.getContentTypeManager().getContentType("hsm.eclipse.hsmtest");
        assertNotNull(hsmTest);
        var registry = PlatformUI.getWorkbench().getEditorRegistry();
        assertEquals("hsm.eclipse.editor", registry.getDefaultEditor("gate.hsm", hsm).getId());
        assertEquals(GENERIC_EDITOR, registry.getDefaultEditor("gate.hsmtest", hsmTest).getId());
        assertTrue("Open With offers the Generic Editor for .hsm",
                Arrays.stream(registry.getEditors("gate.hsm", hsm)).anyMatch(editor -> GENERIC_EDITOR.equals(editor.getId())));
    }

    @Test
    public void languageServerInGenericEditor() throws Exception {
        IFile file = project.getFile("models/gate.hsm");
        ITextEditor editor = ui(() -> {
            try {
                return (ITextEditor) IDE.openEditor(page(), file, GENERIC_EDITOR);
            } catch (CoreException e) {
                throw new RuntimeException(e);
            }
        });
        ITextViewer viewer = ui(() -> editor.getAdapter(ITextViewer.class));
        assertNotNull("text viewer", viewer);
        IDocument document = ui(viewer::getDocument);

        // diagnostics of the language server as markers: only the unknown name, the header of the include path resolves
        waitFor(() -> "LSP diagnostics: " + markerMessages(file) + " | " + languageServerState(document),
                () -> markerMessages(file).contains("unknownName") && !markerMessages(file).contains("kSteps"));

        // hover: the documentation comment of the header
        int steps = GATE.indexOf("kSteps") + 2;
        AtomicReference<String> hover = new AtomicReference<>();
        waitFor(() -> "hover: " + hover.get(), () -> {
            hover.set(new LSPTextHover().getHoverInfo(viewer, new Region(steps, 0)));
            return hover.get() != null && hover.get().contains("Number of steps.");
        });

        // TM4E: the keyword `statemachine` is highlighted
        waitFor("TextMate highlighting", () -> ui(() -> {
            StyleRange range = viewer.getTextWidget().getStyleRangeAtOffset(1);
            return range != null && range.foreground != null;
        }));

        // F3 (open hyperlink of the language server's definition) opens the header
        waitFor(() -> "definition opens the header: " + activeFileName(), () -> {
            ui(() -> {
                if (page().getActiveEditor() != editor) {
                    page().activate(editor);
                }
                editor.selectAndReveal(steps, 0);
                try {
                    PlatformUI.getWorkbench().getService(IHandlerService.class).executeCommand("org.eclipse.ui.edit.text.open.hyperlink", null);
                } catch (Exception e) {
                    // not enabled yet
                }
                return null;
            });
            return "types.h".equals(activeFileName());
        });

        // formatting (Ctrl+Shift+F of LSP4E): the indentation of the model is corrected
        ui(() -> {
            page().activate(editor);
            document.set(GATE.replace("    state Closed", "state Closed"));
            return null;
        });
        waitFor(() -> "formatted: " + ui(document::get), () -> {
            ui(() -> {
                try {
                    PlatformUI.getWorkbench().getService(IHandlerService.class).executeCommand("org.eclipse.lsp4e.format", null);
                } catch (Exception e) {
                    // not enabled yet
                }
                return null;
            });
            // indented with the editor's settings (tabs by default in Eclipse)
            String text = ui(document::get);
            return text.contains("\n\tstate Closed\n") || text.contains("\n    state Closed\n");
        });
        ui(() -> {
            editor.doRevertToSaved();
            return null;
        });
    }

    private void create(String path, String text) throws CoreException {
        IFile file = project.getFile(path);
        if (file.getParent() instanceof IFolder folder && !folder.exists()) {
            folder.create(true, true, null);
        }
        file.create(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), IResource.FORCE, null);
    }

    private static String markerMessages(IFile file) {
        try {
            StringBuilder messages = new StringBuilder();
            for (IMarker marker : file.findMarkers(LSP_MARKER, true, IResource.DEPTH_ZERO)) {
                messages.append(marker.getAttribute(IMarker.MESSAGE, "")).append('\n');
            }
            return messages.toString();
        } catch (CoreException e) {
            return e.toString();
        }
    }

    /** For failure messages: whether LSP4E knows the server and connected the document. */
    private static String languageServerState(IDocument document) {
        var registry = org.eclipse.lsp4e.LanguageServersRegistry.getInstance();
        String definition = String.valueOf(registry.getDefinition("hsm.eclipse.lsp.server"));
        String state;
        try {
            state = "matching: " + org.eclipse.lsp4e.LanguageServers.forDocument(document).anyMatching()
                    + ", capabilities: " + org.eclipse.lsp4e.LanguageServers.forDocument(document)
                            .computeFirst((wrapper, server) -> java.util.concurrent.CompletableFuture.completedFuture(String.valueOf(wrapper.getServerCapabilities())))
                            .get(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            state = e.toString();
        }
        return "definition: " + definition + ", " + state;
    }

    private static String activeFileName() {
        return ui(() -> {
            IEditorPart active = page().getActiveEditor();
            return active != null && active.getEditorInput() instanceof IFileEditorInput input ? input.getFile().getName() : String.valueOf(active);
        });
    }

    private static IWorkbenchPage page() {
        return PlatformUI.getWorkbench().getActiveWorkbenchWindow().getActivePage();
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
            Thread.sleep(500);
        }
        throw new AssertionError("Timeout: " + what.get());
    }
}
