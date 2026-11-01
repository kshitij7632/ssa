import { useEffect, useRef, useState } from "react";
import mobileVideoUrl from "@/assets/hero-nail-reveal-mobile.mp4";
import desktopVideoUrl from "@/assets/hero-nail-reveal-desktop.mp4";
import posterUrl from "@/assets/hero-poster.jpg";

/**
 * Fallback URLs if imported assets are unavailable
 */
const FALLBACK_MOBILE_VIDEO = "/videos/hero-nail-reveal-mobile.mp4";
const FALLBACK_DESKTOP_VIDEO = "/videos/hero-nail-reveal-desktop.mp4";
const FALLBACK_POSTER = "/videos/hero-poster.jpg";

/**
 * Calculates dynamic focal point keeping all critical moments framed
 * across narrow phones (9:19.5), portrait tablets (3:4), and landscape displays (16:9):
 * - 0%–22%: Bottle & branding on the pedestal
 * - 22%–45%: Hand lifting the gold cap & brush emerging
 * - 45%–76%: Brush gliding burgundy polish onto the nail
 * - 76%–100%: Finished 5-finger manicure resting on the pedestal
 */
function getFocalPosition(p: number, width: number, height: number): string {
  const aspectRatio = width / (height || 1);

  // Narrow mobile (e.g. 375x812, 390x844, 430x932 - aspect ratio <= 0.62)
  // The 9:16 vertical video naturally fills the mobile screen width with minimal vertical cropping.
  if (aspectRatio <= 0.62) {
    if (p < 0.22) return "50% 52%";
    if (p < 0.45) {
      const t = (p - 0.22) / 0.23;
      return `50% ${Math.round((52 - t * 4) * 10) / 10}%`; // subtle shift 52% -> 48%
    }
    if (p < 0.76) {
      const t = (p - 0.45) / 0.31;
      return `50% ${Math.round((48 + t * 4) * 10) / 10}%`; // 48% -> 52%
    }
    return "50% 53%";
  }

  // Portrait tablet (e.g. 768x1024, 820x1180 - aspect ratio 0.62 to 0.95)
  // Video fills height with slight lateral crop. Subtle vertical tracking keeps action centered.
  if (aspectRatio < 0.95) {
    if (p < 0.22) return "50% 53%";
    if (p < 0.45) {
      const t = (p - 0.22) / 0.23;
      return `50% ${Math.round((53 - t * 10) * 10) / 10}%`; // 53% -> 43%
    }
    if (p < 0.76) {
      const t = (p - 0.45) / 0.31;
      return `50% ${Math.round((43 + t * 8) * 10) / 10}%`; // 43% -> 51%
    }
    return "50% 54%";
  }

  // Widescreen & landscape tablet/desktop (aspect ratio >= 0.95)
  // Video fills width and crops top/bottom. Vertical panning follows the hero action.
  let y = 52;
  if (p < 0.22) {
    y = 54;
  } else if (p < 0.44) {
    const t = (p - 0.22) / 0.22;
    y = 54 - t * 17; // 54% -> 37% (follow cap & brush)
  } else if (p < 0.75) {
    const t = (p - 0.44) / 0.31;
    y = 37 + t * 12; // 37% -> 49% (follow nail application)
  } else {
    const t = (p - 0.75) / 0.25;
    y = 49 + t * 7; // 49% -> 56% (finished hand & pedestal)
  }

  return `50% ${Math.round(y * 10) / 10}%`;
}

/**
 * Mobile-First Scroll-Synchronized Hero Video Component.
 *
 * Key features:
 * - Mobile-first video stream (720x1280, dense keyframes, faststart, no B-frames).
 * - Desktop high-bitrate video stream (1080x1920, faststart).
 * - Decoupled rAF seek loop: eliminates seek locks and outdated frame queues.
 * - Hardware watchdog: recovers gracefully if mobile decoder stalls or drops seeked events.
 * - Device-calibrated ScrollTrigger distances and touch responsiveness.
 */
