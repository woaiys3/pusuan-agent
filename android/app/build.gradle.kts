plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.pusuan"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.pusuan"
        minSdk = 24

        // ⚠️ 必须保持 28。Android 从 29 起对应用私有目录挂载 noexec，
        // 内核是随 APK 分发的原生 node 可执行文件，targetSdk>=29 会导致 exec 失败、引擎起不来。
        // 这是平台限制，不是可以绕过的配置项。用户已核实 target 28 下引擎正常。
        targetSdk = 28

        versionCode = 1
        versionName = "1.0.0"

        // 运行时按 ABI 打包（vendor/payload 由 tools/prepare-payload.sh 按 ABI 生成）
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    // payload.zip 由 tools/prepare-payload.sh 写入 src/main/assets/，属构建产物，不入 git。
    // 打成单 zip 而非散文件：1.4 万个小文件会拖慢 aapt 与安装，AssetManager 逐文件读取也慢。
    sourceSets["main"].assets.srcDirs("src/main/assets")

    buildTypes {
        release {
            isMinifyEnabled = false
            // 自签，keep 规则留空；内核是 JS/原生二进制，R8 不参与
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // 原生二进制与内核资源必须原样保留，绝不压缩（压缩会破坏 exec 与 so 加载）
        jniLibs.useLegacyPackaging = true
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }

    androidResources {
        noCompress += listOf("zip", "node", "so", "dex", "bin")
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // 不引入 material-icons-extended：它会把上万条图标类编进 dex（约 40MB），
    // 而界面只用到了极少数图标，全部可用 material3 内置或系统 drawable 代替。

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // 与内核通信：HTTP unary RPC + 两条 WebSocket 下行事件流
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
