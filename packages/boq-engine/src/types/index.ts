/**
 * BOQ Engine Types
 * Type definitions for Bill of Quantities functionality
 */

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
  expanded: boolean;
}

export interface BOQData {
  categories: BOQCategory[];
  currency: string;
  taxRate: number;
  projectId: string;
  savedAt?: string;
}

export interface BOQEditorProps {
  projectId: string;
  projectName?: string;
  initialData?: BOQData;
  onSave?: (data: BOQData) => Promise<void>;
  onDataChange?: (data: BOQData) => void;
  className?: string;
  /** Custom navigation links */
  backLink?: {
    href: string;
    label: string;
  };
  nextLink?: {
    href: string;
    label: string;
  };
}

export interface BOQSummary {
  subtotal: number;
  taxAmount: number;
  grandTotal: number;
  totalItems: number;
  totalCategories: number;
}

export type BOQUnit = 'Nos' | 'Lot' | 'Sq.m' | 'M' | 'Kg' | 'Set';

export const BOQ_UNITS: BOQUnit[] = ['Nos', 'Lot', 'Sq.m', 'M', 'Kg', 'Set'];

export interface BOQCurrency {
  code: string;
  name: string;
}

export const BOQ_CURRENCIES: BOQCurrency[] = [
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'SAR', name: 'Saudi Riyal' },
];
