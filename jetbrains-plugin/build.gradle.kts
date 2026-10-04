import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "devm"
version = providers.gradleProperty("pluginVersion").get()

val platformVersion = providers.gradleProperty("platformVersion")
val latestPlatformVersion = providers.gradleProperty("latestPlatformVersion")
val lsp4ijVersion = providers.gradleProperty("lsp4ijVersion")

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // the Kotlin standard library of the oldest supported platform (2025.2)
        apiVersion.set(KotlinVersion.KOTLIN_2_2)
        languageVersion.set(KotlinVersion.KOTLIN_2_2)
        // no delegating overrides of the default methods of platform interfaces (e.g. experimental ones)
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(platformVersion)
        // optional dependency (devm-lsp4ij.xml): compiled against, installed into the sandboxes of runIde and the tests
        plugin("com.redhat.devtools.lsp4ij", lsp4ijVersion.get())
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, platformVersion)
            create(IntelliJPlatformType.IntellijIdea, latestPlatformVersion)
        }
    }
}

intellijPlatformTesting {
    runIde {
        // ./gradlew runLatestIde: the latest IntelliJ IDEA with the plugin
        register("runLatestIde") {
            type = IntelliJPlatformType.IntellijIdea
            version = latestPlatformVersion
            plugins {
                plugin("com.redhat.devtools.lsp4ij", lsp4ijVersion.get())
            }
        }
        // ./gradlew runClion: CLion with the plugin (large download)
        register("runClion") {
            type = IntelliJPlatformType.CLion
            version = latestPlatformVersion
            plugins {
                plugin("com.redhat.devtools.lsp4ij", lsp4ijVersion.get())
            }
        }
        // ./gradlew runIdeForUiTests --args=<project>: an IDE with the Robot server (http://127.0.0.1:8082, see
        // the README), without the dialogs of a first start
        register("runIdeForUiTests") {
            task {
                jvmArgumentProviders += CommandLineArgumentProvider {
                    listOf(
                        "-Drobot-server.port=8082",
                        "-Dide.mac.message.dialogs.as.sheets=false",
                        "-Djb.privacy.policy.text=<!--999.999-->",
                        "-Djb.consents.confirmation.enabled=false",
                        "-Didea.trust.all.projects=true",
                        "-Dide.show.tips.on.startup.default.value=false",
                    )
                }
            }
            plugins {
                robotServerPlugin()
                plugin("com.redhat.devtools.lsp4ij", lsp4ijVersion.get())
            }
        }
    }
}

// The web app (packages/web/dist, built by `npm run build` in the repository root) is part of the plugin:
// <plugin>/webapp. Optionally an devm executable for one platform: -PdevmExecutable=<path> → <plugin>/bin/devm[.exe].
val webApp = layout.projectDirectory.dir("../packages/web/dist")
val devmExecutable = providers.gradleProperty("devmExecutable")

tasks.withType<PrepareSandboxTask>().configureEach {
    from(webApp) {
        into(pluginName.map { "$it/webapp" })
    }
    if (devmExecutable.isPresent) {
        from(devmExecutable) {
            into(pluginName.map { "$it/bin" })
            filePermissions { unix("rwxr-xr-x") }
        }
    }
}

tasks.named<PrepareSandboxTask>("prepareSandbox") {
    val index = webApp.file("index.html").asFile
    doFirst {
        check(index.isFile) { "The web app is missing: $index (run `npm run build` in the repository root first)" }
    }
}

tasks.test {
    // the light platform tests run headless; JCEF is not available there (the editor shows its fallback)
    systemProperty("java.awt.headless", "true")
}
