package devm.jetbrains.editor

import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.ThrowableComputable
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import devm.jetbrains.readAction
import devm.jetbrains.DevmNotifications
import devm.jetbrains.model.ModelReport
import devm.jetbrains.model.OutlineNode
import devm.jetbrains.model.ProblemSource
import devm.jetbrains.model.ProjectPaths
import devm.jetbrains.problems.DevmProblems
import devm.jetbrains.server.HostServer.HostException
import devm.jetbrains.server.HostSession
import devm.jetbrains.server.OpenPosition
import devm.jetbrains.settings.DevmSettings
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * The host side of the page of one diagram editor (protocol: packages/web/src/host.ts). The page edits the
 * IntelliJ [Document] of the file: its changes are applied to the document (undoable commands, so the text
 * editor, undo, autosave, local history and VCS see them), changes of the document from elsewhere (text editor,
 * external changes, VCS) are sent to the page. The project directory is the root of the paths of the page.
 *
 * The methods of [HostSession] are called on the threads of the web server.
 */
class DevmSession(val project: Project, val file: VirtualFile, private val page: Page) : HostSession {

    /** What the session needs from its editor. */
    interface Page {
        /** Runs a script in the page once it has started (any thread). */
        fun runInPage(script: String)

        /** The page reported its first model: it has started. New outline of the model. */
        fun modelReported(outline: List<OutlineNode>)
    }

    private val log = logger<DevmSession>()

    val document: Document = readAction {
        FileDocumentManager.getInstance().getDocument(file) ?: throw IllegalStateException("No document for $file")
    }

    /** The text the page has (as far as known). */
    @Volatile
    var pageText: String? = null
        private set

    /** The page is asked to load the text of the document ([pushToPage]); the next [document] call answers it. */
    @Volatile
    private var pushPending = false

    /** The text the page will report as a change after it loaded the text of the document (not a change of the page). */
    @Volatile
    private var expectedEcho: String? = null

    /** The last report of the page. */
    @Volatile
    var report: ModelReport? = null
        private set

    /** True while the text of the page is applied to the document (EDT). */
    var applyingPageText = false
        private set

    // ---------------------------------------------------------------------------------------------------------
    // HostSession

    override fun document(): Map<String, Any?> {
        val root = ProjectFiles.root(project, file)
        val text = readAction { document.text }
        if (pushPending) {
            pushPending = false
            if (text != pageText) {
                // the page replaces its text with this one and reports it as a change
                expectedEcho = text
            }
            pageText = text
        } else if (pageText == null) {
            pageText = text
        }
        val result = linkedMapOf<String, Any?>(
            "fileName" to file.name,
            "path" to (ProjectFiles.path(root, file) ?: file.name),
            "text" to text,
            "files" to ProjectFiles.importableFiles(project, root, file),
            "configs" to ProjectFiles.generatorConfigs(root, file),
            "cppSettings" to DevmSettings.get().cppSettings(),
        )
        DevmSettings.get().state.pageSettings?.takeIf { it.isNotBlank() }?.let { result["settings"] = it }
        result["theme"] = if (isDarkTheme()) "dark" else "light"
        return result
    }

    override fun file(path: String): String? {
        val target = ProjectFiles.resolve(ProjectFiles.root(project, file), path) ?: return null
        if (target.isDirectory) {
            return null
        }
        return ProjectFiles.text(target)
    }

    override fun changed(text: String) {
        if (text == expectedEcho) {
            // the page loaded the text of the document: no change of the page
            expectedEcho = null
            pageText = text
            return
        }
        expectedEcho = null
        pageText = text
        ApplicationManager.getApplication().invokeLater({ applyToDocument(text) }, ModalityState.defaultModalityState(), project.disposed)
    }

    override fun save(text: String) {
        pageText = text
        expectedEcho = null
        var error: Exception? = null
        ApplicationManager.getApplication().invokeAndWait({
            try {
                applyToDocument(text)
                FileDocumentManager.getInstance().saveDocument(document)
            } catch (e: Exception) {
                error = e
            }
        }, ModalityState.defaultModalityState())
        error?.let { throw IOException("Cannot save ${file.name}: ${it.message}", it) }
    }

    override fun model(report: JsonObject) {
        val parsed = ModelReport.fromJson(report)
        this.report = parsed
        DevmProblems.get(project).update(file, DevmProblems.FileProblems(ProblemSource.PAGE, parsed.problems, parsed.textLength, -1))
        page.modelReported(parsed.outline)
    }

    override fun settings(json: String) {
        DevmSettings.get().state.pageSettings = json
    }

    override fun open(path: String, position: OpenPosition?, location: String?): Boolean {
        val target = ProjectFiles.resolve(ProjectFiles.root(project, file), path)?.takeIf { !it.isDirectory } ?: return false
        ApplicationManager.getApplication().invokeLater({ openAt(project, target, position, location) }, project.disposed)
        return true
    }

    override fun export(fileName: String, content: ByteArray): String {
        val name = fileName.replace('\\', '/').substringAfterLast('/')
        if (!ProjectPaths.isValidFileName(name)) {
            throw HostException(400, "Invalid file name $fileName")
        }
        val root = ProjectFiles.root(project, file)
        val folder = file.parent?.let { ProjectFiles.path(root, it) }
        val path = if (folder.isNullOrEmpty()) name else "$folder/$name"
        writeFiles(root, listOf(path to content))
        return "Exported $path."
    }

