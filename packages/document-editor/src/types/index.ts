// ============================================================================
// Document Editor Types
// ============================================================================

// Tool Types
export type ToolType = 
  | 'select' 
  | 'text' 
  | 'rectangle' 
  | 'circle' 
  | 'line' 
  | 'image' 
  | 'signature'
  | 'table';

export type InteractiveToolType = 'calculator' | 'signature-pad' | null;

// ============================================================================
// Element Types
// ============================================================================

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  backgroundColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;
  letterSpacing: number;
}

export const defaultTextStyle: TextStyle = {
  fontFamily: 'Arial',
  fontSize: 12,
  color: '#000000',
  backgroundColor: 'transparent',
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  align: 'left',
  lineHeight: 1.4,
  letterSpacing: 0,
};

export interface AdvancedStyle {
  opacity?: number;
  transform?: {
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
  };
  boxShadow?: {
    x: number;
    y: number;
    blur: number;
    spread: number;
    color: string;
  };
  border?: {
    width: number;
    style: 'solid' | 'dashed' | 'dotted';
    color: string;
    radius: number;
  };
}

// Base Element
export interface BaseElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  locked: boolean;
  visible: boolean;
  zIndex: number;
  advancedStyle?: AdvancedStyle;
}

// Text Element
export interface TextElement extends BaseElement {
  type: 'text';
  content: string;
  richContent?: string;
  textStyle: TextStyle;
}

// Table Element
export interface TableElement extends BaseElement {
  type: 'table';
  data: string | any[][];
  tableStyle?: {
    headerBgColor: string;
    headerTextColor: string;
    borderColor: string;
    alternateRowColor: string;
  };
}

// Rectangle Element
export interface RectangleElement extends BaseElement {
  type: 'rectangle';
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  borderRadius?: number;
}

// Circle Element
export interface CircleElement extends BaseElement {
  type: 'circle';
  radius: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
}

// Line Element
export interface LineElement extends BaseElement {
  type: 'line';
  x2: number;
  y2: number;
  strokeColor: string;
  strokeWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  arrowStart: boolean;
  arrowEnd: boolean;
}

// Image Element
export interface ImageElement extends BaseElement {
  type: 'image';
  src: string | null;
  placeholder: string;
  objectFit: 'contain' | 'cover' | 'fill' | 'none';
  alt?: string;
}

// Signature Element
export interface SignatureElement extends BaseElement {
  type: 'signature';
  signatureData: string | null;
  placeholder: string;
  signedBy?: string;
  signedAt?: string;
}

// Union type for all elements
export type EditorElement = 
  | TextElement 
  | TableElement 
  | RectangleElement 
  | CircleElement 
  | LineElement 
  | ImageElement 
  | SignatureElement;

// ============================================================================
// Canvas Types
// ============================================================================

export type PageOrientation = 'portrait' | 'landscape';

export interface PageConfig {
  width: number;
  height: number;
  orientation: PageOrientation;
  margins?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface PageLayout {
  id: string;
  label: string;
  width: number;
  height: number;
  orientation: PageOrientation;
}

export const PAGE_LAYOUTS: PageLayout[] = [
  { id: 'letter-portrait', label: 'Letter (Portrait)', width: 816, height: 1056, orientation: 'portrait' },
  { id: 'letter-landscape', label: 'Letter (Landscape)', width: 1056, height: 816, orientation: 'landscape' },
  { id: 'a4-portrait', label: 'A4 (Portrait)', width: 794, height: 1123, orientation: 'portrait' },
  { id: 'a4-landscape', label: 'A4 (Landscape)', width: 1123, height: 794, orientation: 'landscape' },
  { id: 'legal-portrait', label: 'Legal (Portrait)', width: 816, height: 1344, orientation: 'portrait' },
  { id: 'legal-landscape', label: 'Legal (Landscape)', width: 1344, height: 816, orientation: 'landscape' },
];

export interface HeaderFooterConfig {
  enabled: boolean;
  height: number;
  content?: string;
}

// ============================================================================
// Alignment & Snapping Types
// ============================================================================

export interface AlignmentGuide {
  type: 'horizontal' | 'vertical';
  position: number;
  strength: 'element' | 'grid' | 'minor';
}

export interface SnapConfig {
  snapToGrid: boolean;
  snapToElements: boolean;
  snapThreshold: number;
  gridSize: number;
}

// ============================================================================
// Ruler Types
// ============================================================================

export interface RulerMetrics {
  offsetX: number;
  offsetY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface RulerTick {
  value: number;
  pos: number;
}

export interface RulerTickData {
  major: RulerTick[];
  minor: RulerTick[];
  majorStep: number;
}

// ============================================================================
// Grid Constants
// ============================================================================

export const GRID_CONSTANTS = {
  PX_PER_INCH: 96,
  MM_PER_INCH: 25.4,
  get PX_TO_MM() { return this.MM_PER_INCH / this.PX_PER_INCH; },
  get MM_TO_PX() { return this.PX_PER_INCH / this.MM_PER_INCH; },
  RULER_GAP_X_MM: 5,
  RULER_GAP_Y_MM: 2,
  RULER_TOOLBAR_GAP_MM: 2,
  BASE_PADDING_PX: 40,
  GRID_MINOR_STEP_PX: 25.4 / 96, // 1mm in px
  GRID_MAJOR_STEP_PX: (25.4 / 96) * 5, // 5mm in px
  GUIDE_MAIN_COLOR: '#7b2cbf',
  GUIDE_SUB_COLOR: '#c77dff',
  MINOR_GRID_COLOR: 'rgba(0, 0, 0, 0.06)',
  MAJOR_GRID_COLOR: 'rgba(0, 0, 0, 0.14)',
} as const;

// ============================================================================
// Form Data Types (for Covering Letter)
// ============================================================================

export interface QuotationFormData {
  quotationNumber: string;
  quotationDate: string;
  validityDays: number;
  
