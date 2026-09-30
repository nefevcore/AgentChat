package agentchat.noise.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

/**
 * 配对扫码面（cr-43 ③）——App 自带扫码，替代「打开微信/系统相机扫二维码再深链跳回」。
 *
 * CameraX 预览 + ImageAnalysis 逐帧喂 zxing MultiFormatReader（QR_ONLY）；
 * 扫得 agentchat://pair 开头的 URI 即 setResult 返回 MainActivity 走既有 pairWith 路径。
 * 相机权限运行时申请（Manifest 已声明 CAMERA）；拒绝则提示并关闭。
 *
 * 基类 AppCompatActivity：bindToLifecycle 需要 LifecycleOwner、扫码回主线程走
 * lifecycleScope——纯 Activity 两者皆缺（真机编译实锤），appcompat 已在依赖树。
 */
class ScanActivity : androidx.appcompat.app.AppCompatActivity() {

    companion object {
        const val EXTRA_RESULT_URI = "scan_result_uri"
        private const val REQ_CAMERA = 7043
    }

    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }

    @Volatile private var decoded = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#0B1020"))
        }
        val surface = FrameLayout(this)
        root.addView(surface, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(TextView(this).apply {
            text = "对准电脑端「远程设备」页的二维码"
            setTextColor(android.graphics.Color.parseColor("#9AA4BF"))
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, dp(14))
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(Button(this).apply {
            text = "取消"
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            setMargins(dp(16), 0, dp(16), dp(16))
        })
        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) {
            startCamera(surface)
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        val surface = (findContentView() as? FrameLayout)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && surface != null) {
            startCamera(surface)
        } else {
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    private fun findContentView(): android.view.View {
        return findViewById(android.R.id.content)
    }

    private fun startCamera(surface: FrameLayout) {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            // PreviewView 承载预览（裸 SurfaceProvider 需手管分辨率，不必）
            val previewView = androidx.camera.view.PreviewView(this)
            val preview = Preview.Builder().build()
            surface.addView(previewView, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            preview.setSurfaceProvider(previewView.surfaceProvider)

            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(analysisExecutor, ::analyzeFrame)

            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                android.util.Log.e("ScanActivity", "相机绑定失败", e)
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @OptIn(ExperimentalGetImage::class)
    private fun analyzeFrame(proxy: ImageProxy) {
        if (decoded) { proxy.close(); return }
        try {
            val data = proxy.planes[0].buffer
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            val source = PlanarYUVLuminanceSource(
                bytes, proxy.width, proxy.height,
                0, 0, proxy.width, proxy.height, false)
            val result = reader.decodeWithState(
                BinaryBitmap(HybridBinarizer(source)))
            val text = result.text ?: return
            if (text.startsWith("agentchat://pair")) {
                decoded = true
                lifecycleScope.launch(Dispatchers.Main) {
                    val intent = Intent().putExtra(EXTRA_RESULT_URI, text)
                    setResult(RESULT_OK, intent)
                    finish()
                }
            }
        } catch (_: Exception) {
            // 未命中二维码是常态（每帧尝试）——静默
        } finally {
            reader.reset()
            proxy.close()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        analysisExecutor.shutdown()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
