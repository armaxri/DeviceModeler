package hsm.eclipse.tools;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.core.runtime.Status;

import hsm.eclipse.Activator;
import hsm.eclipse.Json;

/**
 * Validation of saved model files with the command line executable: {@code hsm validate --json <files…>} (one
 * process for up to {@value #BATCH} models), run in the folder of the project. The executable resolves imports
 * and C/C++ headers from the file system like {@code hsm validate} in a terminal (headers with the
 * {@code headers} block of the nearest {@code hsm.gen.json}).
 * <p>
 * Output: {@code {"files":[{"file","path","problems":[{"path","severity","message","line","column","endLine",
 * "endColumn","offset","end"}]}]}} (1-based lines / columns, UTF-16 offsets as in Eclipse documents; problems of
 * imported models carry their own path and are left to the validation of those models).
 */
public class CliValidator implements ModelValidator {

    /** Models per process (command lines are limited, e.g. 32 K characters on Windows). */
    static final int BATCH = 100;
    private static final long TIMEOUT_SECONDS = 300;

    @Override
    public boolean isAvailable() {
        return HsmExecutable.locate().isPresent();
    }

    @Override
    public String unavailableReason() {
        return "HSM validation of closed files needs the hsm executable: install the HSM Modeler feature for this platform, "
                + "put hsm into the PATH or set it in Preferences > HSM Modeler.";
    }

    @Override
    public List<ModelProblem> validate(IFile model, IProgressMonitor monitor) throws CoreException {
        return validateAll(List.of(model), monitor).getOrDefault(model, List.of());
    }

    @Override
    public Map<IFile, List<ModelProblem>> validateAll(List<IFile> models, IProgressMonitor monitor) throws CoreException {
        HsmExecutable.Located executable = HsmExecutable.locate().orElseThrow(() -> error(unavailableReason(), null));
        Map<IFile, List<ModelProblem>> result = new LinkedHashMap<>();
        List<IFile> files = models.stream().filter(model -> model.getLocation() != null).toList();
        for (int start = 0; start < files.size(); start += BATCH) {
            List<IFile> batch = files.subList(start, Math.min(files.size(), start + BATCH));
            result.putAll(run(executable, batch, monitor));
        }
        return result;
    }

    private Map<IFile, List<ModelProblem>> run(HsmExecutable.Located executable, List<IFile> models, IProgressMonitor monitor) throws CoreException {
        List<String> command = new ArrayList<>(List.of(executable.path().toString(), "validate", "--json"));
        for (IFile model : models) {
            command.add(model.getLocation().toOSString());
        }
        IPath projectLocation = models.get(0).getProject().getLocation();
        ProcessBuilder builder = new ProcessBuilder(command);
        if (projectLocation != null) {
            builder.directory(projectLocation.toFile());
        }
        String stdout;
        String stderr;
        int exitCode;
        try {
            Process process = builder.start();
            process.getOutputStream().close();
            CompletableFuture<String> out = CompletableFuture.supplyAsync(() -> read(process.getInputStream()));
            CompletableFuture<String> err = CompletableFuture.supplyAsync(() -> read(process.getErrorStream()));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS);
            while (!process.waitFor(100, TimeUnit.MILLISECONDS)) {
                if (monitor != null && monitor.isCanceled()) {
                    process.destroyForcibly();
                    throw new OperationCanceledException();
                }
                if (System.nanoTime() > deadline) {
                    process.destroyForcibly();
                    throw error("hsm validate did not finish within " + TIMEOUT_SECONDS + " s", null);
                }
            }
            exitCode = process.exitValue();
            stdout = out.get(10, TimeUnit.SECONDS);
            stderr = err.get(10, TimeUnit.SECONDS);
        } catch (IOException e) {
            throw error("Could not run " + HsmExecutable.describe(executable) + ": " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new OperationCanceledException();
        } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException e) {
            throw error("Could not read the output of hsm validate: " + e.getMessage(), e);
        }
        if (exitCode > 1 || stdout.isBlank()) {
            throw error("hsm validate failed (exit code " + exitCode + ", " + HsmExecutable.describe(executable) + "): " + stderr.strip(), null);
        }
        try {
            // the JSON document is the last line (other output, e.g. warnings of Node.js, comes before it)
            String[] lines = stdout.strip().split("\\R");
            return parse(models, lines[lines.length - 1]);
        } catch (RuntimeException e) {
            throw error("Unexpected output of hsm validate --json (an older hsm executable?): " + e.getMessage(), e);
        }
    }

    /** The problems of the models in the output of {@code hsm validate --json} (in the order of the models). */
    static Map<IFile, List<ModelProblem>> parse(List<IFile> models, String json) {
        List<Object> files = Json.array(Json.object(Json.parse(json)).get("files"));
        if (files.size() != models.size()) {
            throw new IllegalArgumentException(files.size() + " results for " + models.size() + " models");
        }
        Map<IFile, List<ModelProblem>> result = new LinkedHashMap<>();
        for (int i = 0; i < models.size(); i++) {
            Map<String, Object> file = Json.object(files.get(i));
            String path = Json.string(file.get("path"), "");
            List<ModelProblem> problems = new ArrayList<>();
            for (Object problem : Json.array(file.get("problems"))) {
                Map<String, Object> map = Json.object(problem);
                if (Objects.equals(Json.string(map.get("path"), path), path)) {
                    problems.add(problem(map));
                }
            }
            result.put(models.get(i), problems);
        }
        return result;
    }

    private static ModelProblem problem(Map<String, Object> map) {
        int severity = switch (Json.string(map.get("severity"), "error")) {
            case "warning" -> IMarker.SEVERITY_WARNING;
            case "info", "hint" -> IMarker.SEVERITY_INFO;
            default -> IMarker.SEVERITY_ERROR;
        };
        return new ModelProblem(severity, Json.string(map.get("message"), ""), Json.integer(map.get("line"), 0),
                Json.integer(map.get("column"), 0), Json.integer(map.get("offset"), -1), Json.integer(map.get("end"), -1));
    }

    private static String read(InputStream in) {
        try (in) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static CoreException error(String message, Throwable cause) {
        return new CoreException(new Status(IStatus.ERROR, Activator.PLUGIN_ID, message, cause));
    }
}
