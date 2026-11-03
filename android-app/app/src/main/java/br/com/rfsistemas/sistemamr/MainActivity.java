package br.com.rfsistemas.sistemamr;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/* Sistema MR — app Android da RF Sistemas.
   Abre o sistema (GitHub Pages) em tela cheia. Tudo vem da internet: atualizou o site, o app já está atualizado. */
public class MainActivity extends Activity {
    static final String SITE = "https://rf-sistemas.github.io/contas-por-empresa/";
    static final int REQ_ARQ = 7;
    WebView web;
    ValueCallback<Uri[]> retornoArq;
    Uri fotoUri;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " SistemaMR-Android");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.toString().startsWith(SITE)) return false;   // o próprio sistema abre aqui dentro
                abrirFora(u); return true;                          // WhatsApp, PDF, e-mail, telefone: abre fora
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (retornoArq != null) retornoArq.onReceiveValue(null);
                retornoArq = cb;
                Intent escolher;
                try { escolher = p.createIntent(); } catch (Exception e) { escolher = new Intent(Intent.ACTION_GET_CONTENT).setType("*/*"); }
                escolher.addCategory(Intent.CATEGORY_OPENABLE);
                String[] aceita = p.getAcceptTypes();
                String ac = aceita == null ? "" : android.text.TextUtils.join(",", aceita).trim();
                boolean imagem = ac.isEmpty() || ac.contains("image");
                Intent chooser = Intent.createChooser(escolher, "Escolher arquivo");
                if (imagem) {
                    try {
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.Images.Media.DISPLAY_NAME, "sistema-mr-" + System.currentTimeMillis() + ".jpg");
                        cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                        fotoUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                        Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, fotoUri);
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{ cam });
                    } catch (Exception e) { fotoUri = null; }
                }
                try { startActivityForResult(chooser, REQ_ARQ); }
                catch (Exception e) { retornoArq = null; Toast.makeText(MainActivity.this, "Não abriu o seletor de arquivos.", Toast.LENGTH_LONG).show(); return false; }
                return true;
            }
            @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean gesto, android.os.Message m) {
                // window.open: pega o endereço e abre fora (PDF assinado, WhatsApp)
                WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest r) { abrirFora(r.getUrl()); return true; }
                    @Override public void onPageStarted(WebView w, String url, android.graphics.Bitmap f) { if (url != null && !url.equals("about:blank")) { abrirFora(Uri.parse(url)); w.stopLoading(); } }
                });
                ((WebView.WebViewTransport) m.obj).setWebView(tmp); m.sendToTarget(); return true;
            }
        });
        if (b != null) web.restoreState(b); else web.loadUrl(SITE);
    }

    void abrirFora(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
        catch (Exception e) { Toast.makeText(this, "Nenhum app para abrir este link.", Toast.LENGTH_LONG).show(); }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_ARQ || retornoArq == null) { super.onActivityResult(req, res, data); return; }
        Uri[] r = null;
        if (res == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                int n = data.getClipData().getItemCount(); r = new Uri[n];
                for (int i = 0; i < n; i++) r[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) r = new Uri[]{ data.getData() };
            else if (fotoUri != null) r = new Uri[]{ fotoUri };
        } else if (fotoUri != null) { try { getContentResolver().delete(fotoUri, null, null); } catch (Exception e) {} }
        retornoArq.onReceiveValue(r); retornoArq = null; fotoUri = null;
    }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
}
