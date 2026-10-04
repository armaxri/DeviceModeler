package devm.eclipse;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IResourceChangeEvent;
import org.eclipse.core.resources.IResourceChangeListener;
import org.eclipse.core.resources.IResourceDelta;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;
import org.eclipse.jface.dialogs.ErrorDialog;
import org.eclipse.jface.text.BadLocationException;
import org.eclipse.jface.text.IDocument;
import org.eclipse.jface.text.IRegion;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.window.Window;
import org.eclipse.swt.SWT;
import org.eclipse.swt.SWTError;
import org.eclipse.swt.SWTException;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.dnd.Clipboard;
import org.eclipse.swt.dnd.TextTransfer;
import org.eclipse.swt.dnd.Transfer;
import org.eclipse.swt.layout.FillLayout;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Text;
import org.eclipse.ui.IEditorDescriptor;
import org.eclipse.ui.IEditorInput;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IEditorSite;
import org.eclipse.ui.IWorkbenchCommandConstants;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.PartInitException;
import org.eclipse.ui.dialogs.SaveAsDialog;
import org.eclipse.ui.handlers.IHandlerService;
import org.eclipse.ui.ide.IDE;
import org.eclipse.ui.ide.IGotoMarker;
import org.eclipse.ui.part.EditorPart;
import org.eclipse.ui.part.FileEditorInput;
import org.eclipse.ui.texteditor.ITextEditor;
import org.eclipse.ui.views.contentoutline.IContentOutlinePage;

import devm.eclipse.tools.ModelProblem;

/**
 * Editor of {@code .devm} files: the Device Modeler web app (Monaco text editor + diagram) in an SWT {@link Browser},
 * served by the {@link WebServer} of the plugin (protocol: packages/web/src/host.ts). State machines and structure
 * files share the extension: the page shows the state machine diagram or the structure diagram (internal block
 * diagram) depending on the text, so one editor serves both.
 * <ul>
 * <li>the page gets the text of the workspace file and the importable files of the project (all models: a structure
 * diagram shows where a component is used and follows connections across files), reports changes
 * (dirty state) and saves (<i>Save</i> in Eclipse, {@code Ctrl+S} / <i>Save</i> in the page, <i>Save As…</i>)</li>
 * <li>problems of the page → markers ({@link ProblemMarkers}), {@link IGotoMarker} reveals them in the page</li>
 * <li>outline of the page → Outline view ({@link DevmOutlinePage})</li>
 * <li>Eclipse's edit commands (undo, redo, cut, copy, paste, select all, find/replace) → the page</li>
 * <li>external changes, moves and renames of the file are followed</li>
 * </ul>
 */
public class DevmDiagramEditor extends EditorPart implements HostSession, IGotoMarker {

    public static final String ID = "devm.eclipse.editor";

    /** System property: browser engine ({@code edge}, {@code webkit}, {@code chromium} or {@code default}). */
    public static final String BROWSER_PROPERTY = "devm.browser";

    /** Eclipse commands handled by the page ({@code devmApp.hostCommand}). */
    private static final Map<String, String> EDIT_COMMANDS = Map.of(
            IWorkbenchCommandConstants.EDIT_UNDO, "undo",
            IWorkbenchCommandConstants.EDIT_REDO, "redo",
            IWorkbenchCommandConstants.EDIT_CUT, "cut",
            IWorkbenchCommandConstants.EDIT_COPY, "copy",
            IWorkbenchCommandConstants.EDIT_PASTE, "paste",
            IWorkbenchCommandConstants.EDIT_SELECT_ALL, "selectAll",
            IWorkbenchCommandConstants.EDIT_FIND_AND_REPLACE, "find");

    private volatile IFile file;
    private Browser browser;
    private Display display;
    private WebServer server;
    /** The text of the file (as last loaded or saved). */
    private volatile String savedText;
    /** The text of the page (as last reported). */
    private volatile String currentText;
    private boolean dirty;
    private boolean darkTheme;
    /** The page has started (it reported its model); scripts for the page wait in {@link #pendingScripts} until then. */
    private volatile boolean pageReady;
    private final List<String> pendingScripts = new ArrayList<>();
    private DevmOutlinePage outlinePage;
    private List<DevmOutlinePage.Node> outline = List.of();
    private final IResourceChangeListener resourceListener = this::resourceChanged;

