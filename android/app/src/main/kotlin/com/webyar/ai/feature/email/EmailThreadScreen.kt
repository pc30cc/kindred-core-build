package com.webyar.ai.feature.email

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.webyar.ai.core.model.EmailAttachmentView
import com.webyar.ai.core.model.EmailThreadSummary
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrEmail
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.LoadingIndicator
import com.webyar.ai.ui.design.Space
import java.io.ByteArrayInputStream

/** How a reply is addressed. */
enum class EmailReplyMode { REPLY, REPLY_ALL, FORWARD }

/**
 * One email thread, read the way the Windows app reads it.
 *
 * The whole thread is one white page ([EmailReader]): the subject, the
 * newest mail open under who sent it, when and to whom, and the earlier ones
 * folded below it, each a line that opens with a tap. A mail is shown as
 * it was written — its own layout, colours, pictures and tables — rather than
 * as its words with the HTML taken out. Files are chips on the page that
 * open on the phone; links go to the browser. At the foot, Reply, Reply all
 * and Forward, which open the composer already addressed.
 */
@Composable
fun EmailThreadScreen(
    state: EmailThreadState,
    thread: EmailThreadSummary?,
    language: Language,
    modifier: Modifier = Modifier,
    mailbox: String? = null,
    onRetry: () -> Unit = {},
    onOpenAttachment: (EmailAttachmentView) -> Unit = {},
    onReply: ((EmailReplyMode) -> Unit)? = null,
    /** An inline picture's bytes and type, fetched for the page; null leaves it blank. */
    loadInline: (EmailAttachmentView) -> Pair<String, ByteArray>? = { null },
) {
    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (state) {
                is EmailThreadState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    LoadingIndicator()
                }

                is EmailThreadState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is EmailThreadState.Loaded -> {
                    val document = remember(state.messages, thread?.subject, mailbox, language) {
                        EmailReader.document(
                            subject = thread?.subject,
                            messages = state.messages,
                            mailbox = mailbox,
                            language = language,
                            snippet = thread?.lastMessageSnippet,
                        )
                    }
                    val files = remember(state.messages) {
                        state.messages.flatMap { it.attachments.orEmpty() }.associateBy { it.id }
                    }
                    EmailReaderView(
                        document = document,
                        onAttachment = { id -> files[id]?.let(onOpenAttachment) },
                        loadInline = { id -> files[id]?.let(loadInline) },
                        modifier = Modifier.fillMaxSize().testTag(A11y.EMAIL_THREAD),
                    )
                }
            }
        }
        if (onReply != null && state is EmailThreadState.Loaded) {
            ReplyBar(language, onReply)
        }
    }
}

/**
 * The page, in a WebView that can only draw.
 *
 * JavaScript is off, files and content URIs are off, no second window can
 * open, and nothing navigates inside it: a tapped link is handed to the
 * browser (or, for a file chip, to the app), and a navigation nobody tapped
 * — a mail trying to move the page by itself — goes nowhere.
 */
@Composable
internal fun EmailReaderView(
    document: String,
    onAttachment: (String) -> Unit,
    loadInline: (String) -> Pair<String, ByteArray>?,
    modifier: Modifier = Modifier,
) {
    val attachment by rememberUpdatedState(onAttachment)
    val inline by rememberUpdatedState(loadInline)
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                // White before the first frame too, so a dark theme does not
                // flash black behind a mail that is about to be white.
                setBackgroundColor(Color.WHITE)
                settings.apply {
                    javaScriptEnabled = false
                    javaScriptCanOpenWindowsAutomatically = false
                    setSupportMultipleWindows(false)
                    allowFileAccess = false
                    allowContentAccess = false
                    domStorageEnabled = false
                    setGeolocationEnabled(false)
                    mediaPlaybackRequiresUserGesture = true
                    // The page's own viewport (the phone's width) is used,
                    // and a mail that is wider still after the reader's fit
                    // rules opens zoomed out to show all of it, rather than
                    // with its right side off the screen. Pinch to read closer.
                    useWideViewPort = true
                    loadWithOverviewMode = true
                    builtInZoomControls = true
                    displayZoomControls = false
                    cacheMode = WebSettings.LOAD_DEFAULT
                }
                webViewClient = ReaderClient(
                    onAttachment = { attachment(it) },
                    loadInline = { inline(it) },
                )
            }
        },
        update = { view ->
            // Only a new page is loaded: recomposing for anything else would
            // throw away the reader's scroll and every card they opened.
            if (view.tag != document) {
                view.tag = document
                view.loadDataWithBaseURL(null, document, "text/html", "utf-8", null)
            }
        },
        onRelease = { view ->
            view.stopLoading()
            view.destroy()
        },
        modifier = modifier,
    )
}

private class ReaderClient(
    private val onAttachment: (String) -> Unit,
    private val loadInline: (String) -> Pair<String, ByteArray>?,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (url.startsWith("${EmailReader.ATTACHMENT_SCHEME}:")) {
            EmailReader.attachmentIdOf(url)?.let(onAttachment)
            return true
        }
        val scheme = request.url.scheme?.lowercase()
        // Only a link somebody tapped leaves the app; a page that moves by
        // itself (a refresh, a redirect) is simply stopped.
        if (scheme in EXTERNAL && request.hasGesture()) {
            try {
                view.context.startActivity(
                    Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: ActivityNotFoundException) {
                // Nothing on the phone opens it: the tap does nothing, which
                // is better than the page trying and showing an error.
            }
        }
        return true
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (request.url.host != EmailReader.INLINE_HOST) return null
        val part = EmailReader.attachmentIdOf(request.url.toString())
            ?.let { id -> runCatching { loadInline(id) }.getOrNull() }
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        return WebResourceResponse(part.first, null, ByteArrayInputStream(part.second))
    }

    /** A crashed renderer takes the page with it, not the app. */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true

    private companion object {
        val EXTERNAL = setOf("http", "https", "mailto", "tel")
    }
}

/** Reply, Reply all, Forward — the three ways a mail is answered. */
@Composable
private fun ReplyBar(language: Language, onReply: (EmailReplyMode) -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Row(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            FilledTonalButton(
                onClick = { onReply(EmailReplyMode.REPLY) },
                modifier = Modifier.weight(1f).testTag(A11y.EMAIL_REPLY),
            ) {
                Text(StrEmail.reply(language), maxLines = 1)
            }
            OutlinedButton(
                onClick = { onReply(EmailReplyMode.REPLY_ALL) },
                modifier = Modifier.weight(1f).testTag(A11y.EMAIL_REPLY_ALL),
            ) {
                Text(StrEmail.replyAll(language), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            OutlinedButton(
                onClick = { onReply(EmailReplyMode.FORWARD) },
                modifier = Modifier.weight(1f).testTag(A11y.EMAIL_FORWARD),
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Text(StrEmail.forward(language), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.xs))
            }
        }
    }
}
