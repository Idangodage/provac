import type { Worker, RecognizeResult } from "tesseract.js";
import { createWorker } from "tesseract.js";

import type {
  OCRResult,
  OCRPage,
  OCRBlock,
  OCRLine,
  OCRWord,
  OCROptions,
  BoundingBox,
  ProgressCallback,
} from "./types";

// Default OCR options
const defaultOptions: OCROptions = {
  language: "eng",
  detectTables: true,
  workerCount: 1,
  preprocess: {
    grayscale: true,
    enhanceContrast: false,
    denoise: false,
    deskew: false,
  },
};

/**
 * OCR Processor using Tesseract.js
 */
export class OCRProcessor {
  private worker: Worker | null = null;
  private options: OCROptions;
  private initialized = false;

  constructor(options: Partial<OCROptions> = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  /**
   * Initialize the OCR worker
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const lang = Array.isArray(this.options.language)
      ? this.options.language.join("+")
      : this.options.language || "eng";

    this.worker = await createWorker(lang, 1, {
      logger: (m) => {
        // Progress logging (can be captured by progress callback)
        if (m.status === "recognizing text") {
          // Progress is available in m.progress
        }
      },
    });

    this.initialized = true;
  }

  /**
   * Process an image or buffer and extract text
   */
  async processImage(
    input: string | Buffer | Blob,
    onProgress?: ProgressCallback
  ): Promise<OCRResult> {
    const startTime = Date.now();

    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.worker) {
      throw new Error("OCR worker not initialized");
    }

    onProgress?.({ status: "Processing image", progress: 0 });

    const result = await this.worker.recognize(input);

    onProgress?.({ status: "Extracting text", progress: 50 });

    const page = this.parseRecognizeResult(result, 1);

    onProgress?.({ status: "Complete", progress: 100 });

    return {
      pages: [page],
      fullText: page.text,
      averageConfidence: page.confidence,
      processingTime: Date.now() - startTime,
    };
  }

  /**
   * Process multiple images (e.g., from a PDF)
   */
  async processImages(
    inputs: (string | Buffer | Blob)[],
    onProgress?: ProgressCallback
  ): Promise<OCRResult> {
    const startTime = Date.now();
    const pages: OCRPage[] = [];
    let totalConfidence = 0;

    const maxPages = this.options.maxPages || inputs.length;
    const pagesToProcess = inputs.slice(0, maxPages);

    for (let i = 0; i < pagesToProcess.length; i++) {
      const input = pagesToProcess[i];
      const progress = (i / pagesToProcess.length) * 100;

      onProgress?.({
        status: `Processing page ${i + 1} of ${pagesToProcess.length}`,
        progress,
        page: i + 1,
        totalPages: pagesToProcess.length,
      });

      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.worker) {
        throw new Error("OCR worker not initialized");
      }

      const result = await this.worker.recognize(input);
      const page = this.parseRecognizeResult(result, i + 1);
      pages.push(page);
      totalConfidence += page.confidence;
    }

    onProgress?.({ status: "Complete", progress: 100 });

    return {
      pages,
      fullText: pages.map((p) => p.text).join("\n\n---PAGE BREAK---\n\n"),
      averageConfidence: totalConfidence / pages.length,
      processingTime: Date.now() - startTime,
    };
  }

  /**
   * Parse Tesseract recognition result into our format
   */
  private parseRecognizeResult(result: RecognizeResult, pageNumber: number): OCRPage {
    const { data } = result;
    const pageMeta = data as unknown as {
      imageWidth?: number;
      imageHeight?: number;
      width?: number;
      height?: number;
    };

    const blocks: OCRBlock[] = (data.blocks || []).map((block) => {
      const lines: OCRLine[] = (block.paragraphs || []).flatMap((para) =>
        (para.lines || []).map((line) => {
          const words: OCRWord[] = (line.words || []).map((word) => ({
            text: word.text,
            confidence: word.confidence,
            bbox: this.createBbox(word.bbox),
          }));

          return {
            text: line.text,
            confidence: line.confidence,
            words,
            bbox: this.createBbox(line.bbox),
          };
        })
      );

      return {
        text: block.text,
        confidence: block.confidence,
        lines,
        bbox: this.createBbox(block.bbox),
        blockType: this.detectBlockType(block),
      };
    });

    return {
      pageNumber,
      text: data.text,
      confidence: data.confidence,
      blocks,
      width: pageMeta.imageWidth ?? pageMeta.width ?? 0,
      height: pageMeta.imageHeight ?? pageMeta.height ?? 0,
    };
  }

  /**
   * Create bounding box object
   */
  private createBbox(bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): BoundingBox {
    return {
      x0: bbox.x0,
      y0: bbox.y0,
      x1: bbox.x1,
      y1: bbox.y1,
      width: bbox.x1 - bbox.x0,
      height: bbox.y1 - bbox.y0,
    };
  }

  /**
   * Detect the type of text block
   */
  private detectBlockType(block: { text?: string }): OCRBlock["blockType"] {
    const text = block.text || "";

    // Simple heuristics for block type detection
    if (this.looksLikeTable(text)) {
      return "table";
    }

    if (text.trim().length === 0) {
      return "unknown";
    }

    return "text";
  }

  /**
   * Check if text looks like a table
   */
  private looksLikeTable(text: string): boolean {
    const lines = text.split("\n").filter((l) => l.trim());

    if (lines.length < 2) return false;

    // Check for consistent column-like structure
    const tabCounts = lines.map((line) => (line.match(/\t/g) || []).length);
    const spaceCounts = lines.map(
      (line) => (line.match(/\s{2,}/g) || []).length
    );

    // If most lines have similar number of tabs or multiple spaces, likely a table
    const avgTabs = tabCounts.reduce((a, b) => a + b, 0) / lines.length;
    const avgSpaces = spaceCounts.reduce((a, b) => a + b, 0) / lines.length;

    return avgTabs >= 1 || avgSpaces >= 2;
  }

  /**
   * Terminate the worker
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.initialized = false;
    }
  }
}

/**
 * Create and process with a one-off OCR instance
 */
export async function processImage(
  input: string | Buffer | Blob,
  options?: Partial<OCROptions>,
  onProgress?: ProgressCallback
): Promise<OCRResult> {
  const processor = new OCRProcessor(options);

  try {
    await processor.initialize();
    return await processor.processImage(input, onProgress);
  } finally {
    await processor.terminate();
  }
}

export default OCRProcessor;