    @Override
    public void init(IEditorSite site, IEditorInput input) throws PartInitException {
        IFile inputFile = input.getAdapter(IFile.class);
        if (inputFile == null) {
            throw new PartInitException("The Device Modeler editor only opens files of the workspace.");
        }
        setSite(site);
        setFile(inputFile, input);
        try {
            savedText = ProjectFiles.read(inputFile);
        } catch (CoreException | IOException e) {
            throw new PartInitException("Cannot read " + inputFile.getFullPath() + ": " + e.getMessage(), e);
        }
        currentText = savedText;
        ResourcesPlugin.getWorkspace().addResourceChangeListener(resourceListener, IResourceChangeEvent.POST_CHANGE);
    }

    private void setFile(IFile newFile, IEditorInput input) {
        file = newFile;
        if (getEditorInput() == null) {
            setInput(input);
        } else {
            setInputWithNotify(input);
        }
        setPartName(newFile.getName());
        setTitleToolTip(newFile.getFullPath().toString());
    }

    /** The edited file. */
    public IFile file() {
        return file;
    }

    @Override
    public void createPartControl(Composite parent) {
        display = parent.getDisplay();
        darkTheme = isDarkTheme(display);
        parent.setLayout(new FillLayout());
        try {
            server = Activator.getDefault().server();
            browser = new Browser(parent, browserStyle());
            browser.setUrl(server.register(this));
            activateEditCommands();
        } catch (IOException | SWTError e) {
            if (browser != null) {
                browser.dispose();
                browser = null;
            }
            Text message = new Text(parent, SWT.MULTI | SWT.READ_ONLY | SWT.WRAP);
            message.setText("The Device Modeler diagram editor cannot be shown: " + e.getMessage()
                    + "\n\nOpen the file with the text editor instead (Open With > Text Editor).");
            Activator.getDefault().getLog().log(new Status(IStatus.ERROR, Activator.PLUGIN_ID, "Device Modeler editor", e));
        }
    }

    /** Browser engine: Edge (WebView2) on Windows (the default engine of older Eclipse versions is Internet Explorer). */
    private static int browserStyle() {
        String engine = System.getProperty(BROWSER_PROPERTY, "").toLowerCase(Locale.ROOT);
        return switch (engine) {
            case "edge" -> SWT.EDGE;
            case "webkit" -> SWT.WEBKIT;
            case "chromium" -> SWT.CHROMIUM;
            case "default" -> SWT.NONE;
            default -> Platform.OS_WIN32.equals(Platform.getOS()) ? SWT.EDGE : SWT.NONE;
        };
    }

    /** Whether Eclipse uses a dark theme (the CSS theme engine of the workbench, otherwise the system). */
    private static boolean isDarkTheme(Display display) {
        Object engine = display.getData("org.eclipse.e4.ui.css.swt.theme");
        if (engine != null) {
            try {
                Object theme = engine.getClass().getMethod("getActiveTheme").invoke(engine);
                if (theme != null) {
                    Object id = theme.getClass().getMethod("getId").invoke(theme);
                    return id != null && id.toString().toLowerCase(Locale.ROOT).contains("dark");
                }
            } catch (ReflectiveOperationException | RuntimeException e) {
                // no theme engine
            }
        }
        return Display.isSystemDarkTheme();
    }

    @Override
    public void setFocus() {
        if (browser != null) {
            browser.setFocus();
        }
    }

    @Override
    public void dispose() {
        ResourcesPlugin.getWorkspace().removeResourceChangeListener(resourceListener);
        if (server != null) {
            server.unregister(this);
        }
        super.dispose();
    }

    @Override
    public <T> T getAdapter(Class<T> adapter) {
        if (adapter == IContentOutlinePage.class) {
            if (outlinePage == null || outlinePage.getControl() == null || outlinePage.getControl().isDisposed()) {
                outlinePage = new DevmOutlinePage(this);
                outlinePage.setNodes(outline);
            }
            return adapter.cast(outlinePage);
        }
        if (adapter == IGotoMarker.class) {
            return adapter.cast(this);
        }
        return super.getAdapter(adapter);
    }

    // ---------------------------------------------------------------------------------------------------------
    // The page

