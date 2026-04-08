import type { ExportOptions, ImportedData, EditorElement, PageConfig, QuotationFormData, BOQCategory } from '../types';

/**
 * Export document to PDF.
 * Note: This requires a PDF library like html2pdf.js or jsPDF to be installed.
 * For now, this creates a print-friendly version.
 */
export const exportToPDF = async (options: ExportOptions): Promise<void> => {
  const { elements, pageConfig, filename, quality } = options;
  // formData and boqData are available in options for future enhancements

  // Create a temporary container for the PDF content
  const container = document.createElement('div');
  container.id = 'pdf-export-container';
  container.style.cssText = `
    position: fixed;
    left: -9999px;
    top: 0;
    width: ${pageConfig.width}px;
    min-height: ${pageConfig.height}px;
    background: white;
    font-family: Arial, sans-serif;
  `;

  // Render elements to the container
  elements.forEach((element) => {
    if (!element.visible) return;
    const el = renderElementToHTML(element);
    if (el) container.appendChild(el);
  });

  document.body.appendChild(container);

  try {
    // Try to use html2pdf if available
    if (typeof window !== 'undefined' && (window as any).html2pdf) {
      const html2pdf = (window as any).html2pdf;
      await html2pdf()
        .set({
          margin: 0,
          filename,
          image: { type: 'jpeg', quality: quality === 'high' ? 0.98 : quality === 'medium' ? 0.92 : 0.8 },
          html2canvas: { scale: quality === 'high' ? 2 : 1 },
          jsPDF: {
            unit: 'px',
            format: [pageConfig.width, pageConfig.height],
            orientation: pageConfig.orientation,
          },
        })
        .from(container)
        .save();
    } else {
      // Fallback to print
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>${filename}</title>
            <style>
              @page { size: ${pageConfig.orientation === 'landscape' ? 'landscape' : 'portrait'}; margin: 0; }
              body { margin: 0; padding: 0; }
              #content { width: ${pageConfig.width}px; min-height: ${pageConfig.height}px; position: relative; }
            </style>
          </head>
          <body>
            <div id="content">${container.innerHTML}</div>
            <script>window.onload = function() { window.print(); window.close(); }</script>
          </body>
          </html>
        `);
        printWindow.document.close();
      }
    }
  } finally {
    document.body.removeChild(container);
  }
};

/**
 * Render an element to HTML for export.
 */
const renderElementToHTML = (element: EditorElement): HTMLElement | null => {
  const div = document.createElement('div');
  div.style.cssText = `
    position: absolute;
    left: ${element.x}px;
    top: ${element.y}px;
    width: ${element.width}px;
    height: ${element.height}px;
    z-index: ${element.zIndex};
    ${element.advancedStyle?.opacity ? `opacity: ${element.advancedStyle.opacity / 100};` : ''}
    ${element.advancedStyle?.transform?.rotation ? `transform: rotate(${element.advancedStyle.transform.rotation}deg);` : ''}
    ${element.advancedStyle?.border?.radius ? `border-radius: ${element.advancedStyle.border.radius}px;` : ''}
  `;

  switch (element.type) {
    case 'text': {
      const style = element.textStyle;
      div.style.cssText += `
        font-family: ${style.fontFamily};
        font-size: ${style.fontSize}px;
        color: ${style.color};
        background-color: ${style.backgroundColor !== 'transparent' ? style.backgroundColor : 'transparent'};
        font-weight: ${style.bold ? 'bold' : 'normal'};
        font-style: ${style.italic ? 'italic' : 'normal'};
        text-decoration: ${style.underline ? 'underline' : style.strikethrough ? 'line-through' : 'none'};
        text-align: ${style.align};
        line-height: ${style.lineHeight};
        letter-spacing: ${style.letterSpacing}px;
        white-space: pre-wrap;
        padding: 5px;
        overflow: hidden;
        box-sizing: border-box;
      `;
      if (element.richContent) {
        div.innerHTML = element.richContent;
      } else {
        div.textContent = element.content;
      }
      return div;
    }

    case 'rectangle':
      div.style.cssText += `
        background-color: ${element.fillColor};
        border: ${element.strokeWidth}px solid ${element.strokeColor};
        box-sizing: border-box;
      `;
      return div;

    case 'circle':
      div.style.cssText += `
        width: ${element.radius * 2}px;
        height: ${element.radius * 2}px;
        border-radius: 50%;
        background-color: ${element.fillColor};
        border: ${element.strokeWidth}px solid ${element.strokeColor};
        box-sizing: border-box;
      `;
      return div;

    case 'line': {
      const length = Math.sqrt(
        Math.pow(element.x2 - element.x, 2) + Math.pow(element.y2 - element.y, 2)
      );
      const angle = Math.atan2(element.y2 - element.y, element.x2 - element.x) * 180 / Math.PI;
      div.style.cssText = `
        position: absolute;
        left: ${element.x}px;
        top: ${element.y}px;
        width: ${length}px;
        height: ${element.strokeWidth}px;
        background-color: ${element.strokeColor};
        transform: rotate(${angle}deg);
        transform-origin: 0 0;
      `;
      return div;
    }

    case 'image':
      if (element.src) {
        const img = document.createElement('img');
        img.src = element.src;
        img.style.cssText = `
          width: 100%;
          height: 100%;
          object-fit: ${element.objectFit};
        `;
        div.appendChild(img);
      }
      return div;

    case 'signature':
      if (element.signatureData) {
        const img = document.createElement('img');
        img.src = element.signatureData;
        img.style.cssText = `
          max-width: 100%;
          max-height: 80%;
        `;
        div.appendChild(img);
        if (element.signedBy) {
          const name = document.createElement('div');
          name.textContent = `Signed by: ${element.signedBy}`;
          name.style.cssText = 'font-size: 10px; color: #666; text-align: center;';
          div.appendChild(name);
        }
        div.style.cssText += 'display: flex; flex-direction: column; align-items: center; justify-content: center;';
      }
      return div;

    default:
      return null;
  }
};

/**
 * Export document data to JSON string.
 */
export const exportToJSON = (data: {
  elements: EditorElement[];
  pageConfig: PageConfig;
  formData: QuotationFormData;
  boqData: BOQCategory[];
}): string => {
  return JSON.stringify({
    ...data,
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
  }, null, 2);
};

/**
 * Import document data from JSON string.
 */
export const importFromJSON = (json: string): ImportedData | null => {
  try {
    const data = JSON.parse(json);
    return {
      elements: data.elements || [],
      pageConfig: data.pageConfig || { width: 816, height: 1056, orientation: 'portrait' },
      formData: data.formData || {},
      boqData: data.boqData || [],
    };
  } catch (error) {
    console.error('Failed to parse JSON:', error);
    return null;
  }
};

/**
 * Calculate document totals from BOQ data.
 */
export const calculateTotals = (
  boqData: BOQCategory[],
  taxRate: number
): { subtotal: number; taxAmount: number; totalAmount: number } => {
  let subtotal = 0;
  
  boqData.forEach((category) => {
    category.items.forEach((item) => {
      subtotal += item.total;
    });
  });
  
  const taxAmount = subtotal * (taxRate / 100);
  const totalAmount = subtotal + taxAmount;
  
  return { subtotal, taxAmount, totalAmount };
};

/**
 * Generate unique element ID.
 */
export const generateElementId = (): string => {
  return `element-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
