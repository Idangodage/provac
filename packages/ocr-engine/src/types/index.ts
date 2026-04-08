// ============================================================================
// OCR Result Types
// ============================================================================

export interface OCRWord {
  text: string;
  confidence: number;
  bbox: BoundingBox;
}

export interface OCRLine {
  text: string;
  confidence: number;
  words: OCRWord[];
  bbox: BoundingBox;
}

export interface OCRBlock {
  text: string;
  confidence: number;
  lines: OCRLine[];
  bbox: BoundingBox;
  blockType: "text" | "table" | "image" | "unknown";
}

export interface OCRPage {
  pageNumber: number;
  text: string;
  confidence: number;
  blocks: OCRBlock[];
  width: number;
  height: number;
}

export interface OCRResult {
  pages: OCRPage[];
  fullText: string;
  averageConfidence: number;
  processingTime: number;
}

// ============================================================================
// Bounding Box
// ============================================================================

export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

// ============================================================================
// Table Extraction Types
// ============================================================================

export interface TableCell {
  text: string;
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  confidence: number;
  bbox: BoundingBox;
}

export interface TableRow {
  cells: TableCell[];
  rowIndex: number;
}

export interface ExtractedTable {
  rows: TableRow[];
  headers: string[];
  columnCount: number;
  rowCount: number;
  bbox: BoundingBox;
  confidence: number;
}

// ============================================================================
// BOQ Extraction Types
// ============================================================================

export interface ExtractedBOQItem {
  itemNo: string;
  description: string;
  specification?: string;
  unit: string;
  quantity: number;
  unitRate?: number;
  total?: number;
  confidence: number;
  sourceLocation: {
    page: number;
    bbox: BoundingBox;
  };
}

export interface BOQExtractionResult {
  items: ExtractedBOQItem[];
  tables: ExtractedTable[];
  rawText: string;
  confidence: number;
  warnings: string[];
}

// ============================================================================
// Drawing Recognition Types
// ============================================================================

export interface RecognizedElement {
  type:
    | "duct"
    | "elbow"
    | "tee"
    | "diffuser"
    | "grille"
    | "equipment"
    | "damper"
    | "text"
    | "dimension"
    | "unknown";
  confidence: number;
  bbox: BoundingBox;
  properties: Record<string, unknown>;
}

export interface RecognizedDimension {
  value: number;
  unit: string;
  bbox: BoundingBox;
  confidence: number;
}

export interface DrawingRecognitionResult {
  elements: RecognizedElement[];
  dimensions: RecognizedDimension[];
  textLabels: OCRBlock[];
  confidence: number;
}

// ============================================================================
// Processing Options
// ============================================================================

export interface OCROptions {
  /** Language(s) for OCR (default: 'eng') */
  language?: string | string[];
  /** Page segmentation mode */
  pageSegMode?: number;
  /** Enable table detection */
  detectTables?: boolean;
  /** Preprocessing options */
  preprocess?: PreprocessOptions;
  /** Maximum pages to process (for PDFs) */
  maxPages?: number;
  /** Worker count for parallel processing */
  workerCount?: number;
}

export interface PreprocessOptions {
  /** Convert to grayscale */
  grayscale?: boolean;
  /** Apply contrast enhancement */
  enhanceContrast?: boolean;
  /** Remove noise */
  denoise?: boolean;
  /** Deskew image */
  deskew?: boolean;
  /** Binarization threshold (0-255) */
  threshold?: number;
}

export interface BOQExtractionOptions extends OCROptions {
  /** Expected columns in BOQ */
  expectedColumns?: string[];
  /** Minimum confidence for item extraction */
  minConfidence?: number;
  /** Try to match items to HVAC component library */
  matchToLibrary?: boolean;
}

export interface DrawingRecognitionOptions extends OCROptions {
  /** Recognition model to use */
  model?: "basic" | "advanced";
  /** Minimum confidence for element recognition */
  minConfidence?: number;
  /** Expected drawing scale */
  scale?: string;
}

// ============================================================================
// Progress Callback Types
// ============================================================================

export interface ProgressInfo {
  status: string;
  progress: number;
  page?: number;
  totalPages?: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;