export function ScrollRevealHero() {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);

  const [reducedMotion, setReducedMotion] = useState(false);
  const [selectedVideoSrc, setSelectedVideoSrc] = useState<string>(
    mobileVideoUrl || FALLBACK_MOBILE_VIDEO
  );
  const [isLoaded, setIsLoaded] = useState(false);

  // Determine optimal video stream for the current device
  useEffect(() => {
    if (typeof window === "undefined") return;

    const isDesktop = window.innerWidth >= 1024 && !("ontouchstart" in window);
    const chosenSrc = isDesktop
      ? desktopVideoUrl || FALLBACK_DESKTOP_VIDEO
      : mobileVideoUrl || FALLBACK_MOBILE_VIDEO;

    setSelectedVideoSrc(chosenSrc);
  }, []);

  // Check prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Main scroll-controlled scrubbing timeline
  useEffect(() => {
    if (reducedMotion) return;

    let killed = false;
    let cleanupGsap: (() => void) | null = null;
    let rafId: number | null = null;

    const video = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;

    // Prevent any stray automatic play events from advancing video unprompted
    const onStrayPlay = () => {
      video.pause();
    };
    video.addEventListener("play", onStrayPlay);

    // =========================================================================
    // HIGH-PERFORMANCE DECOUPLED SEEK CONTROLLER (Priority-Queue, Non-Blocking)
    // =========================================================================
    const targetTimeRef = { current: 0 };
    const isSeekingRef = { current: false };
    const seekStartTimeRef = { current: 0 };
    const currentProgressRef = { current: 0 };
    const stallDetectorRef = { current: { startTime: 0, lastCheckTime: 0 } };

    const onSeeked = () => {
      isSeekingRef.current = false;
    };
    video.addEventListener("seeked", onSeeked);

    // Continuous render loop synchronizes targetTime with the video hardware decoder
    const renderLoop = () => {
      if (killed) return;

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 7.96;
      const target = Math.max(0, Math.min(duration, targetTimeRef.current));
      const now = performance.now();

      // Watchdog 1: Auto-release seek lock if mobile browser fails to fire 'seeked' within 85ms
      if (isSeekingRef.current && now - seekStartTimeRef.current > 85) {
        isSeekingRef.current = false;
      }

      // Execute seek if video is ready and delta is meaningful (> 25ms)
      if (video.readyState >= 1 && !isSeekingRef.current) {
        const delta = Math.abs(video.currentTime - target);
        if (delta > 0.025) {
          isSeekingRef.current = true;
          seekStartTimeRef.current = now;

          // Prefer fastSeek on browsers that support it (instant keyframe targeting on mobile)
          if ("fastSeek" in video && typeof (video as any).fastSeek === "function") {
            try {
              (video as any).fastSeek(target);
            } catch {
              video.currentTime = target;
            }
          } else {
            video.currentTime = target;
          }
        }
      }

      // Watchdog 2: Anti-Stall Fallback
      // If user has scrolled past bottle opening (progress > 0.25) but video remains pinned
      // below 1.5s for > 450ms, force jump to prevent being stuck on opening scene.
      if (currentProgressRef.current > 0.25 && video.currentTime < 1.45) {
        if (!stallDetectorRef.current.startTime) {
          stallDetectorRef.current.startTime = now;
        } else if (now - stallDetectorRef.current.startTime > 450) {
          // Force recovery
          isSeekingRef.current = false;
          try {
            video.currentTime = target;
          } catch {
            // ignore
          }
          stallDetectorRef.current.startTime = 0;
        }
      } else {
        stallDetectorRef.current.startTime = 0;
      }

      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);

    // =========================================================================
    // GSAP SCROLLTRIGGER SETUP
    // =========================================================================
    (async () => {
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      if (killed) return;

      gsap.registerPlugin(ScrollTrigger);

      // Prevent mobile address bar show/hide from thrashing scroll metrics
      ScrollTrigger.config({ ignoreMobileResize: true });

      // Prime video and ensure metadata is accessible
      await new Promise<void>((resolve) => {
        if (video.readyState >= 1) return resolve();
        const onLoaded = () => {
          setIsLoaded(true);
          resolve();
        };
        video.addEventListener("loadedmetadata", onLoaded, { once: true });
        video.addEventListener("loadeddata", onLoaded, { once: true });
        video.addEventListener("canplay", onLoaded, { once: true });
        video.addEventListener("error", () => resolve(), { once: true });
      });
      if (killed) return;

      setIsLoaded(true);
      video.pause();

      const duration =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 7.96;

      const initialWidth = window.innerWidth;
      const initialHeight = window.innerHeight;
      video.style.objectPosition = getFocalPosition(0, initialWidth, initialHeight);

      // Device-calibrated scroll distances and scrub smoothing:
      // Mobile: shorter pin (170%), snappy scrub (0.1s) for responsive 1:1 finger tracking
      // Tablet: balanced pin (220%), gentle scrub (0.22s)
      // Desktop: cinematic pin (280%), silky scrub (0.45s)
      const isMobile = initialWidth < 640;
      const isTablet = initialWidth >= 640 && initialWidth < 1024;

      const endDistance = isMobile ? "+=170%" : isTablet ? "+=220%" : "+=280%";
      const scrubSmoothing = isMobile ? 0.1 : isTablet ? 0.22 : 0.45;

      const playhead = { time: 0 };

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: "top top",
          end: endDistance,
          pin: true,
          pinSpacing: true,
          anticipatePin: 1,
          scrub: scrubSmoothing,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const p = self.progress;
            currentProgressRef.current = p;
            video.style.objectPosition = getFocalPosition(p, window.innerWidth, window.innerHeight);
          },
        },
      });

      // Synchronize video playhead from 0 to full duration
      tl.to(
        playhead,
        {
          time: duration,
          ease: "none",
          duration: duration,
          onUpdate: () => {
            targetTimeRef.current = playhead.time;
          },
        },
        0
      );

      // Scroll prompt disappears promptly on initial scroll
      if (hintRef.current) {
        tl.to(
          hintRef.current,
          { opacity: 0, y: 15, duration: 0.5, ease: "power1.out" },
          0
        );
      }

      // Title lifts and dissolves as bottle opens (progress 0.12 to 0.32)
      if (titleRef.current) {
        tl.to(
          titleRef.current,
          {
            opacity: 0,
            y: isMobile ? -30 : -45,
            duration: 1.0,
            ease: "power1.in",
          },
          duration * 0.12
        );
      }

      // CTA overlay rises over the finished manicure (final 22%)
      if (ctaRef.current) {
        tl.fromTo(
          ctaRef.current,
          { opacity: 0, y: 25, pointerEvents: "none" },
          {
            opacity: 1,
            y: 0,
            pointerEvents: "auto",
            duration: 1.1,
            ease: "power2.out",
          },
          duration * 0.78
        );
      }

      ScrollTrigger.refresh();

      // Viewport resize handler with width check (avoids address-bar height churn)
      let prevWidth = window.innerWidth;
      const handleResize = () => {
        if (Math.abs(window.innerWidth - prevWidth) > 30) {
          prevWidth = window.innerWidth;
          ScrollTrigger.refresh();
        }
      };
      window.addEventListener("resize", handleResize);

      // Orientation change handler for tablets and phones
      const handleOrientation = () => {
        setTimeout(() => {
          ScrollTrigger.refresh();
        }, 150);
      };
      window.addEventListener("orientationchange", handleOrientation);

      cleanupGsap = () => {
        window.removeEventListener("resize", handleResize);
        window.removeEventListener("orientationchange", handleOrientation);
        tl.scrollTrigger?.kill();
        tl.kill();
      };
    })();

    return () => {
      killed = true;
      if (rafId) cancelAnimationFrame(rafId);
      video.removeEventListener("play", onStrayPlay);
      video.removeEventListener("seeked", onSeeked);
      cleanupGsap?.();
    };
  }, [reducedMotion, selectedVideoSrc]);

  // Reduced motion alternative: static full-screen presentation
  if (reducedMotion) {
    return (
      <section
        className="relative h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-[var(--ivory)]"
        aria-label="Hero"
      >
        <video
          src={selectedVideoSrc}
          poster={posterUrl || FALLBACK_POSTER}
          muted
          playsInline
          controls
          className="absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition: "50% 50%" }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20 pointer-events-none" />
        <div className="absolute inset-0 grain pointer-events-none" />
        <HeroHeader />

        <div className="absolute inset-x-0 top-[12vh] md:top-[15vh] z-20 text-center px-6 pointer-events-none">
          <p className="text-[10px] md:text-xs uppercase tracking-[0.45em] text-[var(--burgundy)] mb-3 drop-shadow-sm font-medium">
            Salon · Academy · Est. 2014
          </p>
          <h1 className="font-display text-[clamp(2.4rem,8vw,7.5rem)] leading-[0.92] text-balance">
            Art You <em className="not-italic text-[var(--burgundy)]">Wear.</em>
          </h1>
        </div>

        <div className="absolute inset-x-0 bottom-8 md:bottom-12 z-30 flex flex-col items-center gap-3 md:gap-4 px-6">
          <p className="text-xs md:text-base text-foreground/90 max-w-md text-center font-serif drop-shadow-sm">
            Premium nail artistry, beauty & academy training — couture precision.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <a href="#contact" className="hero-cta-primary shadow-xl">Book Appointment</a>
            <a href="#academy" className="hero-cta-secondary backdrop-blur-md bg-white/60 shadow-md">Explore Academy</a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      className="relative h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-[var(--ivory)] select-none"
      aria-label="Hero"
    >
      {/* Full-screen edge-to-edge luxury video stage */}
      <video
        ref={videoRef}
        src={selectedVideoSrc}
        poster={posterUrl || FALLBACK_POSTER}
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 will-change-[object-position] select-none ${
          isLoaded ? "opacity-100" : "opacity-95"
        }`}
        style={{ objectPosition: "50% 52%" }}
      />

      {/* Subtle luxury vignette and film grain */}
      <div className="absolute inset-0 bg-gradient-to-b from-[var(--ivory)]/45 via-transparent to-[var(--ivory)]/50 pointer-events-none z-10" />
      <div className="absolute inset-0 grain pointer-events-none z-10" />

      {/* Persistent luxury header */}
      <HeroHeader />

      {/* Main hero typography overlay — mobile calibrated */}
      <div
        ref={titleRef}
        className="absolute inset-x-0 top-[13vh] sm:top-[14vh] md:top-[16vh] z-20 text-center px-4 sm:px-6 pointer-events-none will-change-transform"
      >
        <p className="text-[9px] sm:text-[10px] md:text-xs uppercase tracking-[0.4em] sm:tracking-[0.45em] text-[var(--burgundy)] font-medium mb-2.5 sm:mb-4">
          Salon · Academy · Est. 2014
        </p>
        <h1 className="font-display text-[clamp(2.35rem,8.5vw,7.8rem)] leading-[0.92] text-balance drop-shadow-sm">
          Art You <em className="not-italic text-[var(--burgundy)]">Wear.</em>
        </h1>
        <p className="text-[10px] sm:text-[11px] md:text-xs uppercase tracking-[0.25em] sm:tracking-[0.3em] text-foreground/75 mt-2.5 sm:mt-3 font-sans">
          The Haute Burgundy Ritual
        </p>
      </div>

      {/* Scroll indicator prompt */}
      <div
        ref={hintRef}
        className="absolute bottom-5 sm:bottom-6 md:bottom-8 left-1/2 -translate-x-1/2 z-20 text-[9px] md:text-[10px] uppercase tracking-[0.35em] sm:tracking-[0.4em] text-foreground/70 pointer-events-none flex flex-col items-center gap-2 will-change-transform"
      >
        <span>Scroll to Reveal</span>
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--burgundy)] animate-pulse" />
      </div>

      {/* CTA overlay — revealed smoothly over the finished manicure */}
      <div
        ref={ctaRef}
        className="absolute inset-x-0 bottom-6 sm:bottom-8 md:bottom-12 z-30 flex flex-col items-center gap-3 md:gap-4 px-5 sm:px-6 will-change-transform pointer-events-none"
        style={{ opacity: 0 }}
      >
        <p className="text-xs sm:text-sm md:text-base text-foreground/95 max-w-md text-center font-serif drop-shadow-sm px-2">
          Premium nail artistry, beauty & academy training — couture precision.
        </p>
        <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3 w-full sm:w-auto max-w-xs sm:max-w-none justify-center">
          <a
            href="#contact"
            className="hero-cta-primary shadow-xl text-center py-3 sm:py-3.5 px-6 min-h-[44px] flex items-center justify-center text-xs tracking-wider font-medium"
          >
            Book Appointment
          </a>
          <a
            href="#academy"
            className="hero-cta-secondary backdrop-blur-md bg-white/70 shadow-md text-center py-3 sm:py-3.5 px-6 min-h-[44px] flex items-center justify-center text-xs tracking-wider font-medium"
          >
            Explore Academy
          </a>
        </div>
      </div>
    </section>
  );
}

function HeroHeader() {
  return (
    <header className="absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-4 sm:px-6 md:px-12 py-4 sm:py-5 md:py-6">
      <a
        href="/"
        className="font-display text-xl sm:text-2xl tracking-wider hover:opacity-85 transition"
      >
        Srishti<span className="text-[var(--burgundy)] font-serif font-bold">.</span>
      </a>
      <nav className="hidden md:flex gap-8 lg:gap-10 text-[11px] uppercase tracking-[0.25em] text-foreground/75 font-medium">
        <a href="#showcase" className="hover:text-[var(--burgundy)] transition">
          Work
        </a>
        <a href="#about" className="hover:text-[var(--burgundy)] transition">
          The House
        </a>
        <a href="#services" className="hover:text-[var(--burgundy)] transition">
          Services
        </a>
        <a href="#academy" className="hover:text-[var(--burgundy)] transition">
          Academy
        </a>
        <a href="#contact" className="hover:text-[var(--burgundy)] transition">
          Contact
        </a>
      </nav>
      <a
        href="#contact"
        className="text-[10px] sm:text-xs uppercase tracking-[0.2em] sm:tracking-[0.25em] border-b border-[var(--burgundy)] text-[var(--burgundy)] pb-0.5 hover:opacity-75 transition font-medium"
      >
        Book Atelier
      </a>
    </header>
  );
}
