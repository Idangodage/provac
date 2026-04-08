/**
 * Project and Workflow Types
 */

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW TYPES
// ═══════════════════════════════════════════════════════════════════════════

export enum ProjectWorkflow {
  FULL = "FULL", // Drawing -> BOQ -> Pricing -> Letter -> Proposal
  BOQ = "BOQ", // BOQ -> Pricing -> Letter -> Proposal
  QUICK = "QUICK", // Letter -> Proposal (manual total)
  IMPORT = "IMPORT", // Import Excel -> Pricing -> Letter -> Proposal
}

export const WORKFLOW_STEPS: Record<ProjectWorkflow, string[]> = {
  [ProjectWorkflow.FULL]: ["drawing", "boq", "pricing", "letter", "proposal"],
  [ProjectWorkflow.BOQ]: ["boq", "pricing", "letter", "proposal"],
  [ProjectWorkflow.QUICK]: ["letter", "proposal"],
  [ProjectWorkflow.IMPORT]: ["import", "pricing", "letter", "proposal"],
};

export const STEP_LABELS: Record<string, string> = {
  drawing: "Drawing",
  boq: "BOQ",
  import: "Import",
  pricing: "Pricing",
  letter: "Cover Letter",
  proposal: "Proposal",
};

// ═══════════════════════════════════════════════════════════════════════════
// CHECKLIST TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ProposalChecklist {
  projectId: string;
  status: "incomplete" | "warnings" | "complete";
  sections: {
    clientInfo: ChecklistSection;
    commercialSettings: ChecklistSection;
    technicalParameters: ChecklistSection;
    criticalItems: ChecklistSection;
    aiSuggestions: ChecklistSection;
  };
  summary: {
    totalItems: number;
    completedItems: number;
    warnings: number;
    errors: number;
  };
}

export interface ChecklistSection {
  title: string;
  status: "complete" | "warning" | "error" | "pending";
  items: ChecklistItem[];
}

export interface ChecklistItem {
  id: string;
  label: string;
  type: "info" | "editable" | "validation" | "confirmation";
  status: "ok" | "warning" | "error" | "pending";
  value?: unknown;
  limit?: unknown;
  message?: string;
  action?: {
    type: "edit" | "view" | "apply" | "dismiss";
    label: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLIANCE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ComplianceItem {
  requirementId: string;
  requirement: string;
  requiredValue: string;
  offeredValue: string;
  offeredProduct?: string;
  status: "COMPLY" | "NOT_COMPLY" | "PARTIAL" | "REVIEW_NEEDED";
  notes?: string;
  catalogReference?: string;
}

export interface ComplianceSummary {
  total: number;
  comply: number;
  notComply: number;
  review: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// AI SUGGESTION TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface AISuggestion {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  description: string;
  actionType: "add_to_boq" | "change_spec" | "review" | "acknowledge" | "modify";
  affectedItems?: string[];
  reference?: string;
}

export interface AIValidationResult {
  recommendations: AISuggestion[];
  warnings: AISuggestion[];
  positiveNotes: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICING TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PricingTotals {
  materialCost: number;
  labourCost: number;
  subtotal: number;
  overhead: number;
  profit: number;
  contingency: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

export interface BOQItemWithPricing {
  id: string;
  category: string;
  itemNumber?: string;
  description: string;
  specification?: string;
  unit: string;
  quantity: number;
  unitRate: number;
  materialCost: number;
  labourCost: number;
  totalCost: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW TYPES (Drawing)
// ═══════════════════════════════════════════════════════════════════════════

export type ViewType = "plan" | "section" | "end" | "detail";

export interface CutLine {
  id: string;
  name: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  direction: "horizontal" | "vertical";
}

export interface DetailArea {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface ViewState {
  activeView: ViewType;
  cutLines: CutLine[];
  detailAreas: DetailArea[];
  activeCutLineId: string | null;
  activeDetailId: string | null;
}