    override fun generated(result: JsonObject): String {
        val files = result.getAsJsonArray("files")?.map { it.asJsonObject }.orEmpty()
        val messages = result.getAsJsonArray("messages")?.map { it.asString }.orEmpty()
        for (message in messages) {
            log.warn("${file.name}: C++ generation: $message")
        }
        val root = ProjectFiles.root(project, file)
        val contents = files.map { (it.get("path")?.asString ?: "") to (it.get("content")?.asString ?: "").toByteArray(StandardCharsets.UTF_8) }
        for ((path, _) in contents) {
            if (ProjectPaths.segments(path) == null) {
                throw HostException(400, "The generated file $path is outside of the project")
            }
        }
        val written = writeFiles(root, contents)
        val folder = contents.lastOrNull()?.first?.substringBeforeLast('/', "")?.ifEmpty { "." }
        val message = when {
            files.isEmpty() -> "C++ generation of ${file.name} failed: ${messages.joinToString("; ").ifEmpty { "no files" }}"
            written == 0 -> "C++ code is up to date (${files.size} files in $folder)."
            else -> "Generated $written of ${files.size} files in $folder."
        }
        // also in the IDE (the message of the page disappears after a while)
        DevmNotifications.notify(project, message, if (files.isEmpty()) NotificationType.ERROR
            else if (messages.isNotEmpty()) NotificationType.WARNING else NotificationType.INFORMATION)
        return message
    }

    /** Writes files below the root in a write action on the EDT; returns the number of changed files. */
    private fun writeFiles(root: VirtualFile, files: List<Pair<String, ByteArray>>): Int {
        var written = 0
        var error: Exception? = null
        ApplicationManager.getApplication().invokeAndWait({
            try {
                written = WriteAction.compute(ThrowableComputable<Int, IOException> {
                    files.count { (path, content) -> ProjectFiles.write(root, path, content, this) }
                })
            } catch (e: Exception) {
                error = e
            }
        }, ModalityState.defaultModalityState())
        error?.let { throw IOException(it.message, it) }
        return written
    }

    // ---------------------------------------------------------------------------------------------------------
    // Document ↔ page

    /** Applies the text of the page to the document (EDT): an undoable command that changes only the differing part. */
    fun applyToDocument(text: String) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        if (project.isDisposed || !file.isValid) {
            return
        }
        val current = document.immutableCharSequence
        if (current.contentEquals(text)) {
            return
        }
        if (!document.isWritable && !FileDocumentManager.getInstance().requestWriting(document, project)) {
            // read-only file: the page shows the text of the document again
            pushToPage()
            return
        }
        var start = 0
        val max = minOf(current.length, text.length)
        while (start < max && current[start] == text[start]) {
            start++
        }
        var endCurrent = current.length
        var endText = text.length
        while (endCurrent > start && endText > start && current[endCurrent - 1] == text[endText - 1]) {
            endCurrent--
            endText--
        }
        applyingPageText = true
        try {
            WriteCommandAction.writeCommandAction(project).withName("Edit Model").run<RuntimeException> {
                document.replaceString(start, endCurrent, text.substring(start, endText))
            }
        } finally {
            applyingPageText = false
        }
    }

    /** The document was changed outside of the page: the page loads its text (and the files it may import). */
    fun pushToPage() {
        val text = document.text
        if (text == pageText) {
            return
        }
        pushPending = true
        page.runInPage("window.devmApp.reloadFromHost(true);")
    }

    companion object {
        fun isDarkTheme(): Boolean = !JBColor.isBright()
    }
}

/**
 * Opens a file of the project in the editor of its type (a model in the Device Modeler editor, a header in CLion's C/C++
 * editor) and selects the range of [position] (1-based lines and columns; null: only opens the file). The page of a
 * Device Modeler editor also shows [location] (JSON of `api/open`, a navigation of the diagram). EDT.
 */
fun openAt(project: Project, target: VirtualFile, position: OpenPosition?, location: String? = null) {
    val manager = FileEditorManager.getInstance(project)
    openAtPosition(manager, project, target, position)
    // a navigation of the diagram: the page of the opened file shows the structure, the element and the breadcrumb
    if (location != null) {
        (manager.getSelectedEditor(target) as? DevmSplitEditor)?.diagram
            ?.runInPage("window.devmApp.revealLocation(${com.google.gson.JsonPrimitive(location)});")
    }
}

private fun openAtPosition(manager: FileEditorManager, project: Project, target: VirtualFile, position: OpenPosition?) {
    val document = if (position == null) null else FileDocumentManager.getInstance().getDocument(target)
    if (position == null || document == null) {
        manager.openFile(target, true)
        return
    }
    fun offset(line: Int, column: Int): Int {
        if (document.lineCount == 0) return 0
        val index = (line - 1).coerceIn(0, document.lineCount - 1)
        return minOf(document.getLineStartOffset(index) + maxOf(column - 1, 0), document.getLineEndOffset(index))
    }
    val start = offset(position.line, position.column)
    val end = maxOf(start, offset(position.endLine, position.endColumn))
    val editor = manager.openTextEditor(OpenFileDescriptor(project, target, start), true)
    val split = manager.getSelectedEditor(target) as? DevmSplitEditor
    if (split != null) {
        // the text editor and the page
        split.select(start, end)
    } else if (editor != null) {
        editor.selectionModel.setSelection(start, end)
    }
}
