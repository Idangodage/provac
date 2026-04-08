// ============================================================================
// Organization Types
// ============================================================================

export interface OrganizationInfo {
  name: string;
  logo?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  registrationNumber?: string;
}

// ============================================================================
// Project Types
// ============================================================================

export interface ProjectInfo {
  name: string;
  clientName?: string;
  clientContact?: string;
  clientAddress?: string;
  location?: string;
  reference?: string;
  date: Date;
}

// ============================================================================
// BOQ Types
// ============================================================================

export interface BOQItem {
  itemNo: string;
  description: string;
  specification?: string;
  unit: string;
  quantity: number;
  unitRate: number;
  materialCost: number;
  labourCost: number;
  totalCost: number;
  category: string;
}

export interface BOQCategory {
  name: string;
  items: BOQItem[];
  subtotal: number;
}

export interface BOQSummary {
  categories: BOQCategory[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

// ============================================================================
// Proposal Types
// ============================================================================

export interface ProposalTotals {
  subtotal: number;
  overhead?: number;
  overheadRate?: number;
  profit?: number;
  profitRate?: number;
  contingency?: number;
  contingencyRate?: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  currency: string;
}

export interface ProposalTerms {
  validity: number; // days
  paymentTerms?: string;
  deliveryTerms?: string;
  warrantyPeriod?: string;
  additionalTerms?: string[];
}

export interface ProposalData {
  organization: OrganizationInfo;
  project: ProjectInfo;
  coverLetter?: string;
  boq: BOQSummary;
  totals: ProposalTotals;
  terms: ProposalTerms;
  drawingThumbnail?: string;
  includeDrawings?: boolean;
  includeTerms?: boolean;
}

// ============================================================================
// Template Types
// ============================================================================

export interface TemplateStyles {
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  fontSize: {
    title: number;
    heading: number;
    body: number;
    small: number;
  };
  spacing: {
    page: number;
    section: number;
    element: number;
  };
}

export interface TemplateConfig {
  name: string;
  styles: TemplateStyles;
  showLogo: boolean;
  showWatermark: boolean;
  watermarkText?: string;
  pageSize: "A4" | "LETTER";
  orientation: "portrait" | "landscape";
}

// ============================================================================
// Cover Letter Types
// ============================================================================

export interface CoverLetterData {
  organization: OrganizationInfo;
  project: ProjectInfo;
  recipientName?: string;
  recipientTitle?: string;
  content: string;
  signatory?: {
    name: string;
    title: string;
    signature?: string;
  };
}

// ============================================================================
// Compliance Sheet Types
// ============================================================================

export interface ComplianceItem {
  requirementId: string;
  requirement: string;
  requiredValue: string;
  offeredValue: string;
  offeredProduct?: string;
  status: "COMPLY" | "NOT_COMPLY" | "PARTIAL" | "REVIEW";
  notes?: string;
  catalogReference?: string;
}

export interface ComplianceSheetData {
  organization: OrganizationInfo;
  project: ProjectInfo;
  items: ComplianceItem[];
  summary: {
    total: number;
    comply: number;
    notComply: number;
    partial: number;
    review: number;
  };
}

// ============================================================================
// Export Options
// ============================================================================

export interface ExportOptions {
  filename?: string;
  template?: TemplateConfig;
  includeTableOfContents?: boolean;
  includePageNumbers?: boolean;
  includeCoverPage?: boolean;
}
