import { OCRProcessor } from "./processor";
import type {
  OCRResult,
  OCRBlock,
  BOQExtractionResult,
  ExtractedBOQItem,
  ExtractedTable,
  TableRow,
  TableCell,
  BOQExtractionOptions,
  BoundingBox,
  ProgressCallback,
} from "./types";

// Common BOQ column headers
const COMMON_HEADERS = {
  itemNo: ["item", "no", "no.", "s/n", "s.no", "sl", "sl."],
  description: ["description", "particulars", "item description", "scope"],
  specification: ["specification", "spec", "specs", "details"],
  unit: ["unit", "uom", "u/m"],
  quantity: ["qty", "quantity", "quan", "q'ty"],
  rate: ["rate", "unit rate", "price", "unit price"],
  amount: ["amount", "total", "value", "sum"],
};

type ColumnMap = {
  itemNo: number;
  description: number;
  specification: number;
  unit: number;
  quantity: number;
  rate: number;
  amount: number;
};

/**
 * Extract BOQ data from OCR results
 */
export class BOQExtractor {
  private options: BOQExtractionOptions;

  constructor(options: Partial<BOQExtractionOptions> = {}) {
    this.options = {
      minConfidence: 60,
      matchToLibrary: false,
      ...options,
    };
  }

  /**
   * Extract BOQ from an image or document
   */
  async extractFromImage(
    input: string | Buffer | Blob,
    onProgress?: ProgressCallback
  ): Promise<BOQExtractionResult> {
    const processor = new OCRProcessor(this.options);

    try {
      await processor.initialize();

      onProgress?.({ status: "Running OCR", progress: 10 });
      const ocrResult = await processor.processImage(input);

      onProgress?.({ status: "Extracting BOQ data", progress: 50 });
      return this.extractFromOCRResult(ocrResult);
    } finally {
      await processor.terminate();
    }
  }

  /**
   * Extract BOQ from OCR result
   */
  extractFromOCRResult(ocrResult: OCRResult): BOQExtractionResult {
    const warnings: string[] = [];
    const tables: ExtractedTable[] = [];
    const items: ExtractedBOQItem[] = [];

    for (const page of ocrResult.pages) {
      // Find table-like blocks
      const tableBlocks = page.blocks.filter(
        (block) =>
          block.blockType === "table" ||
          this.looksLikeTable(block.text)
      );

      for (const block of tableBlocks) {
        const table = this.parseTable(block);
        if (table) {
          tables.push(table);

          // Try to extract BOQ items from table
          const extractedItems = this.extractItemsFromTable(
            table,
            page.pageNumber,
            block.bbox
          );
          items.push(...extractedItems);
        }
      }

      // Also try to extract from text blocks that might be formatted BOQ
      const textBlocks = page.blocks.filter(
        (block) => block.blockType === "text"
      );

      for (const block of textBlocks) {
        const extractedItems = this.extractItemsFromText(
          block,
          page.pageNumber
        );
        items.push(...extractedItems);
      }
    }

    if (items.length === 0) {
      warnings.push("No BOQ items could be extracted from the document");
    }

    // Remove duplicates
    const uniqueItems = this.deduplicateItems(items);

    return {
      items: uniqueItems,
      tables,
      rawText: ocrResult.fullText,
      confidence: ocrResult.averageConfidence,
      warnings,
    };
  }

  /**
   * Check if text looks like a table
   */
  private looksLikeTable(text: string): boolean {
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 3) return false;

    // Check for multiple columns
    const hasMultipleColumns = lines.some(
      (line) =>
        (line.match(/\t/g) || []).length >= 2 ||
        (line.match(/\s{3,}/g) || []).length >= 2
    );

    // Check for BOQ-like headers
    const firstLines = lines.slice(0, 3).join(" ").toLowerCase();
    const hasBOQHeaders = Object.values(COMMON_HEADERS).some((headers) =>
      headers.some((h) => firstLines.includes(h))
    );

