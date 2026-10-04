package devm.jetbrains.editor

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.keymap.KeymapUtil
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCopyEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.ui.JBUI
import devm.jetbrains.model.OutlineNode
import devm.jetbrains.model.ProjectPaths
import devm.jetbrains.server.DevmWebServer
import java.awt.BorderLayout
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.beans.PropertyChangeListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The diagram editor of a `.devm` file: the Device Modeler web app (Monaco text editor, diagram, properties, simulation,
 * export, C++ generation) in a JCEF browser, served by the [DevmWebServer] of the plugin (protocol:
 * packages/web/src/host.ts). It is the preview part of [DevmSplitEditor] (tabs *Text* / *Text and Diagram* /
 * *Diagram*); page and text editor edit the same document ([DevmSession]).
 *
 * - problems of the page → Problems tool window and text editor ([devm.jetbrains.problems.DevmProblems])
 * - outline of the page → Structure tool window ([DevmStructureViewModel])
 * - the IDE's undo, redo, cut, copy, paste, select all, find, replace and save shortcuts act on the page while
 *   it has the focus (`devmApp.hostCommand`)
 * - changes of other models, headers and generator configurations of the project are loaded into the page;
 *   renames and moves of the file are followed
 * - the page follows the IDE theme (dark / light)
 */
class DevmDiagramEditor(val project: Project, private val file: VirtualFile) : UserDataHolderBase(), FileEditor, DevmSession.Page {

    private val log = logger<DevmDiagramEditor>()

    val session = DevmSession(project, file, this)

    private val browser: JBCefBrowser?
    private val query: JBCefJSQuery?
    private val component: JComponent

    /** Why there is no page (no JCEF, no web app), `null` if there is one. */
    val unavailableReason: String?

    /** The page has started (it reported its model); scripts wait in [pendingScripts] until then (EDT). */
    private var pageReady = false
    private val pendingScripts = ArrayList<String>()
    private val callbacks = ConcurrentHashMap<Int, (JsonElement?) -> Unit>()
    private val nextCallback = AtomicInteger()

    /** The outline of the page (EDT) and its listeners (structure views). */
    var outline: List<OutlineNode> = emptyList()
        private set
    private val outlineListeners = CopyOnWriteArrayList<() -> Unit>()

    @Volatile
    private var disposed = false

