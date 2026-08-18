package com.pusuan;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 普算（Pusuan）Android 版 —— WebView 壳 + JS 桥
 *
 * 前端（assets/app/index.html）通过 window.pywebview.api.xxx() 调用后端，
 * 本工程在页面加载前注入 bridge.js：它实现完整的 window.pywebview.api，
 * 内部逻辑全部为纯 JS（对话/工具/排盘），存储经本类提供的原生桥落盘到
 * 应用私有目录（files/data），与桌面版 data/ 目录结构一一对应。
 */
public class MainActivity extends Activity {

    private static final String TAG = "Pusuan";
    private WebView webView;
    private Bridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 全屏 + 沉浸式状态栏
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = new WebView(this);
        bridge = new Bridge(this);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        // 桌面版设计为 1280 宽，手机窄屏下用 wide viewport 让 CSS 按桌面宽度排版，
        // 由 bridge.js 注入的 mobile.css 做响应式适配
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i("PusuanWeb", "PAGE_FINISHED: " + url);
                // 检查关键全局对象
                view.evaluateJavascript(
                    "JSON.stringify({pusuan: typeof Pusuan, pywebview: typeof window.pywebview, " +
                    "storage: typeof PusuanStorage, provider: typeof PusuanProvider, " +
                    "tools: typeof PusuanTools, chat: typeof PusuanChat, " +
                    "liuren: typeof LiurenEngine, liuyao: typeof LiuyaoEngine, " +
                    "native: typeof PusuanNative, setup: typeof setup, sTerm: typeof sTerm})",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            Log.i("PusuanWeb", "GLOBALS: " + value);
                            // 视口与适配探针
                            view.evaluateJavascript(
                                "JSON.stringify({innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio, mqMobile: window.matchMedia(\"(max-width: 860px)\").matches, mqMobileLandscape: window.matchMedia(\"(min-width: 861px) and (max-width: 1200px)\").matches, cssLoaded: !!document.styleSheets.length, hamburgerVisible: (function(){var b=document.querySelector(\".mobile-hamburger\");return b?getComputedStyle(b).display:\"no-btn\";})()})",
                                new ValueCallback<String>() {
                                    @Override
                                    public void onReceiveValue(String value2) {
                                        Log.i("PusuanWeb", "VIEWPORT: " + value2);
                                        // 自动测试：点击汉堡按钮并检查侧边栏
                                        view.evaluateJavascript(
                                            "(function(){var b=document.querySelector(\".mobile-hamburger\");if(b)b.click();" +
                                            "return JSON.stringify({afterClick: document.body.classList.contains(\"sidebar-open\")});})()",
                                            new ValueCallback<String>() {
                                                @Override
                                                public void onReceiveValue(String value3) {
                                                    Log.i("PusuanWeb", "HAMBURGER_TEST: " + value3);
                                                }
                                            });
                                    }
                                });
                        }
                    });
            }
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e("PusuanWeb", "LOAD_ERROR " + failingUrl + " -> " + errorCode + " " + description);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    // 外部链接交给系统浏览器（模型官方文档页等）
                    try {
                        view.getContext().startActivity(
                                new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception e) { /* ignore */ }
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams params) {
                return false;
            }
            @Override
            public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                result.confirm();
                return true;
            }
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                Log.i("PusuanWeb", "[" + cm.messageLevel() + "] " + cm.message() + " @" + cm.lineNumber());
                return true;
            }
        });

        webView.addJavascriptInterface(bridge, "PusuanNative");

        setContentView(webView);

        // 加载前端
        webView.loadUrl("file:///android_asset/app/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    /* ──────────────────────────────────────────────────────────
     * JS <-> 原生桥
     * 前端 JS（bridge.js）通过 PusuanNative.xxx() 调用以下方法。
     * 所有方法在 UI 线程外执行时注意线程安全；此处均快速返回，
     * 文件读写量小，直接主线程执行可接受（数据文件都很小）。
     * ────────────────────────────────────────────────────────── */
    public static class Bridge {

        private final Context ctx;
        private final File dataDir;

        public Bridge(Context ctx) {
            this.ctx = ctx;
            // 运行期数据根目录：files/data/（对应桌面版项目内 data/）
            this.dataDir = new File(ctx.getFilesDir(), "data");
            ensureDir(dataDir);
        }

        private static void ensureDir(File d) {
            if (!d.exists()) d.mkdirs();
        }

        private File safePath(String rel) {
            // 防目录穿越：只允许 data 目录下的相对路径
            File f = new File(dataDir, rel == null ? "" : rel);
            try {
                String base = dataDir.getCanonicalPath();
                String path = f.getCanonicalPath();
                if (!path.startsWith(base + File.separator) && !path.equals(base)) {
                    return null;
                }
            } catch (IOException e) {
                return null;
            }
            return f;
        }

        @JavascriptInterface
        public String readFile(String rel) {
            try {
                File f = safePath(rel);
                if (f == null) return null;
                if (!f.exists()) return null;
                byte[] b = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                try { in.read(b); } finally { in.close(); }
                return new String(b, StandardCharsets.UTF_8);
            } catch (Exception e) {
                Log.w(TAG, "readFile " + rel + ": " + e);
                return null;
            }
        }

        @JavascriptInterface
        public boolean writeFile(String rel, String content) {
            try {
                File f = safePath(rel);
                if (f == null) return false;
                ensureDir(f.getParentFile());
                FileOutputStream out = new FileOutputStream(f);
                try { out.write(content.getBytes(StandardCharsets.UTF_8)); } finally { out.close(); }
                return true;
            } catch (Exception e) {
                Log.w(TAG, "writeFile " + rel + ": " + e);
                return false;
            }
        }

        @JavascriptInterface
        public boolean deleteFile(String rel) {
            try {
                File f = safePath(rel);
                if (f == null) return false;
                return f.delete();
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean exists(String rel) {
            File f = safePath(rel);
            return f != null && f.exists();
        }

        @JavascriptInterface
        public String listDir(String rel) {
            try {
                File f = safePath(rel);
                if (f == null || !f.isDirectory()) return "[]";
                File[] files = f.listFiles();
                if (files == null) return "[]";
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < files.length; i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(files[i].getName()).append("\"");
                }
                sb.append("]");
                return sb.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        /** 读取 APK assets 中的文件（前端、引擎、知识库、技能均打包在 assets 下） */
        @JavascriptInterface
        public String readAsset(String path) {
            try {
                InputStream in = ctx.getAssets().open(path);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
                return out.toString("UTF-8");
            } catch (Exception e) {
                Log.w(TAG, "readAsset " + path + ": " + e);
                return null;
            }
        }

        /** 列出 assets 目录（返回相对路径列表，JSON 数组字符串） */
        @JavascriptInterface
        public String listAssetDir(String path) {
            try {
                String[] list = ctx.getAssets().list(path);
                if (list == null) return "[]";
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < list.length; i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(list[i]).append("\"");
                }
                sb.append("]");
                return sb.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        /** 复制到剪贴板 */
        @JavascriptInterface
        public void copyText(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("pusuan", text));
            } catch (Exception e) { /* ignore */ }
        }

        /** 震动反馈（毫秒） */
        @JavascriptInterface
        public void vibrate(long ms) {
            try {
                android.os.Vibrator v = (android.os.Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(ms);
            } catch (Exception e) { /* ignore */ }
        }

        @JavascriptInterface
        public void toast(String msg) {
            try {
                Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show();
            } catch (Exception e) { /* ignore */ }
        }

        /** 应用版本名（前端"关于"页展示） */
        /** 检查是否已授予"所有文件访问"权限 */
        @JavascriptInterface
        public boolean checkStoragePermission() {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                return android.os.Environment.isExternalStorageManager();
            }
            return ctx.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        /** 打开系统授权页（"所有文件访问"或具体存储权限） */
        @JavascriptInterface
        public void requestStoragePermission() {
            try {
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    i.setData(android.net.Uri.parse("package:" + ctx.getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                } else {
                    ((Activity) ctx).requestPermissions(
                        new String[]{
                            android.Manifest.permission.READ_EXTERNAL_STORAGE,
                            android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                        }, 1001);
                }
            } catch (Exception e) {
                try {
                    Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                } catch (Exception e2) { /* ignore */ }
            }
        }

        /** 读取外部存储文件（需已授权；路径必须是 /storage/emulated 或 /sdcard 开头） */
        @JavascriptInterface
        public String readExternal(String absPath) {
            try {
                File f = new File(absPath);
                if (!f.exists() || !f.isFile()) return null;
                if (f.length() > 10 * 1024 * 1024) return "[文件过大，超过10MB限制]";
                byte[] b = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                try { in.read(b); } finally { in.close(); }
                return new String(b, StandardCharsets.UTF_8);
            } catch (Exception e) {
                Log.w(TAG, "readExternal " + absPath + ": " + e);
                return null;
            }
        }

        /** 列出外部存储目录 */
        @JavascriptInterface
        public String listExternal(String absPath) {
            try {
                File f = new File(absPath);
                if (!f.exists() || !f.isDirectory()) return "[]";
                File[] files = f.listFiles();
                if (files == null) return "[]";
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < files.length; i++) {
                    if (i > 0) sb.append(",");
                    String name = files[i].getName();
                    sb.append("{\"name\":\"").append(name.replace("\\", "\\\\").replace("\"", "\\\""))
                      .append("\",\"isDir\":").append(files[i].isDirectory())
                      .append(",\"size\":").append(files[i].isFile() ? files[i].length() : 0)
                      .append("}");
                }
                sb.append("]");
                return sb.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public String getVersion() {
            try {
                return ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "1.0.0";
            }
        }
    }
}
