package devm.jetbrains.cli

import devm.jetbrains.model.CliOutput
import devm.jetbrains.model.ModelProblem
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Validation of saved models with the command line executable: `devm validate --json <files…>` (one process for
 * up to [BATCH] models), run in the project directory. The executable resolves imports and C/C++ headers from
 * the file system like `devm validate` in a terminal (headers with the `headers` block of the nearest
 * `devm.gen.json`). The same as `CliValidator` of the Eclipse plugin.
 */
class CliValidator(private val executable: Path) {

    class ValidationException(message: String, cause: Throwable? = null) : IOException(message, cause)

    companion object {
        /** Models per process (command lines are limited, e.g. 32 K characters on Windows). */
        const val BATCH = 100
        private const val TIMEOUT_SECONDS = 300L
    }

    /** The problems of the models (absolute paths), by model. */
    fun validate(models: List<Path>, workingDirectory: Path?, isCanceled: () -> Boolean = { false }): Map<Path, List<ModelProblem>> {
        val result = LinkedHashMap<Path, List<ModelProblem>>()
        for (batch in models.chunked(BATCH)) {
            result.putAll(run(batch, workingDirectory, isCanceled))
        }
        return result
    }

    private fun run(models: List<Path>, workingDirectory: Path?, isCanceled: () -> Boolean): Map<Path, List<ModelProblem>> {
        val command = listOf(executable.toString(), "validate", "--json") + models.map { it.toString() }
        val builder = ProcessBuilder(command)
        if (workingDirectory != null) {
            builder.directory(workingDirectory.toFile())
        }
        val stdout: String
        val stderr: String
        val exitCode: Int
        try {
            val process = builder.start()
            process.outputStream.close()
            val out = CompletableFuture.supplyAsync { read(process.inputStream) }
            val err = CompletableFuture.supplyAsync { read(process.errorStream) }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS)
            while (!process.waitFor(100, TimeUnit.MILLISECONDS)) {
                if (isCanceled()) {
                    process.destroyForcibly()
                    throw InterruptedException("canceled")
                }
                if (System.nanoTime() > deadline) {
                    process.destroyForcibly()
                    throw ValidationException("devm validate did not finish within $TIMEOUT_SECONDS s")
                }
            }
            exitCode = process.exitValue()
            stdout = out.get(10, TimeUnit.SECONDS)
            stderr = err.get(10, TimeUnit.SECONDS)
        } catch (e: IOException) {
            throw e as? ValidationException ?: ValidationException("Could not run $executable: ${e.message}", e)
        } catch (e: java.util.concurrent.ExecutionException) {
            throw ValidationException("Could not read the output of devm validate: ${e.message}", e)
        } catch (e: java.util.concurrent.TimeoutException) {
            throw ValidationException("Could not read the output of devm validate: ${e.message}", e)
        }
        if (exitCode > 1 || stdout.isBlank()) {
            throw ValidationException("devm validate failed (exit code $exitCode, $executable): ${stderr.trim()}")
        }
        val problems = try {
            CliOutput.parse(CliOutput.jsonLine(stdout), models.size)
        } catch (e: RuntimeException) {
            throw ValidationException("Unexpected output of devm validate --json (an older devm executable?): ${e.message}", e)
        }
        return models.zip(problems).toMap()
    }

    private fun read(input: InputStream): String = try {
        input.use { String(it.readAllBytes(), StandardCharsets.UTF_8) }
    } catch (e: IOException) {
        ""
    }
}
