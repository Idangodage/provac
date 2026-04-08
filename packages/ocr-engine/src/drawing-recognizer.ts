import { OCRProcessor } from "./processor";
import type {
  OCRResult,
  DrawingRecognitionResult,
  RecognizedElement,
  RecognizedDimension,
  DrawingRecognitionOptions,
  BoundingBox,
  ProgressCallback,
} from "./types";

// Dimension patterns
const DIMENSION_PATTERNS = [
  // Metric: 600x400, 600×400, 600 x 400
  /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|m|cm)?/gi,
  // Diameter: Ø200, ø200mm, dia 200
  /[Øø]?\s*(?:dia\.?|diameter)?\s*(\d+(?:\.\d+)?)\s*(mm|m|cm)?/gi,
  // Length: 1500mm, 1.5m
  /(\d+(?:\.\d+)?)\s*(mm|m|cm|LM|lm)/gi,
];

// HVAC-related keywords for element detection
const HVAC_KEYWORDS = {
  duct: ["duct", "ducting", "ductwork", "supply duct", "return duct", "sa", "ra"],
  elbow: ["elbow", "bend", "90°", "45°", "radius"],
  tee: ["tee", "branch", "junction"],
  diffuser: [
    "diffuser",
    "supply diffuser",
    "ceiling diffuser",
    "sq diff",
    "rnd diff",
  ],
  grille: ["grille", "return grille", "exhaust grille", "louver"],
  damper: ["damper", "vcd", "fire damper", "fd", "smoke damper", "sd"],
  equipment: [
    "ahu",
    "fcu",
    "fan coil",
    "air handling",
    "package unit",
    "vrf",
    "vrv",
  ],
};

/**
 * Recognize HVAC elements in drawings
 */
export class DrawingRecognizer {
  private options: DrawingRecognitionOptions;

  constructor(options: Partial<DrawingRecognitionOptions> = {}) {
    this.options = {
      minConfidence: 50,
      model: "basic",
      ...options,
    };
  }

  /**
   * Recognize elements from an image
   */
  async recognizeFromImage(
    input: string | Buffer | Blob,
    onProgress?: ProgressCallback
  ): Promise<DrawingRecognitionResult> {
    const processor = new OCRProcessor(this.options);

    try {
      await processor.initialize();

      onProgress?.({ status: "Running OCR", progress: 10 });
      const ocrResult = await processor.processImage(input);

      onProgress?.({ status: "Analyzing drawing", progress: 50 });
      return this.analyzeDrawing(ocrResult);
    } finally {
      await processor.terminate();
    }
  }

  /**
   * Analyze OCR result for HVAC elements
   */
  analyzeDrawing(ocrResult: OCRResult): DrawingRecognitionResult {
    const elements: RecognizedElement[] = [];
    const dimensions: RecognizedDimension[] = [];
    const textLabels = ocrResult.pages.flatMap((p) => p.blocks);

    for (const page of ocrResult.pages) {
      for (const block of page.blocks) {
        // Extract dimensions
        const blockDimensions = this.extractDimensions(block.text, block.bbox);
        dimensions.push(...blockDimensions);

        // Try to identify HVAC elements from text
        const identifiedElements = this.identifyElements(block);
        elements.push(...identifiedElements);
      }
    }

    // Calculate overall confidence
    const avgConfidence =
      elements.length > 0
        ? elements.reduce((sum, e) => sum + e.confidence, 0) / elements.length
        : ocrResult.averageConfidence;

    return {
      elements,
      dimensions,
      textLabels,
      confidence: avgConfidence,
    };
  }

