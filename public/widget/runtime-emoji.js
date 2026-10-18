/**
 * Widget Module: emoji keywords
 *
 * The words the emoji picker's search (runtime-late.js, feature
 * `emojiSearch`) finds each emoji by, in English, Persian and Turkish: every
 * emoji of t1's grouped picker (presentation-t1-x.js) and of Core's own list
 * (runtime.js EMOJI_LIST). Loaded only when a visitor first uses the search
 * field (ModuleLoader name `emoji`, `config.modules.emoji`), never for
 * `default` or `intl`. Pure data: no network, no storage.
 *
 * Based on the Unicode CLDR emoji annotations (v48, `cldr-annotations-full`:
 * the names and keywords of en, fa and tr), shortened to the words people
 * search with, Persian reviewed (colloquial words added: مرسی، لایک، بوس).
 * CLDR data: Copyright © 2004-2026 Unicode, Inc., used under the
 * Unicode License v3 (the licence the `cldr-annotations-full` package carries).
 *
 * Public API (window.__gs_mod_emoji):
 *   v      1, the version of this format
 *   list   the emoji, separated by spaces
 *   words  [en, fa, tr]: per language, each emoji's words (separated by
 *          spaces) in the order of `list`, separated by '|'
 */
(function () {
  'use strict';

  window.__gs_mod_emoji = {
    v: 1,
    list: '😍 🙏 👍 😊 😂 ❤️ 🌹 🎉 😀 😁 🤣 😇 🙂 😉 🥰 😘 😋 😎 🤩 🥳 😏 👎 👏 👋 🤝 ✌️ 👌 💪 🙌 🤲 👀 🙋 🤷 💁 🙆 🧡 💛 💚 💙 💜 🤍 🖤 💔 💕 💖 💯 ✨ 🔥 ⭐ ✅ 🌷 🌸 🌻 🍀 🌙 ☀️ 🌈 🐱 🐶 🦋 🐝 🌊 ❄️ 🌿 🍂 ☕ 🍰 🎂 🍫 🍕 🍔 🍎 🍉 🍓 🍇 🍩 🍪 🧁 🍦 🍵 🥤 🤔 😐 😢 😭 😡 😴 🤗 😮 ✋ 🤞 🎁 ⚡ ❌ 💬 📎 📷 📞 ⏰ 😅 🤒',
    words: [
    // English
    'heart eyes love smiling adore|' + // 😍
    'folded hands please thanks pray|' + // 🙏
    'thumbs up like ok good yes|' + // 👍
    'smiling blush happy glad|' + // 😊
    'tears joy laughing funny lol|' + // 😂
    'red heart love|' + // ❤️
    'rose flower love|' + // 🌹
    'party popper celebrate congrats|' + // 🎉
    'grinning happy smile|' + // 😀
    'beaming grin smile teeth|' + // 😁
    'rolling floor laughing|' + // 🤣
    'halo angel innocent|' + // 😇
    'slightly smiling|' + // 🙂
    'winking wink|' + // 😉
    'smiling hearts love adore|' + // 🥰
    'kiss blowing love|' + // 😘
    'yummy delicious tongue|' + // 😋
    'sunglasses cool|' + // 😎
    'star struck excited wow|' + // 🤩
    'party birthday celebrate|' + // 🥳
    'smirking smug|' + // 😏
    'thumbs down dislike bad no|' + // 👎
    'clapping hands applause bravo|' + // 👏
    'waving hand hello hi bye|' + // 👋
    'handshake deal agreement|' + // 🤝
    'victory peace hand|' + // ✌️
    'ok hand perfect|' + // 👌
    'flexed biceps strong muscle|' + // 💪
    'raising hands hooray celebrate|' + // 🙌
    'palms up dua prayer|' + // 🤲
    'eyes look see|' + // 👀
    'raising hand question here|' + // 🙋
    'shrugging dunno whatever|' + // 🤷
    'tipping hand info|' + // 💁
    'ok gesture fine|' + // 🙆
    'orange heart|' + // 🧡
    'yellow heart|' + // 💛
    'green heart|' + // 💚
    'blue heart|' + // 💙
    'purple heart|' + // 💜
    'white heart|' + // 🤍
    'black heart|' + // 🖤
    'broken heart sad|' + // 💔
    'two hearts love|' + // 💕
    'sparkling heart|' + // 💖
    'hundred points 100 perfect|' + // 💯
    'sparkles magic shine|' + // ✨
    'fire hot lit|' + // 🔥
    'star|' + // ⭐
    'check mark done yes|' + // ✅
    'tulip flower|' + // 🌷
    'cherry blossom flower spring|' + // 🌸
    'sunflower flower|' + // 🌻
    'four leaf clover luck|' + // 🍀
    'crescent moon night|' + // 🌙
    'sun sunny weather|' + // ☀️
    'rainbow|' + // 🌈
    'cat kitten|' + // 🐱
    'dog puppy|' + // 🐶
    'butterfly|' + // 🦋
    'bee honeybee|' + // 🐝
    'wave ocean sea water|' + // 🌊
    'snowflake snow cold winter|' + // ❄️
    'herb leaf plant|' + // 🌿
    'fallen leaf autumn|' + // 🍂
    'hot coffee tea drink|' + // ☕
    'cake shortcake dessert|' + // 🍰
    'birthday cake|' + // 🎂
    'chocolate bar|' + // 🍫
    'pizza|' + // 🍕
    'hamburger burger|' + // 🍔
    'red apple fruit|' + // 🍎
    'watermelon fruit|' + // 🍉
    'strawberry fruit|' + // 🍓
    'grapes fruit|' + // 🍇
    'doughnut donut|' + // 🍩
    'cookie|' + // 🍪
    'cupcake|' + // 🧁
    'ice cream|' + // 🍦
    'tea cup green|' + // 🍵
    'cup straw drink soda|' + // 🥤
    'thinking hmm|' + // 🤔
    'neutral meh|' + // 😐
    'crying sad tear|' + // 😢
    'loudly crying sob|' + // 😭
    'angry enraged mad|' + // 😡
    'sleeping tired zzz|' + // 😴
    'hug hugging|' + // 🤗
    'open mouth surprised wow|' + // 😮
    'raised hand stop high five|' + // ✋
    'crossed fingers luck hope|' + // 🤞
    'gift present|' + // 🎁
    'lightning high voltage zap|' + // ⚡
    'cross mark no cancel wrong|' + // ❌
    'speech balloon message chat|' + // 💬
    'paperclip attach|' + // 📎
    'camera photo|' + // 📷
    'telephone phone call|' + // 📞
    'alarm clock time|' + // ⏰
    'sweat smile nervous|' + // 😅
    'sick ill thermometer fever', // 🤒
    // Persian
    'عاشق عشق قلب چشم لبخند|' + // 😍
    'ممنون مرسی تشکر سپاس خواهش لطفا دعا|' + // 🙏
    'لایک پسندیدن شست اوکی خوب عالی باشه|' + // 👍
    'لبخند خوشحال خجالتی|' + // 😊
    'خنده اشک شوق خنده‌دار قهقهه|' + // 😂
    'قلب قرمز عشق دوست دارم|' + // ❤️
    'گل رز عشق|' + // 🌹
    'جشن تبریک مبارک|' + // 🎉
    'خنده خوشحال لبخند نیش باز|' + // 😀
    'خنده دندان نیشخند لبخند|' + // 😁
    'غش خنده روده‌بر قهقهه|' + // 🤣
    'فرشته معصوم هاله|' + // 😇
    'لبخند ملایم|' + // 🙂
    'چشمک|' + // 😉
    'عاشق دوستت دارم قلب|' + // 🥰
    'بوس بوسه|' + // 😘
    'خوشمزه به‌به زبان|' + // 😋
    'عینک آفتابی باحال خفن|' + // 😎
    'هیجان‌زده ستاره فوق‌العاده|' + // 🤩
    'جشن تولد مهمانی هورا|' + // 🥳
    'پوزخند|' + // 😏
    'دیسلایک نپسندیدن شست پایین بد|' + // 👎
    'دست زدن تشویق آفرین براوو|' + // 👏
    'سلام خداحافظ دست تکان|' + // 👋
    'دست دادن قرار توافق|' + // 🤝
    'پیروزی صلح دست|' + // ✌️
    'اوکی باشه عالی|' + // 👌
    'بازو قوی عضله زور|' + // 💪
    'هورا دست بالا جشن|' + // 🙌
    'دعا دست نیایش|' + // 🤲
    'چشم نگاه دیدن|' + // 👀
    'دست بالا سوال من|' + // 🙋
    'شانه بالا انداختن نمی‌دانم|' + // 🤷
    'اطلاعات راهنما|' + // 💁
    'اوکی باشه|' + // 🙆
    'قلب نارنجی|' + // 🧡
    'قلب زرد|' + // 💛
    'قلب سبز|' + // 💚
    'قلب آبی|' + // 💙
    'قلب بنفش|' + // 💜
    'قلب سفید|' + // 🤍
    'قلب سیاه|' + // 🖤
    'قلب شکسته دل ناراحت|' + // 💔
    'دو قلب عشق|' + // 💕
    'قلب درخشان|' + // 💖
    'صد ۱۰۰ کامل امتیاز|' + // 💯
    'درخشش برق جادو|' + // ✨
    'آتش داغ شعله|' + // 🔥
    'ستاره|' + // ⭐
    'تیک تأیید انجام شد درست|' + // ✅
    'لاله گل|' + // 🌷
    'شکوفه گیلاس گل بهار|' + // 🌸
    'آفتابگردان گل|' + // 🌻
    'شبدر چهاربرگ شانس|' + // 🍀
    'ماه هلال شب|' + // 🌙
    'خورشید آفتاب|' + // ☀️
    'رنگین کمان|' + // 🌈
    'گربه پیشی|' + // 🐱
    'سگ توله|' + // 🐶
    'پروانه|' + // 🦋
    'زنبور عسل|' + // 🐝
    'موج دریا اقیانوس آب|' + // 🌊
    'برف دانه سرما زمستان|' + // ❄️
    'گیاه برگ سبزی|' + // 🌿
    'برگ پاییز|' + // 🍂
    'قهوه چای نوشیدنی داغ|' + // ☕
    'کیک شیرینی دسر|' + // 🍰
    'کیک تولد مبارک|' + // 🎂
    'شکلات|' + // 🍫
    'پیتزا|' + // 🍕
    'همبرگر برگر|' + // 🍔
    'سیب میوه|' + // 🍎
    'هندوانه میوه|' + // 🍉
    'توت‌فرنگی میوه|' + // 🍓
    'انگور میوه|' + // 🍇
    'دونات|' + // 🍩
    'کلوچه کوکی|' + // 🍪
    'کاپ‌کیک کیک فنجانی|' + // 🧁
    'بستنی|' + // 🍦
    'چای فنجان سبز|' + // 🍵
    'نوشابه نی لیوان نوشیدنی|' + // 🥤
    'فکر کردن متفکر|' + // 🤔
    'خنثی بی‌حالت|' + // 😐
    'گریه ناراحت غمگین اشک|' + // 😢
    'زار زدن گریه اشک|' + // 😭
    'عصبانی خشمگین|' + // 😡
    'خواب خسته شب بخیر|' + // 😴
    'بغل آغوش|' + // 🤗
    'تعجب شگفت‌زده|' + // 😮
    'دست بالا ایست بزن قدش|' + // ✋
    'انگشت ضربدری شانس امید|' + // 🤞
    'هدیه کادو|' + // 🎁
    'برق صاعقه ولتاژ|' + // ⚡
    'ضربدر نه لغو غلط|' + // ❌
    'پیام گفتگو حباب|' + // 💬
    'گیره کاغذ پیوست|' + // 📎
    'دوربین عکس|' + // 📷
    'تلفن تماس گوشی|' + // 📞
    'ساعت زنگ‌دار زمان|' + // ⏰
    'عرق خنده استرس|' + // 😅
    'مریض بیمار تب دماسنج', // 🤒
    // Turkish
    'kalp gözlü aşk gülümseme|' + // 😍
    'birleşen eller teşekkür lütfen dua|' + // 🙏
    'baş parmak beğen tamam iyi evet|' + // 👍
    'gülümseyen mutlu utangaç|' + // 😊
    'sevinç gözyaşı gülmek komik kahkaha|' + // 😂
    'kırmızı kalp aşk sevgi|' + // ❤️
    'gül çiçek aşk|' + // 🌹
    'parti kutlama tebrik konfeti|' + // 🎉
    'sırıtan gülen mutlu|' + // 😀
    'sırıtma gülen dişler|' + // 😁
    'yerlere yatma gülmek kahkaha|' + // 🤣
    'hare melek masum|' + // 😇
    'hafif gülümseyen|' + // 🙂
    'göz kırpan|' + // 😉
    'kalpli gülümseyen aşık sevgi|' + // 🥰
    'öpücük gönderen|' + // 😘
    'lezzetli nefis dil|' + // 😋
    'güneş gözlüğü havalı|' + // 😎
    'yıldız çarpmış heyecanlı|' + // 🤩
    'parti doğum günü kutlama|' + // 🥳
    'sinsi gülümseme imalı|' + // 😏
    'baş parmak aşağı beğenme kötü|' + // 👎
    'alkış el çırpma bravo tebrik|' + // 👏
    'el sallama merhaba selam güle|' + // 👋
    'el sıkışma anlaşma|' + // 🤝
    'zafer barış eli|' + // ✌️
    'tamam mükemmel|' + // 👌
    'pazı güçlü kas|' + // 💪
    'eller havaya kutlama|' + // 🙌
    'avuç açık dua|' + // 🤲
    'gözler bakmak|' + // 👀
    'el kaldıran soru ben|' + // 🙋
    'omuz silkme bilmiyorum|' + // 🤷
    'bilgi elini yana|' + // 💁
    'tamam hareketi|' + // 🙆
    'turuncu kalp|' + // 🧡
    'sarı kalp|' + // 💛
    'yeşil kalp|' + // 💚
    'mavi kalp|' + // 💙
    'mor kalp|' + // 💜
    'beyaz kalp|' + // 🤍
    'siyah kalp|' + // 🖤
    'kırık kalp üzgün|' + // 💔
    'iki kalp aşk|' + // 💕
    'pırıltılı kalp|' + // 💖
    'yüz puan mükemmel|' + // 💯
    'parıltı sihir|' + // ✨
    'ateş alev sıcak|' + // 🔥
    'yıldız|' + // ⭐
    'onay işareti tamam|' + // ✅
    'lale çiçek|' + // 🌷
    'kiraz çiçeği bahar|' + // 🌸
    'ayçiçeği çiçek|' + // 🌻
    'dört yapraklı yonca şans|' + // 🍀
    'hilal ay gece|' + // 🌙
    'güneş güneşli|' + // ☀️
    'gökkuşağı|' + // 🌈
    'kedi|' + // 🐱
    'köpek|' + // 🐶
    'kelebek|' + // 🦋
    'arı bal|' + // 🐝
    'dalga deniz okyanus|' + // 🌊
    'kar tanesi soğuk kış|' + // ❄️
    'ot yaprak bitki|' + // 🌿
    'yaprak sonbahar|' + // 🍂
    'kahve çay sıcak içecek|' + // ☕
    'pasta dilim tatlı|' + // 🍰
    'doğum günü pastası|' + // 🎂
    'çikolata|' + // 🍫
    'pizza|' + // 🍕
    'hamburger|' + // 🍔
    'elma meyve|' + // 🍎
    'karpuz meyve|' + // 🍉
    'çilek meyve|' + // 🍓
    'üzüm meyve|' + // 🍇
    'donut|' + // 🍩
    'kurabiye|' + // 🍪
    'kapkek|' + // 🧁
    'dondurma|' + // 🍦
    'çay fincanı yeşil|' + // 🍵
    'bardak pipet içecek|' + // 🥤
    'düşünen düşünme|' + // 🤔
    'nötr ifadesiz|' + // 😐
    'ağlayan üzgün gözyaşı|' + // 😢
    'hüngür ağlayan gözyaşı|' + // 😭
    'kızgın öfkeli|' + // 😡
    'uyuyan uykulu iyi geceler|' + // 😴
    'sarılma kucaklama|' + // 🤗
    'şaşkın ağzı açık|' + // 😮
    'el kaldırma dur beşlik|' + // ✋
    'çapraz parmak şans umut|' + // 🤞
    'hediye paket|' + // 🎁
    'şimşek yıldırım voltaj|' + // ⚡
    'çarpı hayır iptal yanlış|' + // ❌
    'konuşma balonu mesaj sohbet|' + // 💬
    'ataş ek|' + // 📎
    'kamera fotoğraf|' + // 📷
    'telefon arama|' + // 📞
    'çalar saat zaman|' + // ⏰
    'terli gülen gergin|' + // 😅
    'hasta ateş termometre', // 🤒
    ],
  };
})();