    /** Runs a script in the page once it has started (UI thread or any thread). */
    public void runInPage(String script) {
        runInUi(() -> {
            if (browser == null || browser.isDisposed()) {
                return;
            }
            if (pageReady) {
                browser.execute(script);
            } else {
                pendingScripts.add(script);
            }
        });
    }

    private void pageStarted() {
        if (!pageReady) {
            pageReady = true;
            List<String> scripts = new ArrayList<>(pendingScripts);
            pendingScripts.clear();
            scripts.forEach(browser::execute);
        }
    }

    /** Selects a range of the text in the page (and the diagram element there). */
    public void reveal(int offset, int end, boolean activate) {
        if (activate) {
            getSite().getPage().activate(this);
        }
        runInPage("window.devmApp.revealRange(" + offset + "," + end + ");");
    }

    @Override
    public void gotoMarker(IMarker marker) {
        int start = marker.getAttribute(IMarker.CHAR_START, -1);
        int end = marker.getAttribute(IMarker.CHAR_END, start);
        if (start < 0) {
            // only a line (e.g. a validator of the command line tool): its start
            int line = marker.getAttribute(IMarker.LINE_NUMBER, 1);
            start = offsetOfLine(currentText, line);
            end = start;
        }
        reveal(start, end, false);
    }

    private static int offsetOfLine(String text, int line) {
        int offset = 0;
        for (int i = 1; i < line && offset >= 0; i++) {
            offset = text.indexOf('\n', offset);
            offset = offset < 0 ? -1 : offset + 1;
        }
        return Math.max(offset, 0);
    }

    /** Eclipse's edit commands (menus and key bindings) while the editor is active: applied in the page. */
    private void activateEditCommands() {
        IHandlerService handlers = getSite().getService(IHandlerService.class);
        for (Map.Entry<String, String> command : EDIT_COMMANDS.entrySet()) {
            handlers.activateHandler(command.getKey(), new AbstractHandler() {
                @Override
                public Object execute(ExecutionEvent event) {
                    pageCommand(command.getValue());
                    return null;
                }
            });
        }
    }

    /**
     * Runs an edit command in the page ({@code devmApp.hostCommand}): later in the UI thread, not in the key
     * event (some engines do not allow scripts in their callbacks); copy and cut put the text into the clipboard.
     */
    private void pageCommand(String command) {
        String argument = null;
        if (command.equals("paste")) {
            Clipboard clipboard = new Clipboard(display);
            try {
                argument = (String) clipboard.getContents(TextTransfer.getInstance());
            } finally {
                clipboard.dispose();
            }
            if (argument == null) {
                return;
            }
        }
        String script = "return window.devmApp && window.devmApp.diagram ? window.devmApp.hostCommand(" + Json.quote(command)
                + (argument != null ? "," + Json.quote(argument) : "") + ") : false;";
        display.asyncExec(() -> {
            if (browser == null || browser.isDisposed()) {
                return;
            }
            Object result;
            try {
                result = browser.evaluate(script);
            } catch (SWTException e) {
                return;
            }
            if ((command.equals("copy") || command.equals("cut")) && result instanceof String text && !text.isEmpty()) {
                Clipboard clipboard = new Clipboard(display);
                try {
                    clipboard.setContents(new Object[] { text }, new Transfer[] { TextTransfer.getInstance() });
                } finally {
                    clipboard.dispose();
                }
            }
        });
    }

    // ---------------------------------------------------------------------------------------------------------
    // Save and dirty state

    @Override
    public boolean isDirty() {
        return dirty;
    }

    private void setDirty(boolean dirty) {
        if (this.dirty != dirty) {
            this.dirty = dirty;
            firePropertyChange(PROP_DIRTY);
        }
    }

    @Override
    public void doSave(IProgressMonitor monitor) {
        try {
            write(file, textOfPage(), monitor);
        } catch (CoreException e) {
            ErrorDialog.openError(getSite().getShell(), "Save failed", "Cannot save " + file.getFullPath(), e.getStatus());
            if (monitor != null) {
                monitor.setCanceled(true);
            }
        }
    }

    @Override
    public boolean isSaveAsAllowed() {
        return true;
    }

