package hsm.jetbrains.lsp

import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.fixtures.TempDirTestFixture
import com.intellij.testFramework.fixtures.impl.TempDirTestFixtureImpl
import com.redhat.devtools.lsp4ij.LanguageServerManager
import com.redhat.devtools.lsp4ij.LanguageServersRegistry
import com.redhat.devtools.lsp4ij.LanguageServiceAccessor
import com.redhat.devtools.lsp4ij.ServerStatus
import hsm.jetbrains.problems.HsmExternalAnnotator
import hsm.jetbrains.settings.HsmSettings
import org.eclipse.lsp4j.DefinitionParams
import org.eclipse.lsp4j.HoverParams
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.TextDocumentIdentifier
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * The language server through LSP4IJ (hsm-lsp4ij.xml) with the hsm executable built by packages/cli
 * (`npm run build:exe`; the tests are skipped without it): LSP4IJ starts `hsm lsp --stdio` for a model opened in
 * the editor (the plugin's own annotator is then silent), hover and definition lead into the header of the include
 * paths of `hsm.gen.json`. (LSP4IJ applies the diagnostics outside the highlighting passes of the light test
 * fixture: they are covered by the integration test of `hsm lsp` in packages/vscode and checked with runIde.)
 */
class HsmLanguageServerTest : BasePlatformTestCase() {

    private val types = "#pragma once\nnamespace io {\n/** Number of steps. */\nconstexpr int kSteps = 4;\n}\n"
    private val gate = "statemachine Gate {\n    import \"types.h\"\n    interface:\n        var steps : integer = io::kSteps\n" +
        "        var bad : integer = unknownName\n    [*] -> Closed\n    state Closed\n}\n"

    private var executable: String? = null

    // real files: the language server reads the header and hsm.gen.json from the disk
    override fun createTempDirTestFixture(): TempDirTestFixture = TempDirTestFixtureImpl()

    override fun setUp() {
        super.setUp()
        executable = HsmSettings.get().state.executable
        builtExecutable()?.let { HsmSettings.get().state.executable = it.toString() }
    }

    override fun tearDown() {
        try {
            if (builtExecutable() != null) {
                LanguageServerManager.getInstance(project).stop("hsm")
            }
            HsmSettings.get().state.executable = executable
        } finally {
            super.tearDown()
        }
    }

    fun testCommandLine() {
        val commandLine = HsmConnectionProvider.commandLine("/opt/hsm/bin/hsm", "/work")
        assertEquals(listOf("/opt/hsm/bin/hsm", "lsp", "--stdio"), commandLine.getCommandLineList(null))
        assertEquals("/work", commandLine.workDirectory?.path)
        assertTrue("LSP4IJ is installed in the test IDE", HsmLanguageServerSupport.lsp4ijEnabled())
    }

    fun testLanguageServer() {
        if (builtExecutable() == null) {
            println("skipped: no hsm executable in packages/cli/dist/bin (npm run build:exe)")
            return
        }
        assertTrue(HsmLanguageServerSupport.active())
        myFixture.tempDirFixture.createFile("hsm.gen.json", "{ \"headers\": { \"includePaths\": [\"include\"] } }\n")
        val header = myFixture.tempDirFixture.createFile("include/types.h", types)
        val model = myFixture.tempDirFixture.createFile("models/gate.hsm", gate)
        // LSP4IJ only connects files of the project
        val root = myFixture.tempDirFixture.getFile("")!!
        PsiTestUtil.addContentRoot(module, root)
        Disposer.register(testRootDisposable) { PsiTestUtil.removeContentEntry(module, root) }
        myFixture.configureFromExistingVirtualFile(model)

        val registry = LanguageServersRegistry.getInstance()
        assertNotNull("server definition of hsm-lsp4ij.xml", registry.getServerDefinition("hsm"))
        assertTrue("LSP4IJ supports ${'$'}{myFixture.file}", registry.isFileSupported(myFixture.file))
        // the plugin's own annotator leaves the problems to the language server
        assertNull(HsmExternalAnnotator().collectInformation(myFixture.file))

        // started explicitly: in the light test fixture LSP4IJ does not start servers for opened files by itself
        val manager = LanguageServerManager.getInstance(project)
        manager.start("hsm", LanguageServerManager.StartOptions().setForceStart(true))
        val end = System.currentTimeMillis() + 60_000
        while (manager.getServerStatus("hsm") != ServerStatus.started && System.currentTimeMillis() < end) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(100)
        }
        val started = LanguageServiceAccessor.getInstance(project).startedServers
        assertEquals(started.joinToString { "${it.serverStatus} ${it.serverError ?: ""}" }, ServerStatus.started, manager.getServerStatus("hsm"))
        // the language servers of the model (LSP4IJ opens the document in them): the HSM language server
        val items = await(LanguageServiceAccessor.getInstance(project).getLanguageServers(myFixture.file, null, null))
        assertEquals(listOf("hsm"), items.map { it.serverDefinition.id })
        val server = await(items.single().initializedServer)
        val document = TextDocumentIdentifier(VfsUtilCore.virtualToIoFile(model).toURI().toString())
        val position = Position(3, gate.lines()[3].indexOf("kSteps") + 2)

        // hover and definition: the documentation and the declaration in the header of the include path
        val hover = server.textDocumentService.hover(HoverParams(document, position)).let(::await)
        assertTrue("hover: ${'$'}hover", hover?.contents?.right?.value.orEmpty().contains("Number of steps."))
        val definition = server.textDocumentService.definition(DefinitionParams(document, position)).let(::await)
        val targets = if (definition.isRight) definition.right.map { it.targetUri } else definition.left.map { it.uri }
        assertEquals(1, targets.size)
        assertEquals(VfsUtilCore.virtualToIoFile(header).canonicalPath, Path.of(java.net.URI(targets[0])).toFile().canonicalPath)
    }

    /** Waits for a future without blocking the event dispatch thread (the test runs on it, LSP4IJ needs it). */
    private fun <T> await(future: CompletableFuture<T>): T {
        val end = System.currentTimeMillis() + 60_000
        while (!future.isDone && System.currentTimeMillis() < end) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(50)
        }
        return future.get(1, TimeUnit.SECONDS)
    }

    /** The executable of this platform built by packages/cli. */
    private fun builtExecutable(): Path? {
        val os = when {
            SystemInfo.isMac -> "macos"
            SystemInfo.isWindows -> "windows"
            else -> "linux"
        }
        val arch = if (SystemInfo.isAarch64) "arm64" else "x64"
        val file = Path.of("..", "packages", "cli", "dist", "bin", "$os-$arch", if (SystemInfo.isWindows) "hsm.exe" else "hsm").toAbsolutePath().normalize()
        return file.takeIf { Files.isRegularFile(it) && Files.isExecutable(it) }
    }
}
