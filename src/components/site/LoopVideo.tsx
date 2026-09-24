import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  poster: string;
  title: string;
  className?: string;
  width?: number;
  height?: number;
};

/**
 * ویدیوی تزئینی لوپ، بهینه برای سرعت و Core Web Vitals:
 * - فایل فقط وقتی نزدیک دید کاربر است بارگذاری می‌شود (preload=none)
 * - بیرون از دید متوقف می‌شود تا CPU/باتری مصرف نشود
 * - با «کاهش حرکت» سیستم فقط تصویر پوستر نمایش داده می‌شود
 */
export function LoopVideo({ src, poster, title, className, width, height }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const preferredSrc = src.replace(/\.mp4(?:\?.*)?$/i, ".webm");

  const tryPlay = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = true;
    el.defaultMuted = true;
    void el.play().catch(() => {
      // Some browsers defer autoplay until the page becomes active or receives
      // the first interaction. The listeners below retry without showing controls.
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldLoad(true);
          tryPlay();
        } else {
          el.pause();
        }
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [tryPlay]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !shouldLoad) return;
    el.preload = "auto";
    el.load();
    tryPlay();

    const resume = () => tryPlay();
    const resumeWhenVisible = () => {
      if (document.visibilityState === "visible") tryPlay();
    };
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resumeWhenVisible);
    document.addEventListener("pointerdown", resume, { once: true });
    document.addEventListener("touchstart", resume, { once: true, passive: true });
    return () => {
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resumeWhenVisible);
      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("touchstart", resume);
    };
  }, [shouldLoad, tryPlay]);

  return (
    <video
      ref={ref}
      poster={poster}
      title={title}
      aria-label={title}
      width={width}
      height={height}
      autoPlay
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      disableRemotePlayback
      controlsList="nodownload nofullscreen noremoteplayback"
      className={className}
      onCanPlay={tryPlay}
      onLoadedData={tryPlay}
    >
      <source src={preferredSrc} type="video/webm" />
      <source src={src} type="video/mp4" />
    </video>
  );
}
