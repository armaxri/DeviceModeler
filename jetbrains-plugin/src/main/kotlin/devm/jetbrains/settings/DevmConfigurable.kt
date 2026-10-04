package devm.jetbrains.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.selected
import com.intellij.ui.layout.not
import devm.jetbrains.cli.DevmExecutable

/** *Settings > Tools > Device Modeler*: the `devm` executable and the defaults of *Generate C++*. */
class DevmConfigurable : BoundConfigurable("Device Modeler") {

    override fun createPanel(): DialogPanel {
        val options = DevmSettings.get().state
        return panel {
            group("Command Line Tool") {
                row("devm executable:") {
                    textFieldWithBrowseButton(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("Devm Executable"))
                        .bindText({ options.executable ?: "" }, { options.executable = it.trim() })
                        .align(AlignX.FILL)
                        .comment("Empty: ${DevmExecutable.describeDefault()}. Used to validate closed models; " +
                            "CMake (cmake/DevmGenerate.cmake) uses <code>devm</code> of the PATH.")
                }
                row {
                    checkBox("Validate saved models and their importers with devm validate")
                        .bindSelected({ options.validateOnSave }, { options.validateOnSave = it })
                }
            }
            group("Generate C++ (if no devm.gen.json lists the model)") {
                row("Output folder:") {
                    textField()
                        .bindText({ options.cppOutputDirectory ?: "" }, { options.cppOutputDirectory = it.trim() })
                        .align(AlignX.FILL)
                        .comment("Relative to the model; <code>\${project}/…</code>: relative to the project; empty: the folder of the model")
                }
                lateinit var modelNamespace: com.intellij.ui.dsl.builder.Cell<com.intellij.ui.components.JBCheckBox>
                row {
                    modelNamespace = checkBox("Namespace of the model")
                        .bindSelected({ options.cppModelNamespace }, { options.cppModelNamespace = it })
                }
                row("Namespace:") {
                    textField()
                        .bindText({ options.cppNamespace ?: "" }, { options.cppNamespace = it.trim() })
                        .comment("For example <code>app::control</code>; empty: the global namespace")
                }.enabledIf(modelNamespace.selected.not())
                row("C++ standard:") {
                    comboBox(listOf("17", "11"))
                        .bindItem({ if (options.cppStandard == "11") "11" else "17" }, { options.cppStandard = it ?: "17" })
                }
            }
        }
    }
}
