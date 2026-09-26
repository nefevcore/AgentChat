plugins {
    kotlin("jvm") version "2.1.20"
    application
}

repositories { mavenCentral() }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.ktor:ktor-server-core:2.3.12")
    implementation("io.ktor:ktor-server-cio:2.3.12")
    implementation("io.ktor:ktor-server-websockets:2.3.12")
    implementation("io.ktor:ktor-server-status-pages:2.3.12")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation("io.ktor:ktor-client-cio:2.3.12")
    testImplementation("io.ktor:ktor-client-websockets:2.3.12")
}

kotlin { jvmToolchain(17) }

// agentchat.noise.android 子包用 android.* API（Keystore/Service/Notification），
// 只有 Android 工程能编——JVM 模块（本模块的测试与 CLI 驱动器）排除它。
// Android 侧经 app/build.gradle 的 sourceSets 全量编入（含该子包）。
sourceSets {
    main {
        kotlin { exclude("agentchat/noise/android/**") }
    }
}

application {
    mainClass.set("agentchat.noorx.MainKt")
}
