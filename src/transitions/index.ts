/**
 * Canvas-based image transition engine for smooth wallpaper changes
 * Optimized for performance and natural feel
 */
import { TransitionOptions, TransitionType } from "../config";

/**
 * Easing functions for smooth animations
 */
export const Easing = {
  linear: (t: number) => t,
  easeInOut: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeOut: (t: number) => t * (2 - t),
  easeIn: (t: number) => t * t,
  easeOutCubic: (t: number) => --t * t * t + 1,
  easeInOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  easeOutQuart: (t: number) => 1 - --t * t * t * t,
};

/**
 * Canvas transition manager class
 * Handles rendering and animation of image transitions
 */
export class CanvasTransitionManager {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentImage: HTMLImageElement | null = null;
  private nextImage: HTMLImageElement | null = null;
  private animationFrameId: number | null = null;
  private isTransitioning: boolean = false;
  private tempCanvas: HTMLCanvasElement | null = null;
  private activeTransitionId: number = 0;

  // Cache for random block transitions
  private imageCache: {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Get context with optimizations
    const ctx = canvas.getContext("2d", {
      alpha: false, // We don't need transparency on the canvas itself
      willReadFrequently: false, // We are moving away from readback operations
    });
    if (!ctx) {
      throw new Error("Failed to get 2D context from canvas");
    }
    this.ctx = ctx;
    this.resizeCanvas();

    // Handle window resize
    window.addEventListener("resize", () => {
      this.resizeCanvas();
      // If resizing during transition, we might want to just finish it instantly or restart
      // For simplicity, we just redraw the current state
      if (!this.isTransitioning && this.currentImage) {
        this.renderImage(this.currentImage);
      }
    });
  }

