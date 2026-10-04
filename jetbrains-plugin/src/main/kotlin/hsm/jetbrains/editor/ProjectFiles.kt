package hsm.jetbrains.editor

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeRegistry
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import hsm.jetbrains.readAction
import hsm.jetbrains.model.ProjectPaths
import java.io.IOException
import java.util.TreeMap

/**
 * The files of a project as the embedded web app sees them: paths relative to the root (the project directory,
 * else the content root of the file, else its folder) with `/` separators. The root is the boundary: the page
 * can import, read and write only files below it. Unsaved changes of other files (open documents) are visible
 * to the page.
 */
object ProjectFiles {

    private const val MAX_FILES = 500
    private const val MAX_FILE_SIZE = 2_000_000L
    private const val MAX_TOTAL_SIZE = 30_000_000L

    /** The root of the session of a file: the project directory (if it contains the file), its content root or its folder. */
    fun root(project: Project, file: VirtualFile): VirtualFile = readAction {
        project.guessProjectDir()?.takeIf { VfsUtilCore.isAncestor(it, file, true) }
            ?: ProjectFileIndex.getInstance(project).getContentRootForFile(file)?.takeIf { it != file }
            ?: file.parent
    }

    /** The path of a file relative to the root (`models/gate.hsm`); `null` if it is not below the root. */
    fun path(root: VirtualFile, file: VirtualFile): String? = VfsUtilCore.getRelativePath(file, root, '/')

    /** The existing file of a path relative to the root; `null` if it does not exist or leaves the root. */
    fun resolve(root: VirtualFile, path: String): VirtualFile? {
        val segments = ProjectPaths.segments(path) ?: return null
        val file = root.findFileByRelativePath(segments.joinToString("/")) ?: return null
        return file.takeIf { isInside(root, it) }
    }

    /** True if the file is below the root, also after resolving symbolic links. */
    fun isInside(root: VirtualFile, file: VirtualFile): Boolean {
        if (!VfsUtilCore.isAncestor(root, file, true)) {
            return false
        }
        val canonicalRoot = root.canonicalPath ?: return true
        val canonicalFile = file.canonicalPath ?: return true
        return canonicalFile.startsWith("$canonicalRoot/")
    }

    /** The text of a file: the open document (also unsaved) or the file. */
    fun text(file: VirtualFile): String = readAction {
        FileDocumentManager.getInstance().getCachedDocument(file)?.text ?: VfsUtilCore.loadText(file)
    }

    /** The importable files below the root (models and headers, without `exclude`), by path. */
    fun importableFiles(project: Project, root: VirtualFile, exclude: VirtualFile): Map<String, String> =
        readAction {
            val files = TreeMap<String, String>()
            var total = 0L
            val index = ProjectFileIndex.getInstance(project)
            val registry = FileTypeRegistry.getInstance()
            VfsUtilCore.visitChildrenRecursively(root, object : VirtualFileVisitor<Unit>(VirtualFileVisitor.NO_FOLLOW_SYMLINKS) {
                override fun visitFile(file: VirtualFile): Boolean {
                    if (files.size >= MAX_FILES || total > MAX_TOTAL_SIZE) {
                        return false
                    }
                    if (file.isDirectory) {
                        return file == root || !(file.name.startsWith(".") || file.name == "node_modules"
                            || registry.isFileIgnored(file) || index.isExcluded(file))
                    }
                    if (file != exclude && ProjectPaths.isImportable(file.name) && file.length <= MAX_FILE_SIZE) {
                        val path = path(root, file)
                        if (path != null) {
                            try {
                                files[path] = FileDocumentManager.getInstance().getCachedDocument(file)?.text ?: VfsUtilCore.loadText(file)
                                total += file.length
                            } catch (e: IOException) {
                                // unreadable: not importable
                            }
                        }
                    }
                    return true
                }
            })
            files
        }

    /** The generator configurations from the folder of the model up to the root, nearest first: `path`, `text`. */
    fun generatorConfigs(root: VirtualFile, model: VirtualFile): List<Map<String, String>> =
        readAction {
            val configs = ArrayList<Map<String, String>>()
            var folder: VirtualFile? = model.parent
            while (folder != null && VfsUtilCore.isAncestor(root, folder, false)) {
                for (child in folder.children.sortedBy { it.name }) {
                    if (!child.isDirectory && ProjectPaths.isGeneratorConfig(child.name)) {
                        val path = path(root, child) ?: continue
                        try {
                            configs.add(linkedMapOf("path" to path, "text" to text(child)))
                        } catch (e: IOException) {
                            // unreadable: ignored
                        }
                    }
                }
                folder = folder.parent
            }
            configs
        }

    /**
     * Writes a file below the root (creates it and its folders if necessary); returns false if the content was
     * the same. Must be called in a write action.
     */
    fun write(root: VirtualFile, path: String, content: ByteArray, requestor: Any): Boolean {
        val segments = ProjectPaths.segments(path) ?: throw IOException("The path $path is outside of the project")
        val folder = if (segments.size == 1) root else VfsUtil.createDirectoryIfMissing(root, segments.dropLast(1).joinToString("/"))
            ?: throw IOException("Cannot create the folder of $path")
        if (!isInside(root, folder) && folder != root) {
            throw IOException("The path $path is outside of the project")
        }
        val existing = folder.findChild(segments.last())
        if (existing != null) {
            if (existing.isDirectory) {
                throw IOException("$path is a folder")
            }
            FileDocumentManager.getInstance().getCachedDocument(existing)?.let { document ->
                // an open document: the file and the document get the new text
                if (document.text.toByteArray(existing.charset).contentEquals(content)) {
                    return false
                }
            }
            if (existing.contentsToByteArray().contentEquals(content)) {
                return false
            }
            existing.setBinaryContent(content, -1, System.currentTimeMillis(), requestor)
            return true
        }
        folder.createChildData(requestor, segments.last()).setBinaryContent(content, -1, System.currentTimeMillis(), requestor)
        return true
    }
}
