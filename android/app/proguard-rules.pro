# R8, for a release build that behaves like the debug one.
#
# Most of what this app depends on ships its own consumer rules inside its
# artifact — Ktor, Coil, LiveKit and the Compose runtime all do — so what is
# here is only what R8 cannot work out from this app's own code.

# MARK: - kotlinx.serialization
#
# The models are decoded by NAME from JSON, and R8 has no way to know that:
# nothing in the app ever writes `Conversation::class.java.getField("subject")`.
# Obfuscating the field names turns every response into a model of nulls —
# which does not crash, and is far worse than crashing, because the app then
# shows an inbox of blank rows and blames the server.
-keepclassmembers,allowobfuscation class com.webyar.operator.core.model.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class com.webyar.operator.core.model.** {
    public static ** INSTANCE;
}
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisible*Annotations

# The generated serializers themselves, which are referenced only from the
# annotation the plugin writes.
-if @kotlinx.serialization.Serializable class com.webyar.operator.core.model.**
-keepclassmembers class com.webyar.operator.core.model.<1>$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}

# Enum entries are matched against wire strings by `entries.firstOrNull`, so
# the CONSTANTS are read by name at runtime even where the class is not.
-keepclassmembers enum com.webyar.operator.core.model.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# MARK: - WebRTC
#
# Every one of these is instantiated or called from C++, which R8 cannot see.
# LiveKit ships rules for its own classes; the WebRTC layer underneath it is
# a separate artifact and does not.
-keep class livekit.org.webrtc.** { *; }
-keep class com.twilio.audioswitch.** { *; }
-dontwarn livekit.org.webrtc.**

# MARK: - The rest
#
# R8 warns about compile-only annotations it can see references to and no
# class for. None of them exist at runtime.
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