  // Customer Details
  customerName: string;
  contactPerson: string;
  customerAddress: string;
  contactEmail: string;
  contactPhone: string;
  
  // Project Details
  projectName: string;
  projectLocation: string;
  projectArea: string;
  buildingType: string;
  
  // Financial Details
  currency: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  
  // Terms
  deliveryPeriod: string;
  warrantyTerms: string;
  paymentTerms: string;
}

export const defaultFormData: QuotationFormData = {
  quotationNumber: `QT-${new Date().getFullYear()}-001`,
  quotationDate: new Date().toLocaleDateString(),
  validityDays: 30,
  customerName: '',
  contactPerson: '',
  customerAddress: '',
  contactEmail: '',
  contactPhone: '',
  projectName: '',
  projectLocation: '',
  projectArea: '',
  buildingType: 'Commercial Office',
  currency: 'AED',
  subtotal: 0,
  taxRate: 5,
  taxAmount: 0,
  totalAmount: 0,
  deliveryPeriod: '4-6 weeks',
  warrantyTerms: '2 years comprehensive',
  paymentTerms: '30% advance, 50% on delivery, 20% after installation',
};

// ============================================================================
// BOQ Types
// ============================================================================

export interface BOQItem {
  id: string;
  description: string;
  model: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  tax: number;
  total: number;
}

export interface BOQCategory {
  id: string;
  category: string;
  items: BOQItem[];
}

// ============================================================================
// History Types
// ============================================================================

export interface HistoryEntry {
  elements: EditorElement[];
  timestamp: number;
}

// ============================================================================
// Editor State Types
// ============================================================================

export interface EditorState {
  // Elements
  elements: EditorElement[];
  selectedElement: string | null;
  
  // Tools
  selectedTool: ToolType;
  activeInteractiveTool: InteractiveToolType;
  
  // View Settings
  zoom: number;
  showGrid: boolean;
  showRulers: boolean;
  snapToGrid: boolean;
  snapToElements: boolean;
  
  // Page Configuration
  pageConfig: PageConfig;
  headerConfig: HeaderFooterConfig;
  footerConfig: HeaderFooterConfig;
  
  // Editing State
  isEditing: boolean;
  editingElementId: string | null;
  isDragging: boolean;
  
  // Form Data
  formData: QuotationFormData;
  boqData: BOQCategory[];
  
  // Navigation
  activeTab: 'form' | 'editor' | 'preview';
  
  // History
  history: HistoryEntry[];
  historyIndex: number;
  isDirty: boolean;
  lastSaved: string | null;
}

// ============================================================================
// Export Types
// ============================================================================

export interface ExportOptions {
  elements: EditorElement[];
  pageConfig: PageConfig;
  formData: QuotationFormData;
  boqData: BOQCategory[];
  filename: string;
  quality: 'low' | 'medium' | 'high';
}

export interface ImportedData {
  elements: EditorElement[];
  pageConfig: PageConfig;
  formData: QuotationFormData;
  boqData: BOQCategory[];
}
