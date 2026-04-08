/**
 * BOQ Store
 * Zustand store for managing BOQ state
 */

import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { BOQCategory, BOQItem, BOQData, BOQSummary } from '../types';

interface BOQState {
  // Data
  categories: BOQCategory[];
  currency: string;
  taxRate: number;
  projectId: string;
  
  // UI State
  selectedItemId: string | null;
  isDirty: boolean;
  lastSaved: Date | null;
  
  // Actions
  initialize: (data: Partial<BOQData>) => void;
  reset: () => void;
  
  // Category actions
  addCategory: (name?: string) => void;
  updateCategoryName: (categoryId: string, name: string) => void;
  deleteCategory: (categoryId: string) => void;
  toggleCategory: (categoryId: string) => void;
  
  // Item actions
  addItem: (categoryId: string) => void;
  updateItem: (categoryId: string, itemId: string, field: keyof BOQItem, value: unknown) => void;
  deleteItem: (categoryId: string, itemId: string) => void;
  duplicateItem: (categoryId: string, itemId: string) => void;
  
  // Selection
  selectItem: (itemId: string | null) => void;
  
  // Settings
  setCurrency: (currency: string) => void;
  setTaxRate: (rate: number) => void;
  
  // Save state
  markSaved: () => void;
  markDirty: () => void;
  
  // Computed
  getSummary: () => BOQSummary;
  getData: () => BOQData;
}

const calculateItemTotal = (item: BOQItem): number => {
  const subtotal = item.quantity * item.unitPrice;
  return subtotal * (1 + item.tax / 100);
};

const defaultCategories: BOQCategory[] = [
  {
    id: 'cat-1',
    category: 'Indoor Units',
    expanded: true,
    items: [
      {
        id: 'item-1',
        description: 'Cassette Type AC Unit 2.5TR',
        model: 'FCU-2500',
        quantity: 4,
        unit: 'Nos',
        unitPrice: 2500,
        tax: 5,
        total: 10500,
      },
      {
        id: 'item-2',
        description: 'Wall Mounted Split AC 1.5TR',
        model: 'WSU-1500',
        quantity: 6,
        unit: 'Nos',
        unitPrice: 1200,
        tax: 5,
        total: 7560,
      },
    ],
  },
  {
    id: 'cat-2',
    category: 'Outdoor Units',
    expanded: true,
    items: [
      {
        id: 'item-3',
        description: 'Condensing Unit 5TR',
        model: 'CDU-5000',
        quantity: 2,
        unit: 'Nos',
        unitPrice: 8500,
        tax: 5,
        total: 17850,
      },
    ],
  },
  {
    id: 'cat-3',
    category: 'Ductwork & Insulation',
    expanded: true,
    items: [
      {
        id: 'item-4',
        description: 'GI Duct Fabrication & Installation',
        model: '-',
        quantity: 150,
        unit: 'Sq.m',
        unitPrice: 85,
        tax: 5,
        total: 13387.5,
      },
      {
        id: 'item-5',
        description: 'Thermal Insulation 25mm',
        model: 'INS-25',
        quantity: 150,
        unit: 'Sq.m',
        unitPrice: 35,
        tax: 5,
        total: 5512.5,
      },
    ],
  },
  {
    id: 'cat-4',
    category: 'Installation & Commissioning',
    expanded: true,
    items: [
      {
        id: 'item-6',
        description: 'Installation Labor',
        model: '-',
        quantity: 1,
        unit: 'Lot',
        unitPrice: 15000,
        tax: 5,
        total: 15750,
      },
      {
        id: 'item-7',
        description: 'Commissioning & Testing',
        model: '-',
        quantity: 1,
        unit: 'Lot',
        unitPrice: 5000,
        tax: 5,
        total: 5250,
      },
    ],
  },
];

