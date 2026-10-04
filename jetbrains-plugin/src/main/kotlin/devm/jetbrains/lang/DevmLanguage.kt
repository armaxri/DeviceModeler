package devm.jetbrains.lang

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

object DevmIcons {
    @JvmField
    val FILE: Icon = IconLoader.getIcon("/icons/devm.svg", DevmIcons::class.java)
}

/** The model language (`.devm`): state machines and structure files (components, subsystems, systems, …). */
object DevmLanguage : Language("Devm") {
    private fun readResolve(): Any = DevmLanguage
    override fun getDisplayName(): String = "Device Modeler"
}

/** The unit tests of state machines (`.devmtest`). */
object DevmTestLanguage : Language("DevmTest") {
    private fun readResolve(): Any = DevmTestLanguage
    override fun getDisplayName(): String = "Device Modeler Test"
}

object DevmFileType : LanguageFileType(DevmLanguage) {
    override fun getName(): String = "Devm"
    override fun getDescription(): String = "Device Modeler model (state machine or structure)"
    override fun getDefaultExtension(): String = "devm"
    override fun getIcon(): Icon = DevmIcons.FILE
}

object DevmTestFileType : LanguageFileType(DevmTestLanguage) {
    override fun getName(): String = "Devm Test"
    override fun getDescription(): String = "Unit test of hierarchical state machines"
    override fun getDefaultExtension(): String = "devmtest"
    override fun getIcon(): Icon = DevmIcons.FILE
}
