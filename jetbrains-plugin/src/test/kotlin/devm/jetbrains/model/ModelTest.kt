package devm.jetbrains.model

import com.google.gson.JsonParser
import devm.jetbrains.cli.CliValidator
import devm.jetbrains.cli.DevmExecutable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Test
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

/** Paths, the reports of the page, the output of `devm validate --json` and the executable lookup. */
class ModelTest {

    @Test
    fun confinesPathsToTheRoot() {
        assertEquals(listOf("models", "a.devm"), ProjectPaths.segments("models/./a.devm"))
        assertEquals(listOf("models", "a.devm"), ProjectPaths.segments("/models//a.devm"))
        assertEquals(listOf("models", "a.devm"), ProjectPaths.segments("models\\a.devm"))
        assertNull(ProjectPaths.segments("../a.devm"))
        assertNull(ProjectPaths.segments("models/../../a.devm"))
        assertNull(ProjectPaths.segments("C:/a.devm"))
        assertNull(ProjectPaths.segments(""))
        assertNull(ProjectPaths.segments("./"))
        assertTrue(ProjectPaths.isValidFileName("gate.svg"))
        assertFalse(ProjectPaths.isValidFileName("../gate.svg"))
        assertFalse(ProjectPaths.isValidFileName(".hidden"))
        assertEquals("/a/c", ProjectPaths.normalize("/a/b/../c/."))
    }

    @Test
    fun classifiesFiles() {
        assertTrue(ProjectPaths.isModel("door.DEVM"))
        assertFalse(ProjectPaths.isModel("door.devmtest"))
        assertTrue(ProjectPaths.isImportable("system.devm"))
        assertTrue(ProjectPaths.isImportable("motor.hpp"))
        assertTrue(ProjectPaths.isImportable("types.h"))
        assertFalse(ProjectPaths.isImportable("main.cpp"))
        assertTrue(ProjectPaths.isGeneratorConfig("devm.gen.json"))
        assertTrue(ProjectPaths.isGeneratorConfig("door.devm.gen.json"))
        assertFalse(ProjectPaths.isGeneratorConfig("package.json"))
    }

    @Test
    fun tellsStructureFilesFromStateMachines() {
        assertFalse(ProjectPaths.isStructureText("statemachine Door {}"))
        assertFalse(ProjectPaths.isStructureText("// a door\n/* with\n a motor */\n  statemachine Door {}"))
        assertTrue(ProjectPaths.isStructureText("import \"door.devm\"\ncomponent Door {}"))
        assertTrue(ProjectPaths.isStructureText("statemachines A"))
        assertTrue(ProjectPaths.isStructureText("statemachine_ x"))
        assertTrue(ProjectPaths.isStructureText(""))
        assertTrue(ProjectPaths.isStructureText("/* unterminated statemachine"))
    }

    @Test
    fun findsImporters() {
        val text = "import \"../motor.devm\"\nimport \"types.h\"\nstatemachine Door {}"
        assertTrue(ProjectPaths.imports("/p/models", text, setOf("/p/motor.devm")))
        assertTrue(ProjectPaths.imports("/p/models", text, setOf("/p/include/types.h")))
        assertFalse(ProjectPaths.imports("/p/models", text, setOf("/p/models/other.devm")))
    }

    @Test
    fun readsTheReportOfThePage() {
        val report = ModelReport.fromJson(JsonParser.parseString("""
            {"textLength":42,"problems":[{"severity":"warning","message":"unused","line":2,"column":3,"offset":10,"end":14}],
             "outline":[{"label":"Door","kind":"statemachine","offset":0,"end":42,"children":[{"label":"Open","kind":"state","offset":20,"end":30}]}]}
        """).asJsonObject)
        assertEquals(42, report.textLength)
        assertEquals(ModelProblem(Severity.WARNING, "unused", 2, 3, 0, 0, 10, 14), report.problems.single())
        assertEquals("Door", report.outline.single().label)
        assertEquals("Open", report.outline.single().children.single().label)
        assertEquals(emptyList<OutlineNode>(), report.outline.single().children.single().children)
    }

    @Test
    fun readsTheOutputOfDevmValidate() {
        val output = "(node:1) ExperimentalWarning: something\n" +
            """{"files":[{"file":"a.devm","path":"/p/a.devm","problems":[""" +
            """{"path":"/p/a.devm","severity":"error","message":"Unknown state","line":3,"column":5,"endLine":3,"endColumn":9,"offset":30,"end":34},""" +
            """{"path":"/p/motor.devm","severity":"error","message":"of the import","line":1,"column":1,"endLine":1,"endColumn":2,"offset":0,"end":1}]},""" +
            """{"file":"b.devm","path":"/p/b.devm","problems":[]}]}""" + "\n"
        val problems = CliOutput.parse(CliOutput.jsonLine(output), 2)
        assertEquals(listOf(ModelProblem(Severity.ERROR, "Unknown state", 3, 5, 3, 9, 30, 34)), problems[0])
        assertEquals(emptyList<ModelProblem>(), problems[1])
    }

    @Test
    fun runsTheExecutable() {
        assumeFalse(System.getProperty("os.name").lowercase().startsWith("windows"))
        val directory = Files.createTempDirectory("devm-cli")
        try {
            val model = Files.writeString(directory.resolve("a.devm"), "statemachine A {}")
            val script = directory.resolve("devm")
            Files.writeString(script, """
                #!/bin/sh
                # a fake devm: validate --json <file>
                echo '{"files":[{"file":"'"${'$'}3"'","path":"'"${'$'}3"'","problems":[{"severity":"warning","message":"from '"${'$'}1 ${'$'}2"'","line":1,"column":1,"offset":0,"end":1}]}]}'
            """.trimIndent() + "\n")
            Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"))
            val result = CliValidator(script).validate(listOf(model), directory)
            assertEquals("from validate --json", result.getValue(model).single().message)

            assertEquals(script, DevmExecutable.onPath("/nonexistent:${directory}", false, null))
            assertNull(DevmExecutable.onPath("/nonexistent", false, "/nonexistent-home").takeIf { it.toString().startsWith(directory.toString()) })
        } finally {
            directory.toFile().deleteRecursively()
        }
    }
}