export const useBOQStore = create<BOQState>()(
  immer((set, get) => ({
    // Initial state
    categories: defaultCategories,
    currency: 'AED',
    taxRate: 5,
    projectId: '',
    selectedItemId: null,
    isDirty: false,
    lastSaved: null,
    
    // Initialize
    initialize: (data) => set((state) => {
      if (data.categories) state.categories = data.categories;
      if (data.currency) state.currency = data.currency;
      if (data.taxRate !== undefined) state.taxRate = data.taxRate;
      if (data.projectId) state.projectId = data.projectId;
      state.isDirty = false;
    }),
    
    reset: () => set((state) => {
      state.categories = defaultCategories;
      state.currency = 'AED';
      state.taxRate = 5;
      state.selectedItemId = null;
      state.isDirty = false;
      state.lastSaved = null;
    }),
    
    // Category actions
    addCategory: (name = 'New Category') => set((state) => {
      state.categories.push({
        id: `cat-${nanoid()}`,
        category: name,
        expanded: true,
        items: [],
      });
      state.isDirty = true;
    }),
    
    updateCategoryName: (categoryId, name) => set((state) => {
      const cat = state.categories.find((c) => c.id === categoryId);
      if (cat) {
        cat.category = name;
        state.isDirty = true;
      }
    }),
    
    deleteCategory: (categoryId) => set((state) => {
      state.categories = state.categories.filter((c) => c.id !== categoryId);
      state.isDirty = true;
    }),
    
    toggleCategory: (categoryId) => set((state) => {
      const cat = state.categories.find((c) => c.id === categoryId);
      if (cat) {
        cat.expanded = !cat.expanded;
      }
    }),
    
    // Item actions
    addItem: (categoryId) => set((state) => {
      const cat = state.categories.find((c) => c.id === categoryId);
      if (cat) {
        const newItem: BOQItem = {
          id: `item-${nanoid()}`,
          description: 'New Item',
          model: '-',
          quantity: 1,
          unit: 'Nos',
          unitPrice: 0,
          tax: state.taxRate,
          total: 0,
        };
        cat.items.push(newItem);
        state.isDirty = true;
      }
    }),
    
    updateItem: (categoryId, itemId, field, value) => set((state) => {
      const cat = state.categories.find((c) => c.id === categoryId);
      if (cat) {
        const item = cat.items.find((i) => i.id === itemId);
        if (item) {
          (item as Record<string, unknown>)[field] = value;
          item.total = calculateItemTotal(item);
          state.isDirty = true;
        }
      }
    }),
    
    deleteItem: (categoryId, itemId) => set((state) => {
      const cat = state.categories.find((c) => c.id === categoryId);
      if (cat) {
        cat.items = cat.items.filter((i) => i.id !== itemId);
        state.isDirty = true;
      }
    }),
    
    duplicateItem: (categoryId, itemId) => set((state) => {
      const cat = state.categories.find((c) => c.id === categoryId);
      if (cat) {
        const item = cat.items.find((i) => i.id === itemId);
        if (item) {
          const newItem: BOQItem = {
            ...item,
            id: `item-${nanoid()}`,
            description: `${item.description} (Copy)`,
          };
          cat.items.push(newItem);
          state.isDirty = true;
        }
      }
    }),
    
    // Selection
    selectItem: (itemId) => set((state) => {
      state.selectedItemId = itemId;
    }),
    
    // Settings
    setCurrency: (currency) => set((state) => {
      state.currency = currency;
      state.isDirty = true;
    }),
    
    setTaxRate: (rate) => set((state) => {
      state.taxRate = rate;
      state.isDirty = true;
    }),
    
    // Save state
    markSaved: () => set((state) => {
      state.isDirty = false;
      state.lastSaved = new Date();
    }),
    
    markDirty: () => set((state) => {
      state.isDirty = true;
    }),
    
    // Computed
    getSummary: () => {
      const state = get();
      const subtotal = state.categories.reduce(
        (acc, cat) => acc + cat.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        0
      );
      const taxAmount = state.categories.reduce(
        (acc, cat) =>
          acc + cat.items.reduce((sum, item) => sum + (item.quantity * item.unitPrice * item.tax) / 100, 0),
        0
      );
      const totalItems = state.categories.reduce((acc, cat) => acc + cat.items.length, 0);
      
      return {
        subtotal,
        taxAmount,
        grandTotal: subtotal + taxAmount,
        totalItems,
        totalCategories: state.categories.length,
      };
    },
    
    getData: () => {
      const state = get();
      return {
        categories: state.categories,
        currency: state.currency,
        taxRate: state.taxRate,
        projectId: state.projectId,
        savedAt: state.lastSaved?.toISOString(),
      };
    },
  }))
);

export type { BOQState };