    @Override
    public void doSaveAs() {
        SaveAsDialog dialog = new SaveAsDialog(getSite().getShell());
        dialog.setOriginalFile(file);
        if (dialog.open() != Window.OK || dialog.getResult() == null) {
            return;
        }
        IPath path = dialog.getResult();
        if (path.getFileExtension() == null) {
            path = path.addFileExtension("devm");
        }
        saveAs(ResourcesPlugin.getWorkspace().getRoot().getFile(path));
    }

    /** Saves the text in another file and edits that file from now on (the original file is not changed). */
    public void saveAs(IFile target) {
        String text = textOfPage();
        IFile previous = file;
        try {
            setFile(target, new FileEditorInput(target));
            write(target, text, null);
        } catch (CoreException e) {
            setFile(previous, new FileEditorInput(previous));
            ErrorDialog.openError(getSite().getShell(), "Save As failed", "Cannot save " + target.getFullPath(), e.getStatus());
            return;
        }
        reloadPage(false);
    }

    /** The current text of the page (the last reported text if the page cannot be asked). */
    private String textOfPage() {
        if (browser != null && !browser.isDisposed()) {
            try {
                Object text = browser.evaluate("return window.devmApp && window.devmApp.diagram ? window.devmApp.getText() : null;");
                if (text instanceof String string) {
                    currentText = string;
                }
            } catch (SWTException e) {
                // page not loaded (yet)
            }
        }
        return currentText;
    }

    private void write(IFile target, String text, IProgressMonitor monitor) throws CoreException {
        byte[] bytes;
        try {
            bytes = text.getBytes(target.exists() ? target.getCharset() : target.getParent().getDefaultCharset());
        } catch (IOException e) {
            throw new CoreException(new Status(IStatus.ERROR, Activator.PLUGIN_ID, e.getMessage(), e));
        }
        // before writing: the resource change of the save is not an external change
        String previous = savedText;
        savedText = text;
        try {
            ProjectFiles.write(target, bytes, monitor);
        } catch (CoreException | IOException e) {
            savedText = previous;
            throw e instanceof CoreException core ? core : new CoreException(new Status(IStatus.ERROR, Activator.PLUGIN_ID, e.getMessage(), e));
        }
        currentText = text;
        runInUi(() -> setDirty(false));
    }

    // ---------------------------------------------------------------------------------------------------------
    // HostSession (called by the web server, not on the UI thread)

