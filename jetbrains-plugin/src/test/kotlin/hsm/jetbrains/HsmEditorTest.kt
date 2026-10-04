package hsm.jetbrains

import com.google.gson.JsonParser
import com.intellij.analysis.problemsView.ProblemsCollector
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.ide.structureView.StructureViewTreeElement
import com.intellij.ide.structureView.TreeBasedStructureViewBuilder
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.fileEditor.ex.FileEditorProviderManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import hsm.jetbrains.editor.HsmDiagramEditor
import hsm.jetbrains.editor.HsmEditorProvider
import hsm.jetbrains.editor.HsmSplitEditor
import hsm.jetbrains.lang.HsmFileType
import hsm.jetbrains.lang.HsmLexer
import hsm.jetbrains.lang.HsmTestFileType
import hsm.jetbrains.lang.HsmTokens
import hsm.jetbrains.model.ProblemSource
import hsm.jetbrains.problems.HsmProblems
import hsm.jetbrains.server.OpenPosition
import hsm.jetbrains.settings.HsmSettings

/**
 * The plugin in a light (headless) IDE: file types, the editor provider, the host session on the IntelliJ
 * document (what the page does over HTTP), problems in the text editor and the Problems tool window, the
 * structure view. JCEF is not available in headless tests: the diagram editor shows its fallback, the page
 * itself is not tested here (see the README of the plugin).
 */
class HsmEditorTest : BasePlatformTestCase() {

    private val model = """
        import "motor.hsm"
        statemachine Door {
            state Closed {}
        }
    """.trimIndent()

    private var validateOnSave = true

    override fun setUp() {
        super.setUp()
        // no hsm executable in the tests (the command line tool is tested in ModelTest)
        validateOnSave = HsmSettings.get().state.validateOnSave
        HsmSettings.get().state.validateOnSave = false
    }

    override fun tearDown() {
        try {
            HsmSettings.get().state.validateOnSave = validateOnSave
        } finally {
            super.tearDown()
        }
    }

    private fun openEditor(): HsmSplitEditor {
        myFixture.addFileToProject("models/motor.hsm", "statemachine Motor {}")
        myFixture.addFileToProject("include/types.h", "typedef int speed_t;")
        myFixture.addFileToProject("hsm.gen.json", """{"headers":{"include":["include"]}}""")
        myFixture.addFileToProject("models/notes.txt", "not importable")
        val file = myFixture.addFileToProject("models/door.hsm", model).virtualFile
        // the FileEditorManager of light tests only creates text editors: the provider directly
        val editor = HsmEditorProvider().createEditor(project, file) as HsmSplitEditor
        Disposer.register(testRootDisposable, editor)
        // the UI of TextEditorWithPreview is created lazily (as when the editor is shown)
        editor.component
        return editor
    }

    fun testFileTypes() {
        assertSame(HsmFileType, FileTypeManager.getInstance().getFileTypeByExtension("hsm"))
        assertSame(HsmTestFileType, FileTypeManager.getInstance().getFileTypeByExtension("hsmtest"))
    }

    fun testEditorProvider() {
        val file = myFixture.addFileToProject("door.hsm", model).virtualFile
        val providers = FileEditorProviderManager.getInstance().getProviderList(project, file)
        assertTrue(providers.any { it is HsmEditorProvider })
        val editor = openEditor()
        // headless: no JCEF → the text editor, and the diagram tab explains why
        assertFalse(editor.diagram.hasPage)
        assertNotNull(editor.diagram.unavailableReason)
        assertEquals(TextEditorWithPreview.Layout.SHOW_EDITOR, editor.getLayout())
        assertEquals("statemachine Door", editor.editor.document.text.lines()[1].substringBefore(" {"))
    }

