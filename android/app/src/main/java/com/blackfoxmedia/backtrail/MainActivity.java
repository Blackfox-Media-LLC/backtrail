package com.blackfoxmedia.backtrail;

import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.OnApplyWindowInsetsListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Draw the app's forest background behind the system bars.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // The app is always dark behind the bars, so force light (white) status
        // and navigation icons. The theme attribute alone loses to the system's
        // light mode, which drew near-invisible dark icons on the dark header.
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);

        final WebView web = getBridge().getWebView();

        // Chromium on Android reports only display cutouts through
        // env(safe-area-inset-*), never the status or navigation bar, so the
        // header and tab bar would sit underneath them. Push the real insets
        // into the CSS variables the stylesheet reads (--sat / --sab).
        //
        // Attached to the decor view because Capacitor's content layout
        // consumes insets before they reach the WebView (which reports zero).
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(),
                new OnApplyWindowInsetsListener() {
                    @Override
                    public WindowInsetsCompat onApplyWindowInsets(View v, WindowInsetsCompat insets) {
                        pushInsets(web);
                        return insets;
                    }
                });

        installBackHandler();

        // Insets usually settle before the page exists; re-apply once it loads.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                pushInsets(webView);
            }
        });
    }

    /** Read the current window insets and hand them to the stylesheet. */
    private void pushInsets(final WebView web) {
        web.post(new Runnable() {
            @Override
            public void run() {
                WindowInsetsCompat wi = ViewCompat.getRootWindowInsets(getWindow().getDecorView());
                if (wi == null) {
                    return;
                }
                Insets bars = wi.getInsets(WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout());
                float d = getResources().getDisplayMetrics().density;
                int top = Math.round(bars.top / d);
                int bottom = Math.round(bars.bottom / d);
                // Edge-to-edge windows are not resized for the keyboard, so pass
                // its height too; the stylesheet shrinks the app shell above it.
                int ime = Math.round(wi.getInsets(WindowInsetsCompat.Type.ime()).bottom / d);
                // Guard the root element: insets arrive during startup layout
                // passes before the document exists.
                web.evaluateJavascript(
                        "(function(e){if(!e)return;"
                      + "e.style.setProperty('--sat','" + top + "px');"
                      + "e.style.setProperty('--sab','" + bottom + "px');"
                      + "e.style.setProperty('--kb','" + ime + "px');"
                      + "e.classList.toggle('kb'," + (ime > 0) + ");"
                      + "if(" + (ime > 0) + ")window.scrollTo(0,0);"
                      + "})(document.documentElement);",
                        null);
            }
        });
    }

    /**
     * Hand the back press to the page first (closes the About sheet, or returns
     * from other tabs to Messages). When the page reports it did nothing, the
     * app goes to the background instead of closing, so connected radios stay
     * linked and messages keep arriving (like other messaging apps).
     *
     * Registered through the AndroidX OnBackPressedDispatcher, NOT by
     * overriding onBackPressed(): with targetSdk 36 on Android 16, predictive
     * back is on by default and onBackPressed() is never called, so the
     * override silently let the system close the app on the first press.
     */
    private void installBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final WebView web = getBridge().getWebView();
                web.evaluateJavascript(
                        "(function(){try{return !!(window.__backtrailBack && window.__backtrailBack());}"
                      + "catch(e){return false;}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String handled) {
                                if (!"true".equals(handled)) {
                                    moveTaskToBack(true);
                                }
                            }
                        });
            }
        });
    }
}