  /**
   * Extract dimension values from text
   */
  private extractDimensions(
    text: string,
    bbox: BoundingBox
  ): RecognizedDimension[] {
    const dimensions: RecognizedDimension[] = [];

    for (const pattern of DIMENSION_PATTERNS) {
      let match: RegExpExecArray | null;
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;

      while ((match = pattern.exec(text)) !== null) {
        const valueRaw = match[1];
        if (!valueRaw) {
          continue;
        }

        const value = parseFloat(valueRaw);
        const unit = (match[match.length - 1] ?? "mm").toLowerCase();

        if (!isNaN(value) && value > 0) {
          dimensions.push({
            value,
            unit: this.normalizeUnit(unit),
            bbox,
            confidence: 80, // Default confidence for regex matches
          });
        }
      }
    }

    return dimensions;
  }

  /**
   * Normalize unit string
   */
  private normalizeUnit(unit: string): string {
    const normalized = unit.toLowerCase();

    if (["m", "meter", "meters"].includes(normalized)) return "m";
    if (["mm", "millimeter", "millimeters"].includes(normalized)) return "mm";
    if (["cm", "centimeter", "centimeters"].includes(normalized)) return "cm";
    if (["lm", "linear meter", "linear meters"].includes(normalized)) return "LM";

    return normalized;
  }

  /**
   * Identify HVAC elements from text block
   */
  private identifyElements(block: { text: string; confidence: number; bbox: BoundingBox }): RecognizedElement[] {
    const elements: RecognizedElement[] = [];
    const textLower = block.text.toLowerCase();

    for (const [elementType, keywords] of Object.entries(HVAC_KEYWORDS)) {
      for (const keyword of keywords) {
        if (textLower.includes(keyword)) {
          // Check if we haven't already identified this type for this bbox
          const alreadyIdentified = elements.some(
            (e) =>
              e.type === elementType &&
              e.bbox.x0 === block.bbox.x0 &&
              e.bbox.y0 === block.bbox.y0
          );

          if (!alreadyIdentified) {
            elements.push({
              type: elementType as RecognizedElement["type"],
              confidence: block.confidence,
              bbox: block.bbox,
              properties: this.extractProperties(block.text, elementType),
            });
            break; // Only identify once per type per block
          }
        }
      }
    }

    return elements;
  }

  /**
   * Extract properties from element text
   */
  private extractProperties(
    text: string,
    elementType: string
  ): Record<string, unknown> {
    const properties: Record<string, unknown> = {};

    // Extract size dimensions
    const sizeMatch = text.match(
      /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm)?/i
    );
    if (sizeMatch) {
      const [, widthRaw = "", heightRaw = ""] = sizeMatch;
      if (widthRaw && heightRaw) {
        properties.width = parseFloat(widthRaw);
        properties.height = parseFloat(heightRaw);
      }
    }

    // Extract diameter
    const diaMatch = text.match(/[Øø]?\s*(\d+(?:\.\d+)?)\s*(mm)?/i);
    if (diaMatch && !sizeMatch) {
      const [, diameterRaw = ""] = diaMatch;
      if (diameterRaw) {
        properties.diameter = parseFloat(diameterRaw);
      }
    }

    // Extract angle for elbows
    if (elementType === "elbow") {
      const angleMatch = text.match(/(\d+)\s*°|deg/i);
      if (angleMatch) {
        const [, angleRaw = ""] = angleMatch;
        if (angleRaw) {
          properties.angle = parseInt(angleRaw, 10);
        }
      }
    }

    // Extract material
    const materialPatterns = [
      { pattern: /galvanized|gi|gal/i, material: "galvanized" },
      { pattern: /stainless|ss/i, material: "stainless_steel" },
      { pattern: /aluminum|al/i, material: "aluminum" },
    ];

    for (const { pattern, material } of materialPatterns) {
      if (pattern.test(text)) {
        properties.material = material;
        break;
      }
    }

    return properties;
  }
}

/**
 * Recognize HVAC elements from a drawing image
 */
export async function recognizeDrawing(
  input: string | Buffer | Blob,
  options?: Partial<DrawingRecognitionOptions>,
  onProgress?: ProgressCallback
): Promise<DrawingRecognitionResult> {
  const recognizer = new DrawingRecognizer(options);
  return recognizer.recognizeFromImage(input, onProgress);
}

export default DrawingRecognizer;
