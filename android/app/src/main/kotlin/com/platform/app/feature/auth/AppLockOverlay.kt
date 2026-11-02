package com.platform.app.feature.auth

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.platform.app.R
import com.platform.app.core.model.Workspace
import com.platform.app.core.model.mobileAppBillingUrl
import com.platform.app.i18n.BrandStr
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.i18n.StrAndroid
import com.platform.app.ui.A11y
import com.platform.app.ui.components.BrandPalette
import com.platform.app.ui.components.PrimaryButton
import com.platform.app.ui.components.SecondaryButton
import com.platform.app.ui.components.WorkspaceAvatar
import com.platform.app.ui.design.AppType
import com.platform.app.ui.design.Radius
import com.platform.app.ui.design.Space

/**
 * The card over the app when the workspace's plan has the mobile app off
 * (docs/operations/MOBILE_APP_PLAN.md, "The apps", Android): the brand mark,
 * why nothing answers, how the plan gets the app — on the web panel's
 * billing page, in the browser — and the only other ways on: another
 * workspace, for a member of more than one, and sign out.
 *
 * The caller draws the app beneath it faded — blurred on Android 12 and
 * later — and takes it out of TalkBack's reach and of its lifecycle
 * ([rememberCappedLifecycleOwner]); this veil takes every tap, so tabs,
 * buttons and pull to refresh beneath do nothing. Back leaves the app, as
 * from its first screen.
 */