  /**
   * Resize canvas to match window dimensions
   */
  private resizeCanvas(): void {
    // Set actual size in memory
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /**
   * Helper to simple draw
   */
  private renderImage(img: HTMLImageElement, opacity: number = 1) {
    this.ctx.globalAlpha = opacity;
    const dims = this.getCoverDimensions(img);
    this.ctx.drawImage(img, dims.dx, dims.dy, dims.dw, dims.dh);
    this.ctx.globalAlpha = 1;
  }

  /**
   * Calculate dimensions to cover the canvas (background-size: cover)
   */
  private getCoverDimensions(img: HTMLImageElement) {
    const canvasAspect = this.canvas.width / this.canvas.height;
    const imgAspect = img.naturalWidth / img.naturalHeight;

    let dw, dh, dx, dy;

    if (canvasAspect > imgAspect) {
      dw = this.canvas.width;
      dh = dw / imgAspect;
      dx = 0;
      dy = (this.canvas.height - dh) / 2;
    } else {
      dh = this.canvas.height;
      dw = dh * imgAspect;
      dx = (this.canvas.width - dw) / 2;
      dy = 0;
    }
    return { dx, dy, dw, dh };
  }

  /**
   * Transition to a new image with specified effect
   */
  async transition(
    imageBlob: Blob,
    type: TransitionType = "fade",
    options: TransitionOptions = {},
  ): Promise<void> {
    const transitionId = ++this.activeTransitionId;

    if (this.isTransitioning) {
      this.stopTransition();
    }

    // Load the new image
    let img: HTMLImageElement;
    try {
      img = await this.loadImage(imageBlob);
    } catch (e) {
      console.error(e);
      return;
    }

    // Check if this transition has been superseded
    if (transitionId !== this.activeTransitionId) {
      return;
    }

    this.nextImage = img;
    this.isTransitioning = true;
    this.imageCache = null; // Reset cache

    const duration = options.duration || 800;
    const easing = options.easing || Easing.easeInOutCubic;
    const direction = options.direction || "right";

    // Pre-calculate expensive things for block effects
    let blocks: any[] = [];
    if (type === "pixelDissolve" || type === "noiseReveal") {
      // Create a grid of blocks for the dissolve effect
      // Optimized size: too small = slow, too large = ugly.
      // 40px is a good balance for 1080p, maybe scale deeply?
      const blockSize = Math.max(
        20,
        Math.floor(
          Math.sqrt(this.canvas.width * this.canvas.height) /
            (type === "noiseReveal" ? 80 : 50),
        ),
      );
      blocks = this.generateBlocks(blockSize);
    }

    // Initialize Canvas State
    // We draw the current image (background)
    if (this.currentImage) {
      this.renderImage(this.currentImage);
    } else {
      this.ctx.fillStyle = "#121212";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    return new Promise((resolve) => {
      const startTime = performance.now();
      let lastProgress = 0;

      const animate = (currentTime: number) => {
        if (!this.isTransitioning) {
          resolve();
          return;
        }

        const elapsed = currentTime - startTime;
        let p = Math.min(elapsed / duration, 1);
        const easedProgress = easing(p);

        // Render Frame
        switch (type) {
          case "fade":
            this.renderFade(easedProgress);
            break;
          case "slide":
            this.renderSlide(easedProgress, direction);
            break;
          case "wipe":
            this.renderWipe(easedProgress, direction);
            break;
          case "ripple":
            this.renderIris(easedProgress); // Replaces heavy ripple
            break;
          case "pixelDissolve":
          case "noiseReveal":
            this.renderAccumulativeBlocks(easedProgress, lastProgress, blocks);
            break;
          case "dissolve":
            this.renderBlur(easedProgress);
            break;
          case "pixel":
            this.renderPixelate(easedProgress);
            break;
          default:
            this.renderFade(easedProgress);
        }

        lastProgress = easedProgress;

        if (p < 1) {
          this.animationFrameId = requestAnimationFrame(animate);
        } else {
          // Finish
          this.finishTransition();
          resolve();
        }
      };

      this.animationFrameId = requestAnimationFrame(animate);
    });
  }

  private finishTransition() {
    this.isTransitioning = false;
    this.currentImage = this.nextImage;
    this.nextImage = null;
    this.animationFrameId = null;
    // Ensure final state is clean and high quality
    if (this.currentImage) {
      this.renderImage(this.currentImage);
    }
  }

  // --- Optimized Renderers ---

  /**
   * Smooth Cross Fade
   */
  private renderFade(progress: number) {
    if (this.nextImage) {
      // Use 'lighten' or just overdraw? Overdraw with alpha is standard.
      this.renderImage(this.nextImage, progress);
    }
  }

  /**
   * Slide with Parallax Effect
   */
  private renderSlide(
    progress: number,
    direction: "left" | "right" | "up" | "down",
  ) {
    if (!this.currentImage || !this.nextImage) return;

    const { width, height } = this.canvas;
    const dimsCurrent = this.getCoverDimensions(this.currentImage);
    const dimsNext = this.getCoverDimensions(this.nextImage);

    this.ctx.clearRect(0, 0, width, height);

    let tx = 0,
      ty = 0;
    // Parallax factor: Background moves slower
    const parallax = 0.3;

    switch (direction) {
      case "right":
        tx = width * progress;
        break;
      case "left":
        tx = -width * progress;
        break;
      case "down":
        ty = height * progress;
        break;
      case "up":
        ty = -height * progress;
        break;
    }

    // Draw Current (Leaving)
    this.ctx.save();
    this.ctx.translate(tx * parallax, ty * parallax);
    // Dim the leaving image slightly
    this.ctx.globalAlpha = 1;
    // Draw background color behind to avoid transparency artifacts
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.drawImage(
      this.currentImage,
      dimsCurrent.dx,
      dimsCurrent.dy,
      dimsCurrent.dw,
      dimsCurrent.dh,
    );

    // Overlay shadow on leaving image?
    if (progress > 0) {
      this.ctx.fillStyle = `rgba(0,0,0,${progress * 0.5})`;
      this.ctx.fillRect(0, 0, width, height);
    }
    this.ctx.restore();

    // Draw Next (Entering)
    let ntx = 0,
      nty = 0;
    switch (direction) {
      case "right":
        ntx = -width * (1 - progress);
        break;
      case "left":
        ntx = width * (1 - progress);
        break;
      case "down":
        nty = -height * (1 - progress);
        break;
      case "up":
        nty = height * (1 - progress);
        break;
    }

    this.ctx.save();
    this.ctx.translate(ntx, nty);
    this.ctx.drawImage(
      this.nextImage,
      dimsNext.dx,
      dimsNext.dy,
      dimsNext.dw,
      dimsNext.dh,
    );
    this.ctx.restore();
  }

  /**
   * Iris Wipe (Replaces Ripple)
   */
  private renderIris(progress: number) {
    if (!this.nextImage) return;

    // Draw current image first (if we cleared - but we don't clear generally)
    // Actually, in current architecture, we assume background persists.
    // But Iris shrinks clip? No, Iris grows clip.
    // So background is obscured. We can just draw clipped Next over Current.

    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const maxR = Math.abs(
      Math.hypot(this.canvas.width, this.canvas.height) / 1.5,
    );
    const radius = Math.max(1, maxR * Math.max(0, progress)); // Ensure positive radius with minimum 1px

    const dims = this.getCoverDimensions(this.nextImage);

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.clip();
    this.ctx.drawImage(this.nextImage, dims.dx, dims.dy, dims.dw, dims.dh);
    this.ctx.restore();
  }

  /**
   * Standard Directional Wipe
   */
  private renderWipe(
    progress: number,
    direction: "left" | "right" | "up" | "down",
  ) {
    if (!this.nextImage) return;

    const { width, height } = this.canvas;
    const dims = this.getCoverDimensions(this.nextImage);

    this.ctx.save();
    this.ctx.beginPath();

    switch (direction) {
      case "right":
        this.ctx.rect(0, 0, width * progress, height);
        break;
      case "left":
        this.ctx.rect(width * (1 - progress), 0, width * progress, height);
        break;
      case "down":
        this.ctx.rect(0, 0, width, height * progress);
        break;
      case "up":
        this.ctx.rect(0, height * (1 - progress), width, height * progress);
        break;
    }

    this.ctx.clip();
    this.ctx.drawImage(this.nextImage, dims.dx, dims.dy, dims.dw, dims.dh);
    this.ctx.restore();
  }

  /**
   * Accumulative Grid/Block Reveal (Replaces PixelDissolve/Noise)
   */
  private generateBlocks(blockSize: number) {
    const cols = Math.ceil(this.canvas.width / blockSize);
    const rows = Math.ceil(this.canvas.height / blockSize);
    const blocks = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        blocks.push({
          x: c * blockSize,
          y: r * blockSize,
          w: blockSize,
          h: blockSize,
        });
      }
    }

    // Fisher-Yates shuffle
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }

