/**
 * CanvasTransitionManager: A utility for managing image transitions on a canvas element.
 * Supports various transition types (fade, slide, wipe, ripple, pixel dissolve, blur, pixelate, zoom, curtain, film burn, glitch).
 */

import { TransitionOptions, TransitionType } from "../config";

export const Easing = {
  linear: (t: number) => t,
  easeIn: (t: number) => t * t,
  easeOut: (t: number) => t * (2 - t),
  easeInOut: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeOutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOutQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  easeInOutQuint: (t: number) =>
    t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2,

  spring: (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    if (t === 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
} as const;

export type EasingFn = (t: number) => number;

interface CoverDims {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface CoverCacheEntry {
  canvasW: number;
  canvasH: number;
  imgW: number;
  imgH: number;
  result: CoverDims;
}

interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BlockCacheEntry {
  canvasW: number;
  canvasH: number;
  blockSize: number;
  blocks: Block[];
}

export type ExtendedTransitionType =
  | TransitionType
  | "zoom"
  | "curtain"
  | "filmBurn"
  | "glitch";

export class CanvasTransitionManager {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private currentImage: HTMLImageElement | null = null;
  private nextImage: HTMLImageElement | null = null;

  private animationFrameId: number | null = null;
  private isTransitioning = false;
  private activeTransitionId = 0;

  private tempCanvas: HTMLCanvasElement | null = null;

  private _coverCache: CoverCacheEntry | null = null;
  private _blockCache: BlockCacheEntry | null = null;

  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: false,
    });
    if (!ctx) throw new Error("Failed to get 2D context from canvas");
    this.ctx = ctx;

    this.resizeCanvas();

    this.resizeHandler = () => {
      this.resizeCanvas();
      this._coverCache = null;
      this._blockCache = null;
      if (!this.isTransitioning && this.currentImage) {
        this.renderImage(this.currentImage);
      }
    };
    window.addEventListener("resize", this.resizeHandler);
  }

  private resizeCanvas(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  private renderImage(img: HTMLImageElement, opacity = 1): void {
    const dims = this.getCoverDimensions(img);
    if (opacity !== 1) this.ctx.globalAlpha = opacity;
    this.ctx.drawImage(img, dims.dx, dims.dy, dims.dw, dims.dh);
    if (opacity !== 1) this.ctx.globalAlpha = 1;
  }

  private getCoverDimensions(img: HTMLImageElement): CoverDims {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const c = this._coverCache;
    if (
      c &&
      c.canvasW === cw &&
      c.canvasH === ch &&
      c.imgW === iw &&
      c.imgH === ih
    ) {
      return c.result;
    }

    const canvasAspect = cw / ch;
    const imgAspect = iw / ih;
    let dw: number, dh: number, dx: number, dy: number;

    if (canvasAspect > imgAspect) {
      dw = cw;
      dh = dw / imgAspect;
      dx = 0;
      dy = (ch - dh) / 2;
    } else {
      dh = ch;
      dw = dh * imgAspect;
      dx = (cw - dw) / 2;
      dy = 0;
    }

    const result: CoverDims = { dx, dy, dw, dh };
    this._coverCache = { canvasW: cw, canvasH: ch, imgW: iw, imgH: ih, result };
    return result;
  }

  async transition(
    imageBlob: Blob,
    type: ExtendedTransitionType = "fade",
    options: TransitionOptions = {},
  ): Promise<void> {
    const transitionId = ++this.activeTransitionId;

    if (this.isTransitioning) this.stopTransition();

    let img: HTMLImageElement;
    try {
      img = await this.loadImage(imageBlob);
    } catch (e) {
      console.error("CanvasTransitionManager: failed to load image", e);
      return;
    }

    if (transitionId !== this.activeTransitionId) return;

    this.nextImage = img;
    this.isTransitioning = true;

    const duration = options.duration ?? 800;
    const easing: EasingFn = (options as any).easing ?? Easing.easeInOutCubic;
    const direction = options.direction ?? "right";

    this.paintBackground();

    let blocks: Block[] = [];
    if (type === "pixelDissolve") {
      const blockSize = Math.max(
        20,
        Math.floor(Math.sqrt(this.canvas.width * this.canvas.height) / 50),
      );
      blocks = this.generateBlocks(blockSize);
    }

    return new Promise((resolve) => {
      const startTime = performance.now();
      let lastEasedProgress = 0;

      const animate = (now: number) => {
        if (!this.isTransitioning) {
          resolve();
          return;
        }

        const p = Math.min((now - startTime) / duration, 1);
        const ep = easing(p);

        this.dispatchFrame(type, ep, lastEasedProgress, direction, blocks);
        lastEasedProgress = ep;

        if (p < 1) {
          this.animationFrameId = requestAnimationFrame(animate);
        } else {
          this.finishTransition();
          resolve();
        }
      };

      this.animationFrameId = requestAnimationFrame(animate);
    });
  }

  private dispatchFrame(
    type: ExtendedTransitionType,
    ep: number,
    lastEp: number,
    direction: string,
    blocks: Block[],
  ): void {
    switch (type) {
      case "fade":
        return this.renderFade(ep);
      case "slide":
        return this.renderSlide(ep, direction as any);
      case "wipe":
        return this.renderWipe(ep, direction as any);
      case "ripple":
        return this.renderIris(ep);
      case "pixelDissolve":
        return this.renderAccumulativeBlocks(ep, lastEp, blocks);
      case "dissolve":
        return this.renderBlur(ep);
      case "pixel":
        return this.renderPixelate(ep);
      case "zoom":
        return this.renderZoom(ep);
      case "curtain":
        return this.renderCurtain(ep);
      case "filmBurn":
        return this.renderFilmBurn(ep);
      case "glitch":
        return this.renderGlitch(ep);
      default:
        return this.renderFade(ep);
    }
  }

  private finishTransition(): void {
    this.isTransitioning = false;
    this.currentImage = this.nextImage;
    this.nextImage = null;
    this.animationFrameId = null;
    if (this.currentImage) this.renderImage(this.currentImage);
  }

  private paintBackground(): void {
    if (this.currentImage) {
      this.renderImage(this.currentImage);
    } else {
      this.ctx.fillStyle = "#121212";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private renderFade(progress: number): void {
    if (!this.nextImage) return;
    this.paintBackground();
    this.renderImage(this.nextImage, progress);
  }

  private renderSlide(
    progress: number,
    direction: "left" | "right" | "up" | "down",
  ): void {
    if (!this.currentImage || !this.nextImage) return;

    const { width, height } = this.canvas;
    const PARALLAX = 0.35;

    const leaveOffset = progress * PARALLAX;
    const enterStart = 1 - progress;

    this.ctx.clearRect(0, 0, width, height);

    const drawAt = (
      img: HTMLImageElement,
      txFrac: number,
      tyFrac: number,
      dimAlpha = 0,
    ) => {
      const dims = this.getCoverDimensions(img);
      this.ctx.save();
      this.ctx.translate(txFrac * width, tyFrac * height);
      this.ctx.drawImage(img, dims.dx, dims.dy, dims.dw, dims.dh);
      if (dimAlpha > 0) {
        this.ctx.fillStyle = `rgba(0,0,0,${dimAlpha})`;
        this.ctx.fillRect(
          -Math.abs(dims.dx),
          -Math.abs(dims.dy),
          width + Math.abs(dims.dx) * 2,
          height + Math.abs(dims.dy) * 2,
        );
      }
      this.ctx.restore();
    };

    let ltx = 0,
      lty = 0,
      etx = 0,
      ety = 0;
    switch (direction) {
      case "right":
        ltx = leaveOffset;
        etx = -enterStart;
        break;
      case "left":
        ltx = -leaveOffset;
        etx = enterStart;
        break;
      case "down":
        lty = leaveOffset;
        ety = -enterStart;
        break;
      case "up":
        lty = -leaveOffset;
        ety = enterStart;
        break;
    }

    drawAt(this.currentImage, ltx, lty, progress * 0.5);
    drawAt(this.nextImage, etx, ety);
  }

  private renderWipe(
    progress: number,
    direction: "left" | "right" | "up" | "down",
  ): void {
    if (!this.nextImage) return;
    this.paintBackground();

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

  private renderIris(progress: number): void {
    if (!this.nextImage) return;
    this.paintBackground();

    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const maxR = Math.hypot(this.canvas.width, this.canvas.height) / 1.5;
    const radius = Math.max(1, maxR * progress);

    const dims = this.getCoverDimensions(this.nextImage);
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.clip();
    this.ctx.drawImage(this.nextImage, dims.dx, dims.dy, dims.dw, dims.dh);
    this.ctx.restore();
  }

  private generateBlocks(blockSize: number): Block[] {
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    const c = this._blockCache;
    if (
      c &&
      c.canvasW === cw &&
      c.canvasH === ch &&
      c.blockSize === blockSize
    ) {
      return c.blocks;
    }

    const cols = Math.ceil(cw / blockSize);
    const rows = Math.ceil(ch / blockSize);
    const blocks: Block[] = [];

    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        blocks.push({
          x: col * blockSize,
          y: r * blockSize,
          w: Math.min(blockSize, cw - col * blockSize),
          h: Math.min(blockSize, ch - r * blockSize),
        });
      }
    }

    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = blocks[i]!;
      blocks[i] = blocks[j]!;
      blocks[j] = tmp;
    }

    this._blockCache = { canvasW: cw, canvasH: ch, blockSize, blocks };
    return blocks;
  }

  private renderAccumulativeBlocks(
    progress: number,
    lastProgress: number,
    blocks: Block[],
  ): void {
    if (!this.nextImage || blocks.length === 0) return;

    const total = blocks.length;
    const p1 = Math.max(0, Math.min(lastProgress, 1));
    const p2 = Math.max(0, Math.min(progress, 1));

    const startIdx = Math.floor(p1 * total);
    const endIdx = Math.min(Math.floor(p2 * total), total); // BUG FIX

    if (endIdx <= startIdx) return;

    const dims = this.getCoverDimensions(this.nextImage);
    if (!this.nextImage.naturalWidth) return;
    const scale = dims.dw / this.nextImage.naturalWidth;

    for (let i = startIdx; i < endIdx; i++) {
      const b = blocks[i];
      if (!b) continue;
      const relX = b.x - dims.dx;
      const relY = b.y - dims.dy;
      this.ctx.drawImage(
        this.nextImage,
        relX / scale,
        relY / scale,
        b.w / scale,
        b.h / scale,
        b.x,
        b.y,
        b.w,
        b.h,
      );
    }
  }

  private renderBlur(progress: number): void {
    if (!this.currentImage || !this.nextImage) return;

    const maxBlur = 40;
    const { width, height } = this.canvas;

    const isFirstHalf = progress < 0.5;
    const halfP = isFirstHalf ? progress * 2 : (progress - 0.5) * 2;
    const blurAmount = isFirstHalf ? halfP * maxBlur : (1 - halfP) * maxBlur;
    const imgToDraw = isFirstHalf ? this.currentImage : this.nextImage;

    this.ctx.clearRect(0, 0, width, height);
    this.ctx.filter = `blur(${blurAmount.toFixed(1)}px)`;
    const dims = this.getCoverDimensions(imgToDraw);
    this.ctx.drawImage(imgToDraw, dims.dx, dims.dy, dims.dw, dims.dh);
    this.ctx.filter = "none";
  }

  private renderPixelate(progress: number): void {
    if (!this.currentImage || !this.nextImage) return;

    const { width, height } = this.canvas;
    const maxBlockSize = 50;

    const isFirstHalf = progress < 0.5;
    const halfP = isFirstHalf ? progress * 2 : (progress - 0.5) * 2;
    const blockSize = Math.max(
      1,
      Math.floor(1 + (maxBlockSize - 1) * (isFirstHalf ? halfP : 1 - halfP)),
    );
    const imgToDraw = isFirstHalf ? this.currentImage : this.nextImage;
    const dims = this.getCoverDimensions(imgToDraw);

    this.ctx.clearRect(0, 0, width, height);

    if (blockSize <= 1) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(imgToDraw, dims.dx, dims.dy, dims.dw, dims.dh);
      return;
    }

    const scaledW = Math.max(1, Math.ceil(width / blockSize));
    const scaledH = Math.max(1, Math.ceil(height / blockSize));

    if (!this.tempCanvas) this.tempCanvas = document.createElement("canvas");
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
    const sx = Math.max(0, -dims.dx / scale);
    const sy = Math.max(0, -dims.dy / scale);
    const sw = Math.min(imgToDraw.naturalWidth - sx, width / scale);
    const sh = Math.min(imgToDraw.naturalHeight - sy, height / scale);

    tempCtx.imageSmoothingEnabled = true;
    tempCtx.drawImage(imgToDraw, sx, sy, sw, sh, 0, 0, scaledW, scaledH);

    this.ctx.imageSmoothingEnabled = false;
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

  private renderZoom(progress: number): void {
    if (!this.nextImage) return;

    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    if (this.currentImage) {
      const zoomScale = 1 + progress * 0.08;
      const dims = this.getCoverDimensions(this.currentImage);
      const ox = (dims.dw * (zoomScale - 1)) / 2;
      const oy = (dims.dh * (zoomScale - 1)) / 2;
      this.ctx.globalAlpha = 1 - progress;
      this.ctx.drawImage(
        this.currentImage,
        dims.dx - ox,
        dims.dy - oy,
        dims.dw * zoomScale,
        dims.dh * zoomScale,
      );
      this.ctx.globalAlpha = 1;
    }

    const dims = this.getCoverDimensions(this.nextImage);
    this.ctx.globalAlpha = progress;
    this.ctx.drawImage(this.nextImage, dims.dx, dims.dy, dims.dw, dims.dh);
    this.ctx.globalAlpha = 1;
  }

  private renderCurtain(progress: number): void {
    if (!this.currentImage || !this.nextImage) return;

    const { width, height } = this.canvas;
    const halfW = width / 2;
    const offset = progress * halfW;

    const nextDims = this.getCoverDimensions(this.nextImage);
    this.ctx.drawImage(
      this.nextImage,
      nextDims.dx,
      nextDims.dy,
      nextDims.dw,
      nextDims.dh,
    );

    const curDims = this.getCoverDimensions(this.currentImage);

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(0, 0, halfW, height);
    this.ctx.clip();
    this.ctx.translate(-offset, 0);
    this.ctx.drawImage(
      this.currentImage,
      curDims.dx,
      curDims.dy,
      curDims.dw,
      curDims.dh,
    );
    const gradL = this.ctx.createLinearGradient(halfW - 60, 0, halfW, 0);
    gradL.addColorStop(0, "rgba(0,0,0,0)");
    gradL.addColorStop(1, `rgba(0,0,0,${0.55 * (1 - progress)})`);
    this.ctx.fillStyle = gradL;
    this.ctx.fillRect(halfW - 60, 0, 60, height);
    this.ctx.restore();

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(halfW, 0, halfW, height);
    this.ctx.clip();
    this.ctx.translate(offset, 0);
    this.ctx.drawImage(
      this.currentImage,
      curDims.dx,
      curDims.dy,
      curDims.dw,
      curDims.dh,
    );
    const gradR = this.ctx.createLinearGradient(halfW, 0, halfW + 60, 0);
    gradR.addColorStop(0, `rgba(0,0,0,${0.55 * (1 - progress)})`);
    gradR.addColorStop(1, "rgba(0,0,0,0)");
    this.ctx.fillStyle = gradR;
    this.ctx.fillRect(halfW, 0, 60, height);
    this.ctx.restore();
  }

  private renderFilmBurn(progress: number): void {
    if (!this.nextImage) return;

    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    const burnPeak = 0.5;
    const burnIntensity =
      progress < burnPeak
        ? progress / burnPeak
        : 1 - (progress - burnPeak) / (1 - burnPeak);

    if (progress < burnPeak && this.currentImage) {
      this.renderImage(this.currentImage, 1 - burnIntensity * 0.7);
    } else if (progress >= burnPeak) {
      const p = (progress - burnPeak) / (1 - burnPeak);
      this.renderImage(this.nextImage, p);
    }

    if (burnIntensity > 0) {
      const alpha = burnIntensity * 0.92;
      const grd = this.ctx.createRadialGradient(
        width / 2,
        height / 2,
        0,
        width / 2,
        height / 2,
        Math.hypot(width, height) / 2,
      );
      grd.addColorStop(0, `rgba(255,255,240,${alpha})`);
      grd.addColorStop(0.4, `rgba(255,200,80,${alpha * 0.8})`);
      grd.addColorStop(1, `rgba(180,60,0,${alpha * 0.3})`);
      this.ctx.fillStyle = grd;
      this.ctx.fillRect(0, 0, width, height);

      const leakAlpha = burnIntensity * 0.4;
      const leakGrad = this.ctx.createLinearGradient(
        0,
        height * 0.35,
        0,
        height * 0.65,
      );
      leakGrad.addColorStop(0, "rgba(255,220,100,0)");
      leakGrad.addColorStop(0.5, `rgba(255,240,180,${leakAlpha})`);
      leakGrad.addColorStop(1, "rgba(255,220,100,0)");
      this.ctx.fillStyle = leakGrad;
      this.ctx.fillRect(0, height * 0.35, width, height * 0.3);
    }
  }

  private renderGlitch(progress: number): void {
    if (!this.currentImage || !this.nextImage) return;

    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    // Intensity bell-curve: 0 at start and end, peak at midpoint
    const intensity = Math.sin(progress * Math.PI);
    const imgToDraw = progress < 0.5 ? this.currentImage : this.nextImage;

    this.renderImage(imgToDraw);

    if (intensity < 0.05) return;

    const sliceCount = Math.floor(8 + intensity * 16);
    const maxOffset = width * 0.06 * intensity;
    const seed = Math.floor(progress * 30); // stable per ~33ms bucket

    for (let s = 0; s < sliceCount; s++) {
      const r1 = Math.abs(Math.sin(seed * 127.1 + s * 311.7));
      const r2 = Math.abs(Math.sin(seed * 269.5 + s * 183.3));
      const r3 = Math.abs(Math.sin(seed * 419.2 + s * 71.1));

      const sliceH = Math.max(2, Math.floor((r1 * height) / sliceCount));
      const sliceY = Math.floor(r2 * (height - sliceH));
      const offsetX = (r3 - 0.5) * 2 * maxOffset;

      try {
        const imageData = this.ctx.getImageData(0, sliceY, width, sliceH);
        this.ctx.clearRect(0, sliceY, width, sliceH);
        this.ctx.putImageData(imageData, offsetX, sliceY);
      } catch {}
    }

    // Chromatic aberration ghost
    if (intensity > 0.3) {
      const aberration = intensity * 4;
      const dims = this.getCoverDimensions(imgToDraw);
      this.ctx.save();
      this.ctx.globalAlpha = intensity * 0.15;
      this.ctx.globalCompositeOperation = "screen";
      this.ctx.filter = "saturate(5) hue-rotate(0deg)";
      this.ctx.drawImage(
        imgToDraw,
        dims.dx - aberration,
        dims.dy,
        dims.dw,
        dims.dh,
      );
      this.ctx.filter = "saturate(5) hue-rotate(200deg)";
      this.ctx.drawImage(
        imgToDraw,
        dims.dx + aberration,
        dims.dy,
        dims.dw,
        dims.dh,
      );
      this.ctx.filter = "none";
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.globalAlpha = 1;
      this.ctx.restore();
    }
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

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

  /** Release all resources. Safe to call multiple times. */
  destroy(): void {
    this.stopTransition();
    window.removeEventListener("resize", this.resizeHandler);
    // BUG FIX: null out image refs so they can be GC'd
    this.currentImage = null;
    this.nextImage = null;
    this.tempCanvas = null;
    this._coverCache = null;
    this._blockCache = null;
  }
}
