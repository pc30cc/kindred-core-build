package com.webyar.operator.ui.components

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.design.Space
import kotlinx.coroutines.launch

/**
 * Every emoji a support conversation reaches for, in the place the keyboard
 * was.
 *
 * It opens where the keyboard sits and at the keyboard's own height, so the
 * field does not move when one replaces the other — the way the messaging
 * apps an operator uses all day behave. Tabs along the top jump to a
 * category and follow the scroll; the ones used lately come first; the key
 * in the corner deletes what was typed, one whole emoji at a time.
 *
 * Laid out left to right in every language: emoji are pictures, and their
 * order is not a sentence to be mirrored.
 */
@Composable
fun EmojiPanel(
    language: Language,
    height: Dp,
    onPick: (String) -> Unit,
    onBackspace: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val recents = remember { EmojiRecents(context) }
    var recent by remember { mutableStateOf(recents.read()) }
    val sections = remember(recent) {
        buildList {
            if (recent.isNotEmpty()) add(EmojiSection(EmojiCatalog.RECENT, recent))
            addAll(EmojiCatalog.sections)
        }
    }
    // Where each section's header sits in the grid, for the tabs.
    val headerIndex = remember(sections) {
        var index = 0
        sections.map { section -> index.also { index += 1 + section.emoji.size } }
    }
    val grid = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    val current by remember(headerIndex) {
        derivedStateOf {
            val first = grid.firstVisibleItemIndex
            headerIndex.indexOfLast { it <= first }.coerceAtLeast(0)
        }
    }

    val pick: (String) -> Unit = { emoji ->
        onPick(emoji)
        recents.add(emoji)
    }

    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            modifier = modifier
                .fillMaxWidth()
                .height(height)
                .testTag(EMOJI_PANEL_TAG),
        ) {
            Column {
                // The categories, each named by its own first picture.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Space.sm, vertical = Space.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.SpaceEvenly) {
                        sections.forEachIndexed { index, section ->
                            val selected = index == current
                            Box(
                                Modifier
                                    .size(36.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (selected) MaterialTheme.colorScheme.secondaryContainer
                                        else androidx.compose.ui.graphics.Color.Transparent,
                                    )
                                    .clickable { scope.launch { grid.animateScrollToItem(headerIndex[index]) } }
                                    .semantics { contentDescription = section.category.title(language) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(section.category.mark, fontSize = 18.sp)
                            }
                        }
                    }
                    BackspaceKey(language, onBackspace)
                }

                LazyVerticalGrid(
                    columns = GridCells.Adaptive(44.dp),
                    state = grid,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = Space.sm,
                        end = Space.sm,
                        bottom = Space.sm,
                    ),
                ) {
                    sections.forEach { section ->
                        item(
                            key = "h:${section.category.key}",
                            span = { GridItemSpan(maxLineSpan) },
                            contentType = "header",
                        ) {
                            Text(
                                section.category.title(language),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = Space.sm, top = Space.sm, bottom = Space.xs),
                            )
                        }
                        section.emoji.forEach { emoji ->
                            item(key = "${section.category.key}:$emoji", contentType = "emoji") {
                                Box(
                                    Modifier
                                        .aspectRatio(1f)
                                        .clip(RoundedCornerShape(12.dp))
                                        // Picked emoji go to the front of Recent
                                        // the next time the panel opens — not
                                        // re-ordered under the thumb.
                                        .clickable { pick(emoji) }
                                        .testTag("emoji.$emoji"),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(emoji, fontSize = 26.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Deletes one whole emoji — or letter — before the caret. */
@Composable
private fun BackspaceKey(language: Language, onBackspace: () -> Unit) {
    val label = when (language) {
        Language.EN -> "Delete"
        Language.FA -> "حذف"
        Language.TR -> "Sil"
    }
    Box(
        Modifier
            .size(40.dp)
            .clip(CircleShape)
            .clickable(onClick = onBackspace)
            .semantics { contentDescription = label }
            .testTag(EMOJI_BACKSPACE_TAG),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Glyph.Backspace,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
    }
}

const val EMOJI_PANEL_TAG = "composer.emojiPanel"
const val EMOJI_BACKSPACE_TAG = "composer.emojiPanel.backspace"

/**
 * The last emoji picked on this phone, most recent first.
 *
 * Kept in plain preferences: a list of pictures is a convenience, not
 * anything about a customer, and nothing else reads it.
 */
internal class EmojiRecents(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("emoji", Context.MODE_PRIVATE)

    fun read(): List<String> =
        prefs.getString(KEY, null)
            ?.split(SEPARATOR)
            ?.filter { it.isNotEmpty() }
            .orEmpty()

    fun add(emoji: String) {
        val next = (listOf(emoji) + read().filter { it != emoji }).take(LIMIT)
        prefs.edit().putString(KEY, next.joinToString(SEPARATOR)).apply()
    }

    private companion object {
        const val KEY = "recent"
        const val SEPARATOR = "\u0001"
        const val LIMIT = 32
    }
}

internal data class EmojiSection(val category: EmojiCategory, val emoji: List<String>)

internal class EmojiCategory(
    val key: String,
    /** The picture on its tab. */
    val mark: String,
    private val en: String,
    private val fa: String,
    private val tr: String,
) {
    fun title(language: Language): String = when (language) {
        Language.EN -> en
        Language.FA -> fa
        Language.TR -> tr
    }
}

/**
 * The catalogue, by category, in the order the system keyboards use.
 *
 * Only what this phone can draw is offered: a picture newer than the
 * device's emoji font would show as an empty box, which is worse than not
 * being there. Flags are left out — several large OEMs remove them from the
 * font, and a support reply has no use for one.
 */
internal object EmojiCatalog {

    val RECENT = EmojiCategory("recent", "🕘", "Recent", "اخیر", "Son kullanılanlar")

    private val SMILEYS = EmojiCategory("smileys", "😀", "Smileys", "شکلک‌ها", "İfadeler")
    private val PEOPLE = EmojiCategory("people", "👋", "People & gestures", "دست‌ها و آدم‌ها", "İnsanlar ve hareketler")
    private val HEARTS = EmojiCategory("hearts", "❤️", "Hearts & symbols", "قلب‌ها و نمادها", "Kalpler ve semboller")
    private val NATURE = EmojiCategory("nature", "🐶", "Animals & nature", "حیوانات و طبیعت", "Hayvanlar ve doğa")
    private val FOOD = EmojiCategory("food", "🍔", "Food & drink", "خوراکی", "Yiyecek ve içecek")
    private val ACTIVITY = EmojiCategory("activity", "⚽", "Activities & travel", "سرگرمی و سفر", "Etkinlik ve seyahat")
    private val OBJECTS = EmojiCategory("objects", "💡", "Objects", "اشیا", "Nesneler")

    private fun split(value: String): List<String> = value.split(' ').filter { it.isNotBlank() }.distinct()

    private val raw: List<Pair<EmojiCategory, List<String>>> = listOf(
        SMILEYS to split(
            "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 " +
                "🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 " +
                "🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 " +
                "😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾",
        ),
        PEOPLE to split(
            "👋 🤚 🖐️ ✋ 🖖 🫱 🫲 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 " +
                "👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🧠 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 " +
                "💁 🙋 🧏 🙇 🤦 🤷 🧑‍💻 👨‍💻 👩‍💻 🧑‍💼 👨‍💼 👩‍💼 🧑‍🔧 🧑‍🏫 🧑‍⚕️ 🕵️ 💂 👷 🤵 👰 🧑‍🎓 🏃 🚶 💃 🕺 👯 🧘 " +
                "👪 👫 👬 👭 🗣️ 👤 👥",
        ),
        HEARTS to split(
            "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 ❤️‍🔥 ❤️‍🩹 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💯 💢 💥 💫 💦 💨 🕳️ 💬 👁️‍🗨️ " +
                "🗨️ 🗯️ 💭 💤 ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❕ ❗ 〰️ ⚠️ 🚫 ⛔ 🔞 ♻️ ⭕ 🔴 🟠 🟡 🟢 🔵 🟣 " +
                "⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔔 🔕 🎵 🎶 ➡️ ⬅️ ⬆️ ⬇️ ↩️ ↪️ 🔄 🔝 🆕 🆗 🆒 🆓 ℹ️ 🔟 #️⃣ *️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ " +
                "4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ ©️ ®️ ™️",
        ),
        NATURE to split(
            "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 " +
                "🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🐘 🦒 🐪 🐫 🐎 🐖 🐑 🐐 🦌 🐕 🐈 " +
                "🐓 🦚 🦜 🕊️ 🐇 🐿️ 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍃 🍂 🍁 🍄 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌙 🌎 🌍 " +
                "🌏 🪐 💫 ⭐ 🌟 ✨ ⚡ ☄️ 🔥 🌪️ 🌈 ☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌬️ 💧 🌊",
        ),
        FOOD to split(
            "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 " +
                "🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 " +
                "🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 ☕ 🫖 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 " +
                "🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽️",
        ),
        ACTIVITY to split(
            "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🥅 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 ⛹️ 🤺 🏌️ 🏇 🧘 🏄 🏊 " +
                "🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🚗 🚕 🚙 " +
                "🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🏍️ 🛵 🚲 🛴 🚨 🚔 🚍 🚘 🚖 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🛳️ 🚢 ⚓ 🚧 ⛽ 🚏 " +
                "🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏢 🏬 🏦 🏥 🏨 🏪 🏫 🕌 🕍 ⛪ 🌆 🌃 🌉",
        ),
        OBJECTS to split(
            "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏰ ⏱️ ⏲️ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 " +
                "🕯️ 🧯 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🔪 🛡️ 🔮 🧿 📿 💈 ⚗️ " +
                "🔭 🔬 💊 💉 🩺 🩹 🧬 🌡️ 🧹 🧺 🧻 🚽 🚿 🛁 🧼 🧽 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 " +
                "✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 " +
                "📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 " +
                "🔏 🔐 🔒 🔓",
        ),
    )

    /**
     * What this phone's emoji font can draw, measured once.
     *
     * A font that is merely old loses the newest few; one that "draws
     * nothing" is a measurement that did not work (a stripped ROM's Paint, a
     * test's), and offering nothing would be the worse mistake — so then the
     * whole catalogue stands.
     */
    val sections: List<EmojiSection> by lazy {
        val paint = runCatching { android.graphics.Paint() }.getOrNull()
        val drawable: (String) -> Boolean = { emoji ->
            paint == null || runCatching { paint.hasGlyph(emoji) }.getOrDefault(true)
        }
        val all = raw.sumOf { it.second.size }
        val kept = raw.sumOf { (_, list) -> list.count(drawable) }
        val trust = kept * 2 >= all
        raw.map { (category, list) ->
            EmojiSection(category, if (trust) list.filter(drawable) else list)
        }.filter { it.emoji.isNotEmpty() }
    }
}

/**
 * The text with one whole character before [cursor] removed — an emoji built
 * of several code points (a family, a flag, a skin tone) goes in one press,
 * as it does on the system keyboard.
 */
internal fun deleteBefore(text: String, cursor: Int): Pair<String, Int> {
    val end = cursor.coerceIn(0, text.length)
    if (end == 0) return text to 0
    // ICU's, which knows the emoji sequences; the java.text one on older
    // releases split a family into its members.
    val iterator = android.icu.text.BreakIterator.getCharacterInstance()
    iterator.setText(text)
    val start = iterator.preceding(end).takeIf { it != android.icu.text.BreakIterator.DONE } ?: (end - 1)
    return text.removeRange(start, end) to start
}