    fun testDocumentOfTheSession() {
        val editor = openEditor()
        val session = editor.diagram.session
        val document = session.document()
        assertEquals("door.hsm", document["fileName"])
        assertEquals("models/door.hsm", document["path"])
        assertEquals(model, document["text"])
        @Suppress("UNCHECKED_CAST")
        val files = document["files"] as Map<String, String>
        assertEquals(setOf("models/motor.hsm", "include/types.h"), files.keys)
        @Suppress("UNCHECKED_CAST")
        val configs = document["configs"] as List<Map<String, String>>
        assertEquals("hsm.gen.json", configs.single()["path"])
        assertTrue(document["theme"] == "light" || document["theme"] == "dark")

        assertEquals("typedef int speed_t;", session.file("include/types.h"))
        assertNull(session.file("../outside.hsm"))
        assertNull(session.file("models/missing.hsm"))
        assertTrue(session.open("models/motor.hsm", null))
        assertFalse(session.open("../motor.hsm", null))
    }

    /** Go to definition in the page into a header (api/open with a position): the header opens with the range selected. */
    fun testOpenAtPosition() {
        val session = openEditor().diagram.session
        myFixture.addFileToProject("include/modes.h", "#pragma once\nnamespace t {\nenum class Mode { Off, On };\n}\n")
        assertTrue(session.open("include/modes.h", OpenPosition(3, 12, 3, 16)))
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        assertNotNull(editor)
        assertEquals("modes.h", FileDocumentManager.getInstance().getFile(editor!!.document)?.name)
        assertEquals("Mode", editor.selectionModel.selectedText)
        assertEquals(2, editor.document.getLineNumber(editor.caretModel.offset))
        assertFalse(session.open("include/missing.h", OpenPosition(1, 1, 1, 1)))
    }

    fun testChangesOfThePageGoToTheDocument() {
        val editor = openEditor()
        val session = editor.diagram.session
        val document = editor.editor.document
        session.document()
        session.changed(model.replace("Closed", "Open"))
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(model.replace("Closed", "Open"), document.text)
        assertTrue(FileDocumentManager.getInstance().isDocumentUnsaved(document))

        session.save(model.replace("Closed", "Locked"))
        assertEquals(model.replace("Closed", "Locked"), document.text)
        assertFalse(FileDocumentManager.getInstance().isDocumentUnsaved(document))
        assertEquals(model.replace("Closed", "Locked"), VfsUtilCore.loadText(editor.file!!))
    }

