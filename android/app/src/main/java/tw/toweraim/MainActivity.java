package tw.toweraim;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 塔臺對準儀 — 以 WebView 包裝的 Android 版。
 * 載入線上版網頁，並把相機、定位、全螢幕等權限接到原生層。
 * 刻意不使用 appcompat/androidx，零外部依賴、APK 最小、建置最快。
 */
public class MainActivity extends Activity {

  private static final String APP_URL = "https://8rknrz2dbw-ai.github.io/transcript-deck/";
  private static final int REQ_PERMS = 1001;

  private WebView web;
  private FrameLayout root;
  private View fullscreenView;
  private WebChromeClient.CustomViewCallback fullscreenCb;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    root = new FrameLayout(this);
    web = new WebView(this);
    root.addView(web, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(root);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);                  // localStorage：站臺資料保存
    s.setGeolocationEnabled(true);                 // 定位
    s.setMediaPlaybackRequiresUserGesture(false);  // 相機串流可直接播放
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);

    web.setWebViewClient(new WebViewClient());
    web.setWebChromeClient(new WebChromeClient() {
      // 網頁要求相機權限 → 直接授予（App 已在系統層取得 CAMERA）
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        runOnUiThread(() -> request.grant(request.getResources()));
      }

      // 網頁要求定位
      @Override
      public void onGeolocationPermissionsShowPrompt(String origin,
          GeolocationPermissions.Callback callback) {
        callback.invoke(origin, true, false);
      }

      // 全螢幕（AR 視角的 ⛶ 全螢幕）
      @Override
      public void onShowCustomView(View view, CustomViewCallback callback) {
        if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
        fullscreenView = view;
        fullscreenCb = callback;
        root.addView(view, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setVisibility(View.GONE);
      }

      @Override
      public void onHideCustomView() {
        exitFullscreen();
      }
    });

    requestNeededPermissions();

    if (savedInstanceState != null) web.restoreState(savedInstanceState);
    else web.loadUrl(APP_URL);
  }

  private void exitFullscreen() {
    if (fullscreenView == null) return;
    root.removeView(fullscreenView);
    fullscreenView = null;
    web.setVisibility(View.VISIBLE);
    if (fullscreenCb != null) { fullscreenCb.onCustomViewHidden(); fullscreenCb = null; }
  }

  /** 返回鍵：先離開全螢幕，再在網頁內返回，最後才離開 App。 */
  @Override
  public void onBackPressed() {
    if (fullscreenView != null) { exitFullscreen(); return; }
    if (web.canGoBack()) { web.goBack(); return; }
    super.onBackPressed();
  }

  private void requestNeededPermissions() {
    String[] want = { Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION };
    boolean need = false;
    for (String p : want) {
      if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) need = true;
    }
    if (need) requestPermissions(want, REQ_PERMS);
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }
}
