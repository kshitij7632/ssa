import { useEffect, useRef, useState, useCallback } from "react";

const TOTAL_FRAMES = 36;

type DeviceTier = "mobile" | "tablet" | "desktop";

function getDeviceTier(width: number): DeviceTier {
  if (width < 640) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

function getFrameUrl(tier: DeviceTier, index: number): string {
  const padded = String(index).padStart(2, "0");
  return `/hero-frames/${tier}/frame_${padded}.webp`;
}

function getPosterUrl(tier: DeviceTier): string {
  return `/hero-frames/poster-${tier}.webp`;
}

/**
 * Calculates dynamic focal point keeping all critical moments framed
 * across narrow phones (9:19.5), portrait tablets (3:4), and landscape displays (16:9):
 * - 0%–22%: Bottle & branding on the pedestal
 * - 22%–45%: Hand lifting the gold cap & brush emerging
 * - 45%–76%: Brush gliding burgundy polish onto the nail
 * - 76%–100%: Finished 5-finger manicure resting on the pedestal
 */
function getFocalCoordinates(p: number, width: number, height: number): { x: number; y: number } {
  const aspectRatio = width / (height || 1);

  // Narrow mobile (e.g. 375x812, 390x844, 430x932 - aspect ratio <= 0.62)
  if (aspectRatio <= 0.62) {
    if (p < 0.22) return { x: 0.5, y: 0.52 };
    if (p < 0.45) {
      const t = (p - 0.22) / 0.23;
      return { x: 0.5, y: (52 - t * 4) / 100 }; // 0.52 -> 0.48
    }
    if (p < 0.76) {
      const t = (p - 0.45) / 0.31;
      return { x: 0.5, y: (48 + t * 4) / 100 }; // 0.48 -> 0.52
    }
    return { x: 0.5, y: 0.53 };
  }

  // Portrait tablet (e.g. 768x1024, 820x1180 - aspect ratio 0.62 to 0.95)
  if (aspectRatio < 0.95) {
    if (p < 0.22) return { x: 0.5, y: 0.53 };
    if (p < 0.45) {
      const t = (p - 0.22) / 0.23;
      return { x: 0.5, y: (53 - t * 10) / 100 }; // 0.53 -> 0.43
    }
    if (p < 0.76) {
      const t = (p - 0.45) / 0.31;
      return { x: 0.5, y: (43 + t * 8) / 100 }; // 0.43 -> 0.51
    }
    return { x: 0.5, y: 0.54 };
  }

  // Widescreen & landscape tablet/desktop (aspect ratio >= 0.95)
  let y = 0.54;
  if (p < 0.22) {
    y = 0.54;
  } else if (p < 0.44) {
    const t = (p - 0.22) / 0.22;
    y = (54 - t * 17) / 100; // 0.54 -> 0.37 (follow cap & brush)
  } else if (p < 0.75) {
    const t = (p - 0.44) / 0.31;
    y = (37 + t * 12) / 100; // 0.37 -> 0.49 (follow nail application)
  } else {
    const t = (p - 0.75) / 0.25;
    y = (49 + t * 7) / 100; // 0.49 -> 0.56 (finished hand & pedestal)
  }

  return { x: 0.5, y };
}

/**
 * Resizes the canvas to match display CSS dimensions, scaled by devicePixelRatio.
 */
function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

/**
 * Draws an image covering the canvas completely with focal tracking.
 */
function drawCoverFrame(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  progress: number
) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  const cw = canvas.width;
  const ch = canvas.height;
  if (!cw || !ch) return;

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;

  const focal = getFocalCoordinates(progress, cw, ch);
  const scale = Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;

  const fx = Math.max(0, Math.min(1, focal.x));
  const fy = Math.max(0, Math.min(1, focal.y));

  const dx = (cw - dw) * fx;
  const dy = (ch - dh) * fy;

  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * Performance-First Mobile-Prioritized Scroll-Controlled Hero Image Sequence.
 *
 * Replaces heavy, seek-locking video with an ultra-lightweight WebP image sequence (36 frames):
 * - Mobile sequence size: ~749 KB total (~21 KB/frame).
 * - Tablet sequence size: ~1.35 MB total (~37 KB/frame).
 * - Desktop sequence size: ~2.10 MB total (~58 KB/frame).
 * - Zero black/blank screen: Instant poster layer with progressive image queue.
 * - Hardware canvas rendering: synchronous, 60fps/120fps fluid scrub in both directions.
 * - Dynamic focal-point tracking ensures critical action is centered on narrow phones, tablets & desktop.
 */
export function ScrollRevealHero() {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);

  const [deviceTier, setDeviceTier] = useState<DeviceTier>("mobile");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);

  // Keep references to loaded images
  const imagesRef = useRef<(HTMLImageElement | null)[]>(new Array(TOTAL_FRAMES).fill(null));
  const currentFrameRef = useRef<number>(0);
  const currentProgressRef = useRef<number>(0);

  // Check prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Determine device tier
  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateTier = () => {
      const tier = getDeviceTier(window.innerWidth);
      setDeviceTier(tier);
    };
    updateTier();
    window.addEventListener("resize", updateTier);
    return () => window.removeEventListener("resize", updateTier);
  }, []);

  // Helper to find the closest loaded image if the target frame isn't loaded yet
  const getClosestLoadedImage = useCallback((targetIdx: number): HTMLImageElement | null => {
    const images = imagesRef.current;
    if (images[targetIdx]) return images[targetIdx];

    for (let offset = 1; offset < TOTAL_FRAMES; offset++) {
      const prev = targetIdx - offset;
      if (prev >= 0 && images[prev]) return images[prev];
      const next = targetIdx + offset;
      if (next < TOTAL_FRAMES && images[next]) return images[next];
    }
    return null;
  }, []);

  // Helper to render current target frame
  const renderCurrentFrame = useCallback(
    (frameIdx: number, progress: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      currentFrameRef.current = frameIdx;
      currentProgressRef.current = progress;

      const img = getClosestLoadedImage(frameIdx);
      if (img) {
        resizeCanvas(canvas);
        drawCoverFrame(canvas, img, progress);
        if (!isCanvasReady) setIsCanvasReady(true);
      }
    },
    [getClosestLoadedImage, isCanvasReady]
  );

  // Progressive image preloading logic
  useEffect(() => {
    if (typeof window === "undefined" || reducedMotion) return;

    let cancelled = false;
    const tier = deviceTier;

    // Reset loaded images for current tier if tier changes
    imagesRef.current = new Array(TOTAL_FRAMES).fill(null);

    const loadImage = (idx: number): Promise<HTMLImageElement> => {
      return new Promise((resolve, reject) => {
        if (cancelled) return reject();
        const existing = imagesRef.current[idx];
        if (existing && existing.complete && existing.naturalWidth > 0) {
          return resolve(existing);
        }

        const img = new Image();
        img.decoding = "async";
        img.src = getFrameUrl(tier, idx);
        img.onload = () => {
          if (cancelled) return;
          imagesRef.current[idx] = img;

          // If this frame or the closest frame is what's currently requested, redraw
          const target = currentFrameRef.current;
          if (Math.abs(target - idx) <= 1) {
            const canvas = canvasRef.current;
            if (canvas) {
              resizeCanvas(canvas);
              drawCoverFrame(canvas, img, currentProgressRef.current);
              setIsCanvasReady(true);
            }
          }
          resolve(img);
        };
        img.onerror = () => {
          if (!cancelled) resolve(img);
        };
      });
    };

    // Priority 1: Load frame 0 immediately to present the initial bottle
    loadImage(0)
      .then((img0) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (canvas) {
          resizeCanvas(canvas);
          drawCoverFrame(canvas, img0, 0);
          setIsCanvasReady(true);
        }

        // Priority 2: Preload initial scroll frames 1 through 5
        const initialBatch = [1, 2, 3, 4, 5];
        return Promise.all(initialBatch.map((i) => loadImage(i)));
      })
      .then(() => {
        if (cancelled) return;

        // Priority 3: Progressively stream the remaining frames (6..35)
        // with controlled concurrency (max 3 concurrent network requests)
        let cursor = 6;
        const loadNext = () => {
          if (cancelled || cursor >= TOTAL_FRAMES) return;
          const idx = cursor++;
          loadImage(idx).finally(() => {
            if (!cancelled) loadNext();
          });
        };

        // Start 3 concurrent pipelines
        for (let i = 0; i < 3; i++) {
          loadNext();
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [deviceTier, reducedMotion]);

  // Main GSAP ScrollTrigger timeline binding
  useEffect(() => {
    if (reducedMotion || typeof window === "undefined") return;

    let killed = false;
    let cleanupGsap: (() => void) | null = null;

    const section = sectionRef.current;
    const canvas = canvasRef.current;
    if (!section || !canvas) return;

    (async () => {
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      if (killed) return;

      gsap.registerPlugin(ScrollTrigger);

      // Prevent mobile address bar show/hide from thrashing scroll metrics
      ScrollTrigger.config({ ignoreMobileResize: true });

      const initialWidth = window.innerWidth;
      const isMobile = initialWidth < 640;
      const isTablet = initialWidth >= 640 && initialWidth < 1024;

      // Device-calibrated scroll distances:
      // Mobile: shorter pin (+160%), responsive scrub (0.1s) for 1:1 touch control
      // Tablet: balanced pin (+200%), scrub (0.2s)
      // Desktop: cinematic pin (+260%), silky scrub (0.35s)
      const endDistance = isMobile ? "+=160%" : isTablet ? "+=200%" : "+=260%";
      const scrubSmoothing = isMobile ? 0.1 : isTablet ? 0.2 : 0.35;

      const playhead = { frame: 0 };

      // Initial canvas setup
      resizeCanvas(canvas);

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
            const targetFrame = Math.min(TOTAL_FRAMES - 1, Math.max(0, Math.round(playhead.frame)));
            renderCurrentFrame(targetFrame, p);
          },
        },
      });

      // Synchronize playhead across all 36 frames
      tl.to(
        playhead,
        {
          frame: TOTAL_FRAMES - 1,
          ease: "none",
          duration: 1,
          onUpdate: () => {
            const targetFrame = Math.min(TOTAL_FRAMES - 1, Math.max(0, Math.round(playhead.frame)));
            renderCurrentFrame(targetFrame, currentProgressRef.current);
          },
        },
        0
      );

      // Scroll hint prompt disappears promptly on initial scroll
      if (hintRef.current) {
        tl.to(
          hintRef.current,
          { opacity: 0, y: 15, duration: 0.12, ease: "power1.out" },
          0
        );
      }

      // Title lifts and dissolves as bottle opens (progress 0.12 to 0.35)
      if (titleRef.current) {
        tl.to(
          titleRef.current,
          {
            opacity: 0,
            y: isMobile ? -30 : -45,
            duration: 0.22,
            ease: "power1.in",
          },
          0.12
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
            duration: 0.22,
            ease: "power2.out",
          },
          0.78
        );
      }

      ScrollTrigger.refresh();

      // Viewport resize handler with debounce (avoids mobile address-bar height churn)
      let prevWidth = window.innerWidth;
      const handleResize = () => {
        if (Math.abs(window.innerWidth - prevWidth) > 30) {
          prevWidth = window.innerWidth;
          if (canvasRef.current) {
            resizeCanvas(canvasRef.current);
            renderCurrentFrame(currentFrameRef.current, currentProgressRef.current);
          }
          ScrollTrigger.refresh();
        }
      };
      window.addEventListener("resize", handleResize);

      // Orientation change handler for tablets and phones
      const handleOrientation = () => {
        setTimeout(() => {
          if (canvasRef.current) {
            resizeCanvas(canvasRef.current);
            renderCurrentFrame(currentFrameRef.current, currentProgressRef.current);
          }
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
      cleanupGsap?.();
    };
  }, [reducedMotion, renderCurrentFrame]);

  // Poster URL based on active device tier
  const posterSrc = getPosterUrl(deviceTier);

  // Reduced motion alternative: static full-screen presentation
  if (reducedMotion) {
    return (
      <section
        className="relative h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-[var(--ivory)]"
        aria-label="Hero"
      >
        <img
          src={posterSrc}
          alt="Srishti Nail Couture"
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
            <a href="#contact" className="hero-cta-primary shadow-xl">
              Book Appointment
            </a>
            <a href="#academy" className="hero-cta-secondary backdrop-blur-md bg-white/60 shadow-md">
              Explore Academy
            </a>
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
      {/* Instant fallback poster image: visible immediately while canvas initializes */}
      <img
        src={posterSrc}
        alt="Srishti Nail Couture"
        fetchPriority="high"
        decoding="async"
        className={`absolute inset-0 h-full w-full object-cover pointer-events-none transition-opacity duration-300 ${
          isCanvasReady ? "opacity-0" : "opacity-100"
        }`}
        style={{ objectPosition: "50% 52%" }}
      />

      {/* Hardware-accelerated canvas stage: draws the 36-frame sequence */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full block select-none pointer-events-none will-change-transform"
        aria-hidden="true"
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