    return blocks;
  }

  private renderAccumulativeBlocks(
    progress: number,
    lastProgress: number,
    blocks: any[],
  ) {
    // Early return with extensive validation
    if (!this.nextImage) return;
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) return;

    const total = blocks.length;

    // Ensure progress is clamped to avoid index out of bounds
    const p1 = Math.max(0, Math.min(lastProgress, 1));
    const p2 = Math.max(0, Math.min(progress, 1));

    // Calculate range, ensuring indices are within bounds
    const startIdx = Math.max(0, Math.min(Math.floor(p1 * total), total - 1));
    const endIdx = Math.max(0, Math.min(Math.floor(p2 * total), total));

    if (endIdx <= startIdx) return;

    const dims = this.getCoverDimensions(this.nextImage);
    // Protect against division by zero if image has no width (unlikely but safe)
    if (!this.nextImage.naturalWidth || this.nextImage.naturalWidth === 0)
      return;

    const scale = dims.dw / this.nextImage.naturalWidth;

    // Clamp the loop limit to the array length to be absolutely safe
    const limit = Math.min(endIdx, total);

    for (let i = startIdx; i < limit; i++) {
      const b = blocks[i];
      // More thorough validation
      if (!b || typeof b !== "object") continue;
      if (typeof b.x !== "number" || typeof b.y !== "number") continue;
      if (typeof b.w !== "number" || typeof b.h !== "number") continue;

      const relX = b.x - dims.dx;
      const relY = b.y - dims.dy;
      const sX = relX / scale;
      const sY = relY / scale;
      const sW = b.w / scale;
      const sH = b.h / scale;

      this.ctx.drawImage(
        this.nextImage,
        sX,
        sY,
        sW,
        sH, // Source
        b.x,
        b.y,
        b.w,
        b.h, // Dest
      );
    }
  }

  /**
   * Blur Transition
   * Blurs out the current image and blurs in the next image
   */
  private renderBlur(progress: number) {
    if (!this.currentImage || !this.nextImage) return;

    const maxBlur = 40;
    const { width, height } = this.canvas;

    this.ctx.clearRect(0, 0, width, height);

    let blurAmount = 0;
    let imgToDraw = this.currentImage;

    if (progress < 0.5) {
      // Blur out current
      const p = progress * 2;
      blurAmount = p * maxBlur;
      imgToDraw = this.currentImage;
    } else {
      // Blur in next
      const p = (progress - 0.5) * 2;
      blurAmount = (1 - p) * maxBlur;
      imgToDraw = this.nextImage;
    }

    this.ctx.filter = `blur(${Math.max(0, blurAmount)}px)`;

    const dims = this.getCoverDimensions(imgToDraw);
    this.ctx.drawImage(imgToDraw, dims.dx, dims.dy, dims.dw, dims.dh);

    this.ctx.filter = "none";
  }

  /**
   * Pixelate Transition
   * Uses downscaling/upscaling to create mosaic effect
   */
  private renderPixelate(progress: number) {
    if (!this.currentImage || !this.nextImage) return;

    const { width, height } = this.canvas;
    const maxBlockSize = 50;

    let blockSize = 1;
    let imgToDraw = this.currentImage;

    if (progress < 0.5) {
      const p = progress * 2;
      blockSize = 1 + (maxBlockSize - 1) * p;
      imgToDraw = this.currentImage;
    } else {
      const p = (progress - 0.5) * 2;
      blockSize = 1 + (maxBlockSize - 1) * (1 - p);
      imgToDraw = this.nextImage;
    }

    blockSize = Math.max(1, Math.floor(blockSize));
    const dims = this.getCoverDimensions(imgToDraw);

    if (blockSize <= 1) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(imgToDraw, dims.dx, dims.dy, dims.dw, dims.dh);
      return;
    }

    const scaledW = Math.max(1, Math.ceil(width / blockSize));
    const scaledH = Math.max(1, Math.ceil(height / blockSize));

    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement("canvas");
    }

    if (
      this.tempCanvas.width !== scaledW ||
      this.tempCanvas.height !== scaledH
    ) {
      this.tempCanvas.width = scaledW;
      this.tempCanvas.height = scaledH;
    }

    const tempCtx = this.tempCanvas.getContext("2d", { alpha: false });
    if (!tempCtx) return;

    const scale = dims.dw / imgToDraw.naturalWidth;
    const sx = Math.max(0, (0 - dims.dx) / scale);
    const sy = Math.max(0, (0 - dims.dy) / scale);
    const sw = Math.min(imgToDraw.naturalWidth - sx, width / scale);
    const sh = Math.min(imgToDraw.naturalHeight - sy, height / scale);

    tempCtx.imageSmoothingEnabled = true;
    tempCtx.drawImage(imgToDraw, sx, sy, sw, sh, 0, 0, scaledW, scaledH);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.drawImage(
      this.tempCanvas,
      0,
      0,
      scaledW,
      scaledH,
      0,
      0,
      width,
      height,
    );

    this.ctx.imageSmoothingEnabled = true;
  }

  // --- Utilities ---

  private loadImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to load image"));
      };

      img.src = url;
    });
  }

  async displayImmediate(imageBlob: Blob): Promise<void> {
    const img = await this.loadImage(imageBlob);
    this.currentImage = img;
    this.renderImage(img);
  }

  stopTransition(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.isTransitioning = false;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopTransition();
    window.removeEventListener("resize", () => this.resizeCanvas());
  }
}
