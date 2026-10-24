PS D:\Mouj> Get-Content "D:\Mouj\app\src\main\java\ir\mouj\MainActivity.kt"

package ir.mouj

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    companion object {
        private const val HOME_URL =
            "https://chat.radmehrweb.ir/mouj-messenger.html"

        private const val SITE_HOST = "chat.radmehrweb.ir"

        private const val DOWNLOAD_CHANNEL_ID = "mouj_downloads"
        private const val DOWNLOAD_CHANNEL_NAME = "دانلودهای موج"

        private const val TAG_PAGE = "MoujPageDebug"
        private const val TAG_CONSOLE = "MoujWebConsole"
        private const val TAG_LAYOUT = "MoujLayoutCheck"
    }

    private var webView: WebView? = null
    private var firebaseToken: String? = null

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null

    private var loading by mutableStateOf(true)
    private var pageError by mutableStateOf(false)
    private var canGoBack by mutableStateOf(false)
    private var pageProgress by mutableIntStateOf(0)

    private lateinit var fileChooserLauncher:
            androidx.activity.result.ActivityResultLauncher<Intent>

    private lateinit var mediaPermissionLauncher:
            androidx.activity.result.ActivityResultLauncher<Array<String>>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        createDownloadNotificationChannel()

        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result: ActivityResult ->
            val callback = fileChooserCallback
            fileChooserCallback = null

            if (callback != null) {
                val results = WebChromeClient.FileChooserParams.parseResult(
                    result.resultCode,
                    result.data
                )
                callback.onReceiveValue(results)
            }
        }

        mediaPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { results ->
            val request = pendingWebPermission
            pendingWebPermission = null

            if (request != null) {
                val allGranted = results.values.all { it }

                if (allGranted) {
                    request.grant(request.resources)
                } else {
                    request.deny()
                }
            }
        }

        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                firebaseToken = token
                Log.i(TAG_PAGE, "FCM token received")
                runOnUiThread {
                    injectFirebaseToken()
                }
            }
            .addOnFailureListener { error ->
                Log.e(TAG_PAGE, "FCM token error: ${error.message}")
            }

        setContent {
            MaterialTheme {
                val context = LocalContext.current

                val notificationPermissionLauncher =
                    rememberLauncherForActivityResult(
                        ActivityResultContracts.RequestPermission()
                    ) { granted ->
                        Log.i(
                            TAG_PAGE,
                            "Notification permission granted=$granted"
                        )
                    }

                LaunchedEffect(Unit) {
                    if (
                        Build.VERSION.SDK_INT >= 33 &&
                        ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.POST_NOTIFICATIONS
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        notificationPermissionLauncher.launch(
                            Manifest.permission.POST_NOTIFICATIONS
                        )
                    }
                }

                BackHandler(enabled = canGoBack) {
                    webView?.let { view ->
                        if (view.canGoBack()) {
                            view.goBack()
                        }
                    }
                }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = androidx.compose.ui.graphics.Color.White
                ) {
                    Box(modifier = Modifier.fillMaxSize()) {

                        AndroidView(
                            modifier = Modifier.fillMaxSize(),
                            factory = { ctx ->
                                createWebView(ctx).also { view ->
                                    webView = view
                                    view.loadUrl(HOME_URL)
                                }
                            },
                            update = { view ->
                                if (webView !== view) {
                                    webView = view
                                }
                            }
                        )

                        if (loading && !pageError) {
                            Column(
                                modifier = Modifier
                                    .align(Alignment.TopCenter)
                                    .fillMaxWidth()
                            ) {
                                LinearProgressIndicator(
                                    progress = { pageProgress / 100f },
                                    modifier = Modifier.fillMaxWidth()
                                )
                            }
                        }

                        if (pageError) {
                            Column(
                                modifier = Modifier
                                    .align(Alignment.Center)
                                    .padding(24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Text(
                                    text = "بارگذاری موج با مشکل مواجه شد",
                                    style = MaterialTheme.typography.titleMedium
                                )

                                Text(
                                    text = "اتصال اینترنت را بررسی کن و دوباره تلاش کن.",
                                    modifier = Modifier.padding(top = 8.dp)
                                )

                                Button(
                                    modifier = Modifier.padding(top = 16.dp),
                                    onClick = {
                                        pageError = false
                                        loading = true
                                        pageProgress = 0
                                        webView?.loadUrl(HOME_URL)
                                    }
                                ) {
                                    Text("تلاش دوباره")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(context: Context): WebView {
        return WebView(context).apply {

            setBackgroundColor(Color.WHITE)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                loadsImagesAutomatically = true
                javaScriptCanOpenWindowsAutomatically = true
                setSupportMultipleWindows(false)
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                allowFileAccess = true
                allowContentAccess = true
                mixedContentMode =
                    WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    safeBrowsingEnabled = true
                }
            }

            val cookieManager = CookieManager.getInstance()
            cookieManager.setAcceptCookie(true)
            cookieManager.setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {

                override fun onPageStarted(
                    view: WebView,
                    url: String,
                    favicon: android.graphics.Bitmap?
                ) {
                    super.onPageStarted(view, url, favicon)

                    loading = true
                    pageError = false
                    pageProgress = 0

                    Log.i(TAG_PAGE, "PAGE_STARTED url=$url")
                }

                override fun onPageFinished(
                    view: WebView,
                    url: String
                ) {
                    super.onPageFinished(view, url)

                    Log.i(
                        TAG_PAGE,
                        "WEBVIEW_SIZE width=${view.width} " +
                                "height=${view.height} " +
                                "measuredWidth=${view.measuredWidth} " +
                                "measuredHeight=${view.measuredHeight}"
                    )

                    collectLayoutDiagnostics(view)
                    injectFirebaseToken()

                    loading = false
                    canGoBack = view.canGoBack()
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError
                ) {
                    super.onReceivedError(view, request, error)

                    Log.e(
                        TAG_PAGE,
                        "LOAD_ERROR mainFrame=${request.isForMainFrame} " +
                                "code=${error.errorCode} " +
                                "description=${error.description} " +
                                "url=${request.url}"
                    )

                    if (request.isForMainFrame) {
                        loading = false
                        pageError = true
                    }
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: android.webkit.WebResourceResponse
                ) {
                    super.onReceivedHttpError(
                        view,
                        request,
                        errorResponse
                    )

                    Log.e(
                        TAG_PAGE,
                        "HTTP_ERROR mainFrame=${request.isForMainFrame} " +
                                "status=${errorResponse.statusCode} " +
                                "reason=${errorResponse.reasonPhrase} " +
                                "url=${request.url}"
                    )
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val uri = request.url
                    val host = uri.host.orEmpty()

                    if (uri.scheme == "http" || uri.scheme == "https") {
                        if (
                            host == SITE_HOST ||
                            host.endsWith(".$SITE_HOST")
                        ) {
                            return false
                        }

                        return try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                            true
                        } catch (error: Exception) {
                            Log.e(
                                TAG_PAGE,
                                "External link error: ${error.message}"
                            )
                            false
                        }
                    }

                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        true
                    } catch (error: Exception) {
                        Log.e(
                            TAG_PAGE,
                            "Unsupported link: ${uri.scheme}",
                            error
                        )
                        true
                    }
                }
            }

            webChromeClient = object : WebChromeClient() {

                override fun onProgressChanged(
                    view: WebView,
                    newProgress: Int
                ) {
                    super.onProgressChanged(view, newProgress)
                    pageProgress = newProgress
                }

                override fun onConsoleMessage(
                    consoleMessage: android.webkit.ConsoleMessage
                ): Boolean {
                    val message =
                        "${consoleMessage.messageLevel()} " +
                                "${consoleMessage.message()} " +
                                "at ${consoleMessage.sourceId()}:" +
                                consoleMessage.lineNumber()

                    if (
                        consoleMessage.messageLevel() ==
                        android.webkit.ConsoleMessage.MessageLevel.ERROR
                    ) {
                        Log.e(TAG_CONSOLE, message)
                    } else {
                        Log.d(TAG_CONSOLE, message)
                    }

                    return true
                }

                override fun onShowFileChooser(
                    view: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = filePathCallback

                    return try {
                        fileChooserLauncher.launch(
                            fileChooserParams.createIntent()
                        )
                        true
                    } catch (error: Exception) {
                        fileChooserCallback = null
                        filePathCallback.onReceiveValue(null)

                        Log.e(TAG_PAGE, "File chooser error", error)

                        Toast.makeText(
                            this@MainActivity,
                            "باز کردن انتخاب‌گر فایل ممکن نشد",
                            Toast.LENGTH_SHORT
                        ).show()

                        false
                    }
                }

                override fun onPermissionRequest(
                    request: PermissionRequest
                ) {
                    runOnUiThread {
                        handleWebPermissionRequest(request)
                    }
                }

                override fun onGeolocationPermissionsShowPrompt(
                    origin: String,
                    callback: GeolocationPermissions.Callback
                ) {
                    // دسترسی موقعیت مکانی به‌صورت پیش‌فرض رد می‌شود.
                    callback.invoke(origin, false, false)
                }

                override fun onCreateWindow(
                    view: WebView,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: android.os.Message
                ): Boolean {
                    return false
                }
            }

            setDownloadListener {
                    url, userAgent, contentDisposition, mimeType, _ ->
                downloadFile(
                    url = url,
                    userAgent = userAgent,
                    contentDisposition = contentDisposition,
                    mimeType = mimeType
                )
            }
        }
    }

    /**
     * گزارش وضعیت اندازه صفحه و عناصر اصلی برای بررسی صفحه سفید.
     * این تابع فقط اطلاعات می‌خواند و CSS سایت را تغییر نمی‌دهد.
     */
    private fun collectLayoutDiagnostics(view: WebView) {
        val script = """
            (function() {
              const ids = ['appRoot', 'phone', 'otp', 'profile'];

              const result = {
                url: location.href,
                readyState: document.readyState,
                viewport: {
                  width: innerWidth,
                  height: innerHeight
                },
                bodyClass: document.body
                  ? document.body.className
                  : null,
                body: document.body ? {
                  height: document.body.getBoundingClientRect().height,
                  cssHeight: getComputedStyle(document.body).height,
                  display: getComputedStyle(document.body).display,
                  position: getComputedStyle(document.body).position
                } : null,
                elements: ids.map(function(id) {
                  const e = document.getElementById(id);

                  if (!e) {
                    return {id: id, missing: true};
                  }

                  const s = getComputedStyle(e);
                  const r = e.getBoundingClientRect();

                  return {
                    id: id,
                    height: r.height,
                    width: r.width,
                    cssHeight: s.height,
                    display: s.display,
                    position: s.position,
                    visibility: s.visibility,
                    className: e.className,
                    inlineStyle: e.getAttribute('style')
                  };
                })
              };

              return JSON.stringify(result);
            })();
        """.trimIndent()

        view.evaluateJavascript(script) { result ->
            Log.i(TAG_LAYOUT, result ?: "No diagnostic result")
        }
    }

    private fun injectFirebaseToken() {
        val token = firebaseToken ?: return
        val view = webView ?: return

        val script =
            "window.MOUJ_FCM_TOKEN = ${JSONObject.quote(token)};" +
                    "window.dispatchEvent(new Event('mouj-fcm-token'));"

        view.evaluateJavascript(script, null)
        Log.i(TAG_PAGE, "Firebase token injected into page")
    }

    private fun handleWebPermissionRequest(
        request: PermissionRequest
    ) {
        val requestedResources = request.resources.toList()
        val androidPermissions = mutableListOf<String>()

        if (
            requestedResources.contains(
                PermissionRequest.RESOURCE_VIDEO_CAPTURE
            )
        ) {
            androidPermissions.add(Manifest.permission.CAMERA)
        }

        if (
            requestedResources.contains(
                PermissionRequest.RESOURCE_AUDIO_CAPTURE
            )
        ) {
            androidPermissions.add(Manifest.permission.RECORD_AUDIO)
        }

        if (androidPermissions.isEmpty()) {
            request.deny()
            return
        }

        val missingPermissions = androidPermissions.filter { permission ->
            ContextCompat.checkSelfPermission(
                this,
                permission
            ) != PackageManager.PERMISSION_GRANTED
        }

        if (missingPermissions.isEmpty()) {
            request.grant(requestedResources.toTypedArray())
        } else {
            pendingWebPermission?.deny()
            pendingWebPermission = request
            mediaPermissionLauncher.launch(
                missingPermissions.toTypedArray()
            )
        }
    }

    private fun downloadFile(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ) {
        try {
            if (
                url.startsWith("blob:", ignoreCase = true) ||
                url.startsWith("data:", ignoreCase = true)
            ) {
                Toast.makeText(
                    this,
                    "این نوع لینک دانلود مستقیماً پشتیبانی نمی‌شود.",
                    Toast.LENGTH_LONG
                ).show()

                Log.w(TAG_PAGE, "Unsupported download URL: $url")
                return
            }

            val fileName = URLUtil.guessFileName(
                url,
                contentDisposition,
                mimeType
            )

            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(fileName)
                setDescription("در حال دانلود از موج")
                setNotificationVisibility(
                    DownloadManager.Request
                        .VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                )
                setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS,
                    fileName
                )
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)

                if (!userAgent.isNullOrBlank()) {
                    addRequestHeader("User-Agent", userAgent)
                }

                val cookies =
                    CookieManager.getInstance().getCookie(url)

                if (!cookies.isNullOrBlank()) {
                    addRequestHeader("Cookie", cookies)
                }

                if (!mimeType.isNullOrBlank()) {
                    setMimeType(mimeType)
                }
            }

            val manager = getSystemService(
                Context.DOWNLOAD_SERVICE
            ) as DownloadManager

            manager.enqueue(request)

            Toast.makeText(
                this,
                "دانلود شروع شد",
                Toast.LENGTH_SHORT
            ).show()
        } catch (error: Exception) {
            Log.e(TAG_PAGE, "Download error", error)

            Toast.makeText(
                this,
                "دانلود انجام نشد: " +
                        (error.localizedMessage ?: "خطای ناشناخته"),
                Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun createDownloadNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                DOWNLOAD_CHANNEL_ID,
                DOWNLOAD_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "اعلان‌های دانلود برنامه موج"
            }

            val manager = getSystemService(
                Context.NOTIFICATION_SERVICE
            ) as NotificationManager

            manager.createNotificationChannel(channel)
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null

        pendingWebPermission?.deny()
        pendingWebPermission = null

        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            removeAllViews()
            destroy()
        }

        webView = null
        super.onDestroy()
    }
}


PS D:\Mouj> 