    return hasMultipleColumns || hasBOQHeaders;
  }

  /**
   * Parse a text block into a table structure
   */
  private parseTable(block: OCRBlock): ExtractedTable | null {
    const lines = block.lines;
    if (lines.length < 2) return null;

    const rows: TableRow[] = [];
    let headers: string[] = [];
    let columnCount = 0;

    for (const [i, line] of lines.entries()) {
      const cells = this.splitIntoCells(line.text);

      if (i === 0) {
        // First row is likely headers
        headers = cells.map((c) => c.toLowerCase().trim());
        columnCount = cells.length;
      }

      const rowCells: TableCell[] = cells.map((text, colIndex) => ({
        text,
        row: i,
        column: colIndex,
        rowSpan: 1,
        colSpan: 1,
        confidence: line.confidence,
        bbox: line.bbox,
      }));

      rows.push({ cells: rowCells, rowIndex: i });
    }

    return {
      rows,
      headers,
      columnCount,
      rowCount: rows.length,
      bbox: block.bbox,
      confidence: block.confidence,
    };
  }

  /**
   * Split a line of text into cells
   */
  private splitIntoCells(text: string): string[] {
    // Try tab separation first
    if (text.includes("\t")) {
      return text.split("\t").map((c) => c.trim());
    }

    // Try multiple space separation
    return text
      .split(/\s{2,}/)
      .map((c) => c.trim())
      .filter((c) => c);
  }

  /**
   * Extract BOQ items from a parsed table
   */
  private extractItemsFromTable(
    table: ExtractedTable,
    pageNumber: number,
    bbox: BoundingBox
  ): ExtractedBOQItem[] {
    const items: ExtractedBOQItem[] = [];

    // Map column indices
    const columnMap = this.mapColumns(table.headers);

    if (columnMap.description === -1) {
      // Can't extract without description column
      return items;
    }

    // Skip header row
    for (const [i, row] of table.rows.entries()) {
      if (i === 0) {
        continue;
      }
      const cells = row.cells;

      try {
        const item: ExtractedBOQItem = {
          itemNo: this.getCellValue(cells, columnMap.itemNo) || String(i),
          description: this.getCellValue(cells, columnMap.description) || "",
          specification: this.getCellValue(cells, columnMap.specification),
          unit: this.getCellValue(cells, columnMap.unit) || "NOS",
          quantity: this.parseNumber(
            this.getCellValue(cells, columnMap.quantity)
          ),
          unitRate: this.parseNumber(this.getCellValue(cells, columnMap.rate)),
          total: this.parseNumber(this.getCellValue(cells, columnMap.amount)),
          confidence: table.confidence,
          sourceLocation: { page: pageNumber, bbox },
        };

        // Validate item
        if (item.description.length > 0 && item.quantity > 0) {
          items.push(item);
        }
      } catch (error) {
        // Skip invalid rows
        continue;
      }
    }

    return items;
  }

  /**
   * Map header names to column indices
   */
  private mapColumns(headers: string[]): ColumnMap {
    const map: ColumnMap = {
      itemNo: -1,
      description: -1,
      specification: -1,
      unit: -1,
      quantity: -1,
      rate: -1,
      amount: -1,
    };

    headers.forEach((header, index) => {
      const normalized = header.toLowerCase().trim();

      for (const [key, patterns] of Object.entries(COMMON_HEADERS) as [
        keyof ColumnMap,
        string[],
      ][]) {
        if (patterns.some((p) => normalized.includes(p))) {
          map[key] = index;
          break;
        }
      }
    });

    return map;
  }

  /**
   * Get cell value by column index
   */
  private getCellValue(cells: TableCell[], index: number): string | undefined {
    if (index < 0 || index >= cells.length) return undefined;
    return cells[index]?.text?.trim();
  }

  /**
   * Parse a string to number
   */
  private parseNumber(value: string | undefined): number {
    if (!value) return 0;

    // Remove currency symbols, commas, etc.
    const cleaned = value.replace(/[^0-9.-]/g, "");
    const num = parseFloat(cleaned);

    return isNaN(num) ? 0 : num;
  }

  /**
   * Extract BOQ items from text blocks (non-tabular)
   */
  private extractItemsFromText(
    block: OCRBlock,
    pageNumber: number
  ): ExtractedBOQItem[] {
    const items: ExtractedBOQItem[] = [];
    const text = block.text;

    // Pattern for BOQ-like entries
    // e.g., "1.1 Supply rectangular duct 600x400mm - 45 LM @ $120/LM"
    const pattern =
      /(\d+(?:\.\d+)?)\s*[-.)]\s*(.+?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(LM|NOS|M|KG|SET|LOT|UNIT)/gi;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const [, itemNo = "", description = "", quantityRaw = "", unitRaw = "NOS"] =
        match;
      const quantity = parseFloat(quantityRaw);
      if (!itemNo || !description || Number.isNaN(quantity)) {
        continue;
      }

      items.push({
        itemNo,
        description: description.trim(),
        unit: unitRaw.toUpperCase(),
        quantity,
        confidence: block.confidence,
        sourceLocation: { page: pageNumber, bbox: block.bbox },
      });
    }

    return items;
  }

  /**
   * Remove duplicate items
   */
  private deduplicateItems(items: ExtractedBOQItem[]): ExtractedBOQItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.itemNo}-${item.description.substring(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

/**
 * Extract BOQ from an image or document
 */
export async function extractBOQ(
  input: string | Buffer | Blob,
  options?: Partial<BOQExtractionOptions>,
  onProgress?: ProgressCallback
): Promise<BOQExtractionResult> {
  const extractor = new BOQExtractor(options);
  return extractor.extractFromImage(input, onProgress);
}

export default BOQExtractor;