    private val pushAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val reloadAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    init {
        var createdBrowser: JBCefBrowser? = null
        var createdQuery: JBCefJSQuery? = null
        var reason: String? = null
        if (!JBCefApp.isSupported()) {
            reason = "The diagram needs JCEF (the embedded Chromium of the IDE), which is not available in this IDE or runtime."
        } else {
            try {
                val server = DevmWebServer.get().server()
                createdBrowser = JBCefBrowser.createBuilder().setEnableOpenDevToolsMenuItem(true).build()
                Disposer.register(this, createdBrowser)
                // before the page is loaded: the function of the query is part of every page
                createdQuery = JBCefJSQuery.create(createdBrowser as JBCefBrowserBase)
                Disposer.register(this, createdQuery)
                createdQuery.addHandler { result ->
                    handleCallback(result)
                    null
                }
                createdBrowser.loadURL(server.register(session))
            } catch (e: Exception) {
                log.warn("The Device Modeler diagram editor cannot be shown", e)
                reason = "The diagram cannot be shown: ${e.message}"
                createdBrowser?.let { Disposer.dispose(it) }
                createdBrowser = null
                createdQuery = null
            }
        }
        browser = createdBrowser
        query = createdQuery
        unavailableReason = reason
        component = browser?.component ?: fallback(reason ?: "")
        browser?.let {
            registerPageActions(it.component)
            openPages.add(this)
        }

        session.document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (!session.applyingPageText) {
                    pushAlarm.cancelAllRequests()
                    pushAlarm.addRequest({ session.pushToPage() }, 250)
                }
            }
        }, this)
        val connection = ApplicationManager.getApplication().messageBus.connect(this)
        connection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) = filesChanged(events)
        })
        connection.subscribe(LafManagerListener.TOPIC, LafManagerListener { themeChanged() })
    }

    private fun fallback(reason: String): JComponent = JPanel(BorderLayout()).apply {
        border = JBUI.Borders.empty(16)
        add(JBLabel("<html>$reason<br><br>Use the <b>Text</b> view of the editor (toolbar at the top right) to edit the model; " +
            "problems of saved models come from the devm command line tool (Settings &gt; Tools &gt; Device Modeler).</html>")
            .apply { verticalAlignment = SwingConstants.TOP }, BorderLayout.CENTER)
    }

    /** True if the page is shown (JCEF available). */
    val hasPage: Boolean get() = browser != null

    // ---------------------------------------------------------------------------------------------------------
    // The page

    override fun runInPage(script: String) {
        ApplicationManager.getApplication().invokeLater({
            val cef = browser ?: return@invokeLater
            if (pageReady) {
                cef.cefBrowser.executeJavaScript(script, cef.cefBrowser.url, 0)
            } else {
                pendingScripts.add(script)
            }
        }, ModalityState.any(), { disposed })
    }

    override fun modelReported(outline: List<OutlineNode>) {
        ApplicationManager.getApplication().invokeLater({
            if (outline != this.outline) {
                this.outline = outline
                outlineListeners.forEach { it() }
            }
            if (!pageReady) {
                log.info("The Device Modeler page of ${file.path} has started")
                pageReady = true
                val scripts = ArrayList(pendingScripts)
                pendingScripts.clear()
                scripts.forEach { runInPage(it) }
            }
        }, ModalityState.any(), { disposed })
    }

    /** Calls a JavaScript expression in the page; its value (JSON) goes to the callback (EDT). */
    fun callPage(expression: String, callback: (JsonElement?) -> Unit) {
        val query = query ?: return
        val id = nextCallback.incrementAndGet()
        callbacks[id] = callback
        val result = "JSON.stringify({id:$id,value:(r===undefined?null:r)})"
        runInPage("(function(){var r=null;try{r=($expression);}catch(e){r=null;}${query.inject(result)}})();")
    }

    private fun handleCallback(json: String) {
        try {
            val result = JsonParser.parseString(json).asJsonObject
            val callback = callbacks.remove(result.get("id").asInt) ?: return
            val value = result.get("value")?.takeIf { !it.isJsonNull }
            ApplicationManager.getApplication().invokeLater({ callback(value) }, ModalityState.any())
        } catch (e: Exception) {
            log.warn("Unexpected answer of the page: $json", e)
        }
    }

    fun addOutlineListener(listener: () -> Unit) {
        outlineListeners.add(listener)
    }

    fun removeOutlineListener(listener: () -> Unit) {
        outlineListeners.remove(listener)
    }

    /** Selects a range of the text in the page (and the diagram element there). */
    fun reveal(offset: Int, end: Int) {
        runInPage("window.devmApp.revealRange($offset,$end);")
    }

    /** Generates the C++ code of the model in the page; the session writes the files. */
    fun generateCpp() {
        runInPage("window.devmApp.generateCpp();")
    }

    private fun themeChanged() {
        val theme = if (DevmSession.isDarkTheme()) "dark" else "light"
        runInPage("if(window.devmApp.setHostTheme){window.devmApp.setHostTheme('$theme');}")
    }

    /**
     * The IDE's edit shortcuts while the page has the focus: applied in the page (`devmApp.hostCommand`) –
     * on its text editor, an input field of the properties or the diagram. Copy and cut put the text into the
     * IDE clipboard, paste inserts it. Save takes the text of the page first.
     */
    private fun registerPageActions(target: JComponent) {
        val commands = mapOf(
            IdeActions.ACTION_UNDO to "undo",
            IdeActions.ACTION_REDO to "redo",
            IdeActions.ACTION_CUT to "cut",
            IdeActions.ACTION_COPY to "copy",
            IdeActions.ACTION_PASTE to "paste",
            IdeActions.ACTION_SELECT_ALL to "selectAll",
            IdeActions.ACTION_FIND to "find",
            IdeActions.ACTION_REPLACE to "replace",
        )
        for ((actionId, command) in commands) {
            pageAction { pageCommand(command) }.registerCustomShortcutSet(KeymapUtil.getActiveKeymapShortcuts(actionId), target, this)
        }
        pageAction { saveFromPage() }.registerCustomShortcutSet(KeymapUtil.getActiveKeymapShortcuts("SaveAll"), target, this)
    }

    private fun pageAction(perform: () -> Unit) = object : DumbAwareAction() {
        override fun actionPerformed(e: AnActionEvent) = perform()
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
    }

    /** Runs an edit command in the page; copy and cut put the text into the clipboard. */
    fun pageCommand(command: String) {
        val argument = if (command == "paste") {
            CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor) ?: return
        } else null
        val gson = Gson()
        val call = "window.devmApp && window.devmApp.diagram ? window.devmApp.hostCommand(${gson.toJson(command)}" +
            (argument?.let { "," + gson.toJson(it) } ?: "") + ") : false"
        callPage(call) { value ->
            if ((command == "copy" || command == "cut") && value != null && value.isJsonPrimitive && value.asJsonPrimitive.isString) {
                val text = value.asString
                if (text.isNotEmpty()) {
                    CopyPasteManager.getInstance().setContents(StringSelection(text))
                }
            }
        }
    }

    /** Save (shortcut while the page has the focus): the latest text of the page, then all documents. */
    private fun saveFromPage() {
        if (!pageReady) {
            FileDocumentManager.getInstance().saveAllDocuments()
            return
        }
        callPage("window.devmApp && window.devmApp.diagram ? window.devmApp.getText() : null") { value ->
            if (value != null && value.isJsonPrimitive) {
                session.applyToDocument(value.asString)
            }
            FileDocumentManager.getInstance().saveAllDocuments()
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Changes of files

    private fun filesChanged(events: List<VFileEvent>) {
        if (!file.isValid || browser == null) {
            return
        }
        val root = ProjectFiles.root(project, file)
        var reload = false
        for (event in events) {
            val changed = event.file
            if (changed == file) {
                // renamed or moved: new path (the imports are resolved from the new location)
                if (event is VFileMoveEvent || (event is VFilePropertyChangeEvent && event.propertyName == VirtualFile.PROP_NAME)) {
                    reload = true
                }
                continue
            }
            val name = when (event) {
                is VFilePropertyChangeEvent -> if (event.propertyName == VirtualFile.PROP_NAME) event.newValue.toString() else continue
                is VFileCreateEvent -> event.childName
                is VFileCopyEvent -> event.newChildName
                else -> changed?.name ?: continue
            }
            val oldName = (event as? VFilePropertyChangeEvent)?.oldValue?.toString()
            if (!(ProjectPaths.isImportable(name) || ProjectPaths.isGeneratorConfig(name)
                    || (oldName != null && (ProjectPaths.isImportable(oldName) || ProjectPaths.isGeneratorConfig(oldName))))) {
                continue
            }
            val parent = when (event) {
                is VFileCreateEvent -> event.parent
                is VFileCopyEvent -> event.newParent
                is VFileMoveEvent -> event.newParent
                else -> changed?.parent
            }
            val relevant = event is VFileContentChangeEvent || event is VFileCreateEvent || event is VFileCopyEvent
                || event is VFileDeleteEvent || event is VFileMoveEvent || event is VFilePropertyChangeEvent
            if (relevant && (parent == null || VfsUtilCore.isAncestor(root, parent, false)
                    || (event is VFileMoveEvent && VfsUtilCore.isAncestor(root, event.oldParent, false)))) {
                reload = true
            }
        }
        if (reload) {
            reloadAlarm.cancelAllRequests()
            reloadAlarm.addRequest({ runInPage("window.devmApp.reloadFromHost(false);") }, 300)
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // FileEditor

    override fun getComponent(): JComponent = component
    override fun getPreferredFocusedComponent(): JComponent = component
    override fun getName(): String = "Diagram"
    override fun getFile(): VirtualFile = file
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = FileDocumentManager.getInstance().isFileModified(file)
    override fun isValid(): Boolean = file.isValid
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun dispose() {
        disposed = true
        openPages.remove(this)
        if (browser != null) {
            DevmWebServer.get().server().unregister(session)
        }
        outlineListeners.clear()
        callbacks.clear()
    }

    companion object {
        private val openPages = java.util.concurrent.ConcurrentHashMap.newKeySet<DevmDiagramEditor>()

        /** True if a diagram editor with a page is open for the file (the page reports its problems). */
        fun hasOpenPage(file: VirtualFile): Boolean = openPages.any { it.file == file }
    }
}