    fun testChangesOfTheDocumentGoToThePage() {
        val editor = openEditor()
        val session = editor.diagram.session
        val document = editor.editor.document
        session.document()
        // the text editor changes the document: the page loads it and reports it back (no change of the page)
        WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "// a\n") }
        session.pushToPage()
        val pushed = session.document()["text"] as String
        assertEquals(document.text, pushed)
        WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "// b\n") }
        // the late echo of the pushed text must not undo the newer change of the document
        session.changed(pushed)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertTrue(document.text.startsWith("// b\n// a\n"))
        // a real change of the page afterwards is applied
        session.changed("statemachine X {}")
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals("statemachine X {}", document.text)
    }

    fun testProblemsOfThePage() {
        val editor = openEditor()
        val session = editor.diagram.session
        val file = editor.file!!
        val offset = model.indexOf("Closed")
        session.model(JsonParser.parseString("""
            {"textLength":${model.length},"problems":[
              {"severity":"error","message":"State Closed is not reachable","line":3,"column":11,"offset":$offset,"end":${offset + 6}}],
             "outline":[{"label":"Door","kind":"statemachine","offset":0,"end":${model.length},
               "children":[{"label":"Closed","kind":"state","offset":$offset,"end":${offset + 9}}]}]}
        """).asJsonObject)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()

        val stored = HsmProblems.get(project).get(file)!!
        assertEquals(ProblemSource.PAGE, stored.source)
        assertEquals(1, ProblemsCollector.getInstance(project).getFileProblemCount(file))

        // the text editor shows the problem of the page at its range
        myFixture.openFileInEditor(file)
        val errors = myFixture.doHighlighting(HighlightSeverity.ERROR)
        val error: HighlightInfo = errors.single { it.description == "State Closed is not reachable" }
        assertEquals(offset, error.startOffset)
        assertEquals(offset + 6, error.endOffset)

        // the structure view shows the outline of the page
        val builder = editor.structureViewBuilder as TreeBasedStructureViewBuilder
        val structure = builder.createStructureViewModel(null)
        try {
            val root = structure.root.children.single() as StructureViewTreeElement
            assertEquals("Door", root.presentation.presentableText)
            assertEquals("Closed", (root.children.single() as StructureViewTreeElement).presentation.presentableText)
        } finally {
            Disposer.dispose(structure)
        }

        // no problems any more
        session.model(JsonParser.parseString("""{"textLength":${model.length},"problems":[],"outline":[]}""").asJsonObject)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(0, ProblemsCollector.getInstance(project).getFileProblemCount(file))
    }

    fun testGeneratedAndExportedFiles() {
        val editor = openEditor()
        val session = editor.diagram.session
        val message = session.generated(JsonParser.parseString("""
            {"files":[{"path":"models/gen/Door.h","content":"// header"},{"path":"models/gen/Door.cpp","content":"// source"}],"messages":[]}
        """).asJsonObject)
        assertEquals("Generated 2 of 2 files in models/gen.", message)
        val root = editor.file!!.parent.parent
        assertEquals("// header", VfsUtilCore.loadText(root.findFileByRelativePath("models/gen/Door.h")!!))
        // unchanged files are not written again
        assertEquals("C++ code is up to date (1 files in models/gen).",
            session.generated(JsonParser.parseString("""{"files":[{"path":"models/gen/Door.h","content":"// header"}],"messages":[]}""").asJsonObject))
        try {
            session.generated(JsonParser.parseString("""{"files":[{"path":"../evil.h","content":""}],"messages":[]}""").asJsonObject)
            fail("a path outside of the project must be rejected")
        } catch (e: Exception) {
            assertTrue(e.message.orEmpty().contains("outside"))
        }
        assertEquals("Exported models/door.svg.", session.export("door.svg", "<svg/>".toByteArray()))
        assertNotNull(root.findFileByRelativePath("models/door.svg"))
        try {
            session.export("../door.svg", ByteArray(0))
        } catch (e: Exception) {
            fail("the name of the file is used without its folder: ${e.message}")
        }
        try {
            session.export(".hidden", ByteArray(0))
            fail("hidden files are rejected")
        } catch (e: Exception) {
            // expected
        }
    }

    fun testSettings() {
        val settings = HsmSettings.get()
        val previous = settings.state.cppModelNamespace
        try {
            settings.state.cppModelNamespace = false
            settings.state.cppNamespace = "app::control"
            assertEquals("app::control", settings.cppSettings()["namespace"])
            settings.state.cppModelNamespace = true
            assertNull(settings.cppSettings()["namespace"])
            assertEquals("17", settings.cppSettings()["standard"])
        } finally {
            settings.state.cppModelNamespace = previous
        }
        val editor = openEditor()
        editor.diagram.session.settings("""{"direction":"RIGHT"}""")
        assertEquals("""{"direction":"RIGHT"}""", editor.diagram.session.document()["settings"])
        editor.diagram.session.settings("")
    }

    fun testLexer() {
        val lexer = HsmLexer(HsmTokens.HSM)
        lexer.start("state A /* c */ { x = 0x1F; s = \"a\\\"b\" } // end\n@CycleBased(1.5e3)")
        val tokens = ArrayList<Pair<String, String>>()
        while (lexer.tokenType != null) {
            if (lexer.tokenType.toString() != "WHITE_SPACE") {
                tokens.add(lexer.tokenType.toString() to lexer.tokenText)
            }
            lexer.advance()
        }
        assertEquals(listOf(
            "KEYWORD" to "state", "IDENTIFIER" to "A", "BLOCK_COMMENT" to "/* c */", "{" to "{", "IDENTIFIER" to "x",
            "OPERATOR" to "=", "NUMBER" to "0x1F", "OPERATOR" to ";", "IDENTIFIER" to "s", "OPERATOR" to "=",
            "STRING" to "\"a\\\"b\"", "}" to "}", "LINE_COMMENT" to "// end", "ANNOTATION" to "@CycleBased", "(" to "(",
            "NUMBER" to "1.5e3", ")" to ")",
        ), tokens)
    }

    fun testDiagramEditorRegistry() {
        val editor = openEditor()
        // no page in headless tests: the annotator and the validation use the command line tool for the saved file
        assertFalse(HsmDiagramEditor.hasOpenPage(editor.file!!))
    }
}