    @Override
    public Map<String, Object> document() throws IOException {
        IFile current = file;
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("fileName", current.getName());
        document.put("path", ProjectFiles.path(current));
        document.put("text", currentText);
        try {
            document.put("files", ProjectFiles.importableFiles(current.getProject(), current));
            document.put("configs", ProjectFiles.generatorConfigs(current));
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
        document.put("cppSettings", Preferences.cppSettings());
        String settings = Preferences.store().getString(Preferences.PAGE_SETTINGS);
        if (!settings.isEmpty()) {
            document.put("settings", settings);
        }
        document.put("theme", darkTheme ? "dark" : "light");
        return document;
    }

    @Override
    public String file(String path) throws IOException {
        IFile target = ProjectFiles.resolve(file.getProject(), path);
        if (target == null || !target.exists()) {
            return null;
        }
        try {
            return ProjectFiles.read(target);
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
    }

    @Override
    public void changed(String text) {
        currentText = text;
        runInUi(() -> setDirty(!text.equals(savedText)));
    }

    @Override
    public void save(String text) throws IOException {
        try {
            write(file, text, null);
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
    }

    @Override
    public void model(Map<String, Object> report) {
        List<ModelProblem> problems = new ArrayList<>();
        for (Object problem : Json.array(report.get("problems"))) {
            problems.add(ModelProblem.fromJson(problem));
        }
        ProblemMarkers.update(file, problems);
        List<DevmOutlinePage.Node> nodes = DevmOutlinePage.Node.fromJson(report.get("outline"));
        runInUi(() -> {
            outline = nodes;
            if (outlinePage != null) {
                outlinePage.setNodes(nodes);
            }
            pageStarted();
        });
    }

    @Override
    public void settings(String json) {
        Preferences.store().setValue(Preferences.PAGE_SETTINGS, json);
    }

    /** Editor of files without an internal default editor (headers without CDT). */
    private static final String TEXT_EDITOR_ID = "org.eclipse.ui.DefaultTextEditor";

    @Override
    public boolean open(String path, Position position, String location) {
        IFile target = ProjectFiles.resolve(file.getProject(), path);
        if (target == null || !target.exists()) {
            return false;
        }
        AtomicReference<Boolean> opened = new AtomicReference<>(false);
        display.syncExec(() -> {
            try {
                opened.set(openEditor(getSite().getPage(), target, position, location) != null);
            } catch (PartInitException e) {
                Activator.getDefault().getLog().log(e.getStatus());
            }
        });
        return opened.get();
    }

    /**
     * Opens a file of the workspace in its default editor (the Device Modeler editor for models, the CDT C/C++ editor for
     * headers if it is installed, otherwise the text editor; never an external program) and selects the
     * position (1-based lines and columns, null: none).
     */
    public static IEditorPart openEditor(IWorkbenchPage page, IFile target, Position position) throws PartInitException {
        return openEditor(page, target, position, null);
    }

    /**
     * {@link #openEditor(IWorkbenchPage, IFile, Position)} for a navigation of the diagram: the page of a Device
     * Modeler editor also shows the {@code location} (JSON of {@code api/open}, null: none), i.e. the structure,
     * the selected element and the breadcrumb context.
     */
    public static IEditorPart openEditor(IWorkbenchPage page, IFile target, Position position, String location) throws PartInitException {
        IEditorDescriptor descriptor = IDE.getDefaultEditor(target);
        String id = descriptor != null && descriptor.isInternal() ? descriptor.getId() : TEXT_EDITOR_ID;
        IEditorPart part = IDE.openEditor(page, target, id, true);
        if (location != null && !location.isBlank() && part instanceof DevmDiagramEditor editor) {
            editor.runInPage("window.devmApp.revealLocation(" + Json.quote(location) + ");");
        }
        if (position == null || part == null) {
            return part;
        }
        if (part instanceof DevmDiagramEditor editor) {
            editor.runInPage("window.devmApp.revealPosition(" + position.line() + "," + position.column() + ","
                    + position.endLine() + "," + position.endColumn() + ");");
        } else if (part.getAdapter(ITextEditor.class) != null) {
            ITextEditor text = part.getAdapter(ITextEditor.class);
            IDocument document = text.getDocumentProvider().getDocument(text.getEditorInput());
            if (document != null) {
                int start = offsetOf(document, position.line(), position.column());
                int end = Math.max(start, offsetOf(document, position.endLine(), position.endColumn()));
                text.selectAndReveal(start, end - start);
            }
        }
        return part;
    }

    /** The offset of a 1-based line and column (clamped to the document). */
    static int offsetOf(IDocument document, int line, int column) {
        try {
            int index = Math.min(Math.max(line - 1, 0), document.getNumberOfLines() - 1);
            IRegion region = document.getLineInformation(index);
            return region.getOffset() + Math.min(Math.max(column - 1, 0), region.getLength());
        } catch (BadLocationException e) {
            return 0;
        }
    }

    @Override
    public String export(String fileName, byte[] content) throws IOException {
        String name = new org.eclipse.core.runtime.Path(fileName).lastSegment();
        if (name == null || name.isBlank() || name.startsWith(".")) {
            throw new IOException("Invalid file name " + fileName);
        }
        IFile target = file.getParent().getFile(new org.eclipse.core.runtime.Path(name));
        try {
            ProjectFiles.write(target, content, null);
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
        return "Exported " + target.getFullPath() + ".";
    }

    @Override
    public String generated(Map<String, Object> result) throws IOException {
        IProject project = file.getProject();
        List<Object> files = Json.array(result.get("files"));
        for (Object message : Json.array(result.get("messages"))) {
            Activator.getDefault().getLog().log(new Status(String.valueOf(message).startsWith("error") ? IStatus.ERROR : IStatus.WARNING,
                    Activator.PLUGIN_ID, file.getName() + ": C++ generation: " + message));
        }
        int written = 0;
        String folder = null;
        for (Object item : files) {
            Map<String, Object> generatedFile = Json.object(item);
            String path = Json.string(generatedFile.get("path"), "");
            IFile target = ProjectFiles.resolve(project, path);
            if (target == null) {
                throw new IOException("The generated file " + path + " is outside of the project");
            }
            try {
                if (ProjectFiles.write(target, Json.string(generatedFile.get("content"), "").getBytes(java.nio.charset.StandardCharsets.UTF_8), null)) {
                    written++;
                }
            } catch (CoreException e) {
                throw new IOException(e.getMessage(), e);
            }
            folder = target.getParent().getFullPath().toString();
        }
        String message = files.isEmpty() ? "C++ generation of " + file.getName() + " failed (see the Error Log)."
                : written == 0 ? "C++ code is up to date (" + files.size() + " files in " + folder + ")."
                : "Generated " + written + " of " + files.size() + " files in " + folder + ".";
        boolean failed = files.isEmpty();
        runInUi(() -> {
            // also in Eclipse's status line (the message of the page disappears after a while)
            var statusLine = getEditorSite().getActionBars().getStatusLineManager();
            statusLine.setErrorMessage(failed ? message : null);
            statusLine.setMessage(failed ? null : message);
        });
        return message;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Changes of the workspace

    private void resourceChanged(IResourceChangeEvent event) {
        IResourceDelta delta = event.getDelta();
        IFile current = file;
        if (delta == null) {
            return;
        }
        IResourceDelta fileDelta = delta.findMember(current.getFullPath());
        if (fileDelta != null && fileDelta.getKind() == IResourceDelta.REMOVED) {
            if ((fileDelta.getFlags() & IResourceDelta.MOVED_TO) != 0) {
                IFile moved = ResourcesPlugin.getWorkspace().getRoot().getFile(fileDelta.getMovedToPath());
                runInUi(() -> moved(current, moved));
            } else {
                runInUi(() -> getSite().getPage().closeEditor(this, false));
            }
            return;
        }
        if (fileDelta != null && (fileDelta.getFlags() & (IResourceDelta.CONTENT | IResourceDelta.REPLACED)) != 0) {
            String text;
            try {
                text = ProjectFiles.read(current);
            } catch (CoreException | IOException e) {
                return;
            }
            if (!text.equals(savedText)) {
                runInUi(() -> externalChange(text));
            }
            return;
        }
        // other models, headers or generator configurations of the project: the imports may have changed
        IResourceDelta projectDelta = delta.findMember(current.getProject().getFullPath());
        if (projectDelta != null && containsRelevantChange(projectDelta)) {
            runInUi(() -> reloadPage(false));
        }
    }

    /** The file was moved or renamed: the editor follows it. */
    private void moved(IFile from, IFile to) {
        if (!from.equals(file)) {
            return;
        }
        ProblemMarkers.forget(from);
        setFile(to, new FileEditorInput(to));
        reloadPage(false);
    }

    private static boolean containsRelevantChange(IResourceDelta delta) {
        if (delta.getResource() instanceof IFile changed && (ProjectFiles.IMPORTABLE.matcher(changed.getName()).matches()
                || ProjectFiles.GENERATOR_CONFIG.matcher(changed.getName()).matches())
                && (delta.getKind() != IResourceDelta.CHANGED || (delta.getFlags() & (IResourceDelta.CONTENT | IResourceDelta.REPLACED)) != 0)) {
            return true;
        }
        for (IResourceDelta child : delta.getAffectedChildren()) {
            if (containsRelevantChange(child)) {
                return true;
            }
        }
        return false;
    }

    /** The file was changed by someone else (another editor, git, …). */
    private void externalChange(String text) {
        if (dirty && !MessageDialog.openQuestion(getSite().getShell(), "File changed",
                file.getName() + " was changed on disk. Replace the unsaved changes of the editor with the file?")) {
            // the editor keeps its text; saving it overwrites the file
            savedText = text;
            return;
        }
        savedText = text;
        currentText = text;
        setDirty(false);
        reloadPage(true);
    }

    private void reloadPage(boolean replaceText) {
        runInPage("window.devmApp.reloadFromHost(" + replaceText + ");");
    }

    // ---------------------------------------------------------------------------------------------------------

    private void runInUi(Runnable runnable) {
        Display current = display != null ? display : Display.getDefault();
        if (current.isDisposed()) {
            return;
        }
        if (Display.getCurrent() == current) {
            if (browser == null || !browser.isDisposed()) {
                runnable.run();
            }
            return;
        }
        current.asyncExec(() -> {
            if (browser == null || !browser.isDisposed()) {
                runnable.run();
            }
        });
    }
}