@Composable
fun AppLockOverlay(
    language: Language,
    workspaces: List<Workspace>,
    selectedWorkspace: Workspace?,
    /** The web panel's origin, as the platform last named it; without one there is no button to open it. */
    panelOrigin: String?,
    onSelectWorkspace: (Workspace) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    // A half-typed reply must not keep the keyboard, or its keys, open under
    // the card.
    LaunchedEffect(Unit) { focus.clearFocus(force = true) }
    BackHandler { (context as? Activity)?.moveTaskToBack(true) }

    var choosingWorkspace by rememberSaveable { mutableStateOf(false) }
    var confirmingSignOut by rememberSaveable { mutableStateOf(false) }
    val billing = mobileAppBillingUrl(panelOrigin)

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            // A dim scrim over the app: light enough over the blur (Android 12
            // and later) for the app to show through, heavy enough without it
            // for the card to read over an unblurred screen.
            .background(MaterialTheme.colorScheme.scrim.copy(alpha = if (Build.VERSION.SDK_INT >= 31) 0.32f else 0.62f))
            // Every tap lands here, never on the app beneath.
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics {
                isTraversalGroup = true
                paneTitle = Str.appLockedTitle(language)
            }
            .testTag(A11y.APP_LOCK_CARD)
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        // Centred, and scrolling only when a large font needs it to.
        Box(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .heightIn(min = maxHeight),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                shape = RoundedCornerShape(Radius.xl),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shadowElevation = 12.dp,
                modifier = Modifier
                    .padding(Space.xl)
                    .widthIn(max = 440.dp)
                    .fillMaxWidth(),
            ) {
                Column(
                    Modifier.padding(horizontal = Space.xxl, vertical = Space.xxl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    BrandMark(language)
                    Text(
                        Str.appLockedTitle(language),
                        style = AppType.titleLargeEmphasized,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = Space.sm),
                    )
                    Text(
                        Str.appLockedBody(language),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        StrAndroid.appLockedVisitWebsite(language),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    if (billing != null) {
                        PrimaryButton(
                            label = StrAndroid.appLockedOpenWebsite(language),
                            onClick = { openInBrowser(context, billing) },
                            modifier = Modifier
                                .padding(top = Space.sm)
                                .testTag(A11y.APP_LOCK_OPEN_WEBSITE),
                        )
                    }
                    if (workspaces.size > 1) {
                        SecondaryButton(
                            label = Str.appLockedSwitchWorkspace(language),
                            onClick = { choosingWorkspace = true },
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag(A11y.APP_LOCK_SWITCH_WORKSPACE),
                        )
                    }
                    TextButton(
                        onClick = { confirmingSignOut = true },
                        modifier = Modifier.testTag(A11y.APP_LOCK_SIGN_OUT),
                    ) {
                        Text(Str.signOut(language), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (choosingWorkspace) {
        WorkspaceChoice(
            language = language,
            workspaces = workspaces,
            selected = selectedWorkspace,
            onSelect = { workspace ->
                choosingWorkspace = false
                onSelectWorkspace(workspace)
            },
            onDismiss = { choosingWorkspace = false },
        )
    }

    // The same confirmation as Settings' sign out.
    if (confirmingSignOut) {
        AlertDialog(
            onDismissRequest = { confirmingSignOut = false },
            title = { Text(Str.signOut(language)) },
            text = { Text(BrandStr.signOutConfirm(language)) },
            confirmButton = {
                TextButton(onClick = { confirmingSignOut = false; onSignOut() }) {
                    Text(Str.signOut(language), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingSignOut = false }) { Text(Str.cancel(language)) }
            },
        )
    }
}

/**
 * The workspaces, to switch to another — the rows Settings lists them in:
 * the workspace's logo, else the platform's workspace mark (never a letter),
 * its name and its site, the one on screen ticked. Settings is under the
 * lock, so the card brings the list with it.
 */
@Composable
private fun WorkspaceChoice(
    language: Language,
    workspaces: List<Workspace>,
    selected: Workspace?,
    onSelect: (Workspace) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(Str.workspace(language)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                workspaces.forEach { workspace ->
                    val current = workspace.id == selected?.id
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Radius.lg))
                            .clickable(role = Role.Button) { if (current) onDismiss() else onSelect(workspace) }
                            .padding(vertical = Space.sm, horizontal = Space.xs)
                            .testTag(A11y.workspaceRow(workspace.id)),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WorkspaceAvatar(logoUrl = workspace.logoUrl, size = 40.dp)
                        Column(Modifier.weight(1f).padding(horizontal = Space.lg)) {
                            Text(
                                workspace.name,
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            // Isolated, so a Latin domain reads left to right
                            // in Persian too.
                            workspace.websiteDomain?.takeIf { it.isNotBlank() }?.let { domain ->
                                Text(
                                    "⁦$domain⁩",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        if (current) {
                            Icon(
                                Icons.Filled.Check,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(Str.cancel(language)) }
        },
    )
}

/**
 * The brand's mark, as its launcher icon draws it: the flavor's own
 * foreground on the brand's two colours (each flavor's `brand_deep` and
 * `brand_bright`). Never a letter.
 */
@Composable
private fun BrandMark(language: Language) {
    Box(
        Modifier
            .size(72.dp)
            .clip(RoundedCornerShape(Radius.lgIncreased))
            .background(Brush.linearGradient(listOf(BrandPalette.bright, BrandPalette.deep)))
            .semantics(mergeDescendants = true) {},
        contentAlignment = Alignment.Center,
    ) {
        // The adaptive icon's 108dp canvas, drawn whole: the mark sits in its
        // middle, as on the home screen.
        Image(
            painter = painterResource(R.drawable.ic_launcher_foreground),
            contentDescription = BrandStr.appName(language),
            modifier = Modifier.size(72.dp),
        )
    }
}

/** A page in the phone's browser; a phone with none has nothing to open it with, and the tap does nothing. */
internal fun openInBrowser(context: android.content.Context, url: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
    if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // Nothing to open it with.
    } catch (_: SecurityException) {
        // Nor anything that may be opened from here.
    }
}

/**
 * A lifecycle for what is drawn under the lock: the parent's, held at
 * CREATED while [capped].
 *
 * Every screen of the app does its own background work for as long as it is
 * resumed — the inbox's and a thread's polling, the colleagues' unread
 * count, the visitors' refresh — and every list follows its flows for as
 * long as it is started. Held at CREATED under the lock card, all of that
 * stops at once, and every screen stays exactly where it was, its last
 * values on it; released, they start again as on a return to the app. The
 * screens' Back handlers, which follow the same lifecycle, stand down with
 * them: Back is the card's.
 */
@Composable
fun rememberCappedLifecycleOwner(capped: Boolean): LifecycleOwner {
    val parent = LocalLifecycleOwner.current
    val owner = remember(parent) { CappedLifecycleOwner(parent, capped) }
    SideEffect { owner.capped = capped }
    DisposableEffect(owner) {
        owner.attach()
        onDispose { owner.detach() }
    }
    return owner
}

private class CappedLifecycleOwner(private val parent: LifecycleOwner, initiallyCapped: Boolean) : LifecycleOwner {
    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    var capped: Boolean = initiallyCapped
        set(value) {
            if (field == value) return
            field = value
            sync()
        }

    private val observer = LifecycleEventObserver { _, _ -> sync() }

    init {
        sync()
    }

    fun attach() {
        parent.lifecycle.addObserver(observer)
        sync()
    }

    fun detach() {
        parent.lifecycle.removeObserver(observer)
    }

    private fun sync() {
        val current = registry.currentState
        // A lifecycle that has ended does not start again.
        if (current == Lifecycle.State.DESTROYED) return
        val upstream = parent.lifecycle.currentState
        val target = if (capped && upstream.isAtLeast(Lifecycle.State.STARTED)) Lifecycle.State.CREATED else upstream
        // Nor does one go back to before it was created.
        if (target == Lifecycle.State.INITIALIZED && current != Lifecycle.State.INITIALIZED) return
        if (target != current) registry.currentState = target
    }
}
