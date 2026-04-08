import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type {
  EditorElement,
  EditorState,
  ToolType,
  InteractiveToolType,
  PageConfig,
  HeaderFooterConfig,
  QuotationFormData,
  BOQCategory,
  HistoryEntry,
  BOQItem,
} from '../types';

// ============================================================================
// Initial State
// ============================================================================

const initialPageConfig: PageConfig = {
  width: 816, // Letter size
  height: 1056,
  orientation: 'portrait',
  margins: {
    top: 50,
    right: 50,
    bottom: 50,
    left: 50,
  },
};

const initialHeaderConfig: HeaderFooterConfig = {
  enabled: false,
  height: 80,
};

const initialFooterConfig: HeaderFooterConfig = {
  enabled: false,
  height: 60,
};

const initialFormData: QuotationFormData = {
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

const initialBOQData: BOQCategory[] = [
  {
    id: nanoid(),
    category: 'Indoor Units',
    items: [
      {
        id: nanoid(),
        description: 'Wall Mounted Split AC Unit - 2.5TR',
        model: 'MSZ-GE25VA',
        quantity: 4,
        unit: 'Nos',
        unitPrice: 2500,
        tax: 5,
        total: 10500,
      },
      {
        id: nanoid(),
        description: 'Ceiling Cassette AC Unit - 3TR',
        model: 'PLA-RP71BA',
        quantity: 2,
        unit: 'Nos',
        unitPrice: 4500,
        tax: 5,
        total: 9450,
      },
    ],
  },
  {
    id: nanoid(),
    category: 'Outdoor Units',
    items: [
      {
        id: nanoid(),
        description: 'Condensing Unit - 10TR',
        model: 'PURY-P250YNW-A',
        quantity: 1,
        unit: 'Nos',
        unitPrice: 25000,
        tax: 5,
        total: 26250,
      },
    ],
  },
  {
    id: nanoid(),
    category: 'Installation & Accessories',
    items: [
      {
        id: nanoid(),
        description: 'Refrigerant Piping with Insulation',
        model: 'R410A Copper',
        quantity: 50,
        unit: 'm',
        unitPrice: 150,
        tax: 5,
        total: 7875,
      },
      {
        id: nanoid(),
        description: 'Electrical Wiring & Controls',
        model: 'Standard',
        quantity: 1,
        unit: 'Lot',
        unitPrice: 5000,
        tax: 5,
        total: 5250,
      },
      {
        id: nanoid(),
        description: 'Installation & Commissioning',
        model: 'Labor',
        quantity: 1,
        unit: 'Lot',
        unitPrice: 8000,
        tax: 5,
        total: 8400,
      },
    ],
  },
];

const initialState: EditorState = {
  elements: [],
  selectedElement: null,
  selectedTool: 'select',
  activeInteractiveTool: null,
  zoom: 100,
  showGrid: false,
  showRulers: true,
  snapToGrid: true,
  snapToElements: true,
  pageConfig: initialPageConfig,
  headerConfig: initialHeaderConfig,
  footerConfig: initialFooterConfig,
  isEditing: false,
  editingElementId: null,
  isDragging: false,
  formData: initialFormData,
  boqData: initialBOQData,
  activeTab: 'editor',
  history: [],
  historyIndex: -1,
  isDirty: false,
  lastSaved: null,
};

// ============================================================================
// Store Actions Interface
// ============================================================================

export interface EditorActions {
  // Element Actions
  addElement: (element: EditorElement) => void;
  updateElement: (id: string, updates: Partial<EditorElement>) => void;
  deleteElement: (id: string) => void;
  duplicateElement: (id: string) => void;
  selectElement: (id: string | null) => void;
  setElements: (elements: EditorElement[]) => void;
  moveElement: (id: string, x: number, y: number) => void;
  resizeElement: (id: string, width: number, height: number) => void;
  reorderElement: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void;
  
  // Tool Actions
  setSelectedTool: (tool: ToolType) => void;
  setActiveInteractiveTool: (tool: InteractiveToolType) => void;
  
  // View Actions
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  toggleGrid: () => void;
  toggleRulers: () => void;
  setSnapToGrid: (snap: boolean) => void;
  setSnapToElements: (snap: boolean) => void;
  
  // Page Actions
  setPageConfig: (config: Partial<PageConfig>) => void;
  toggleHeader: () => void;
  toggleFooter: () => void;
  setHeaderConfig: (config: Partial<HeaderFooterConfig>) => void;
  setFooterConfig: (config: Partial<HeaderFooterConfig>) => void;
  
  // Editing State Actions
  startEditing: (elementId: string) => void;
  stopEditing: () => void;
  setDragging: (isDragging: boolean) => void;
  
  // History Actions
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  pushHistory: () => void;
  
  // Form Data Actions
  setFormData: (data: Partial<QuotationFormData>) => void;
  setBOQData: (data: BOQCategory[]) => void;
  addBOQCategory: (category: BOQCategory) => void;
  updateBOQCategory: (categoryId: string, updates: Partial<BOQCategory>) => void;
  deleteBOQCategory: (categoryId: string) => void;
  addBOQItem: (categoryId: string, item: BOQCategory['items'][0]) => void;
  updateBOQItem: (categoryId: string, itemId: string, updates: Partial<BOQCategory['items'][0]>) => void;
  deleteBOQItem: (categoryId: string, itemId: string) => void;
  generateFromForm: () => void;
  
  // Tab Navigation
  setActiveTab: (tab: 'form' | 'editor' | 'preview') => void;
  
  // Persistence Actions
  saveToLocalStorage: () => void;
  loadFromLocalStorage: () => boolean;
  exportToJSON: () => string;
  importFromJSON: (json: string) => boolean;
  markAsSaved: () => void;
  
  // Reset
  reset: () => void;
}

export type EditorStore = EditorState & EditorActions;

// ============================================================================
// Store Implementation
// ============================================================================

const STORAGE_KEY = 'provacx-document-editor';
const MAX_HISTORY_LENGTH = 50;

export const useEditorStore = create<EditorStore>()(
  immer((set, get) => ({
    ...initialState,

    // ========================================================================
    // Element Actions
    // ========================================================================

    addElement: (element) => {
      set((state) => {
        state.elements.push(element);
        state.selectedElement = element.id;
        state.isDirty = true;
      });
    },

    updateElement: (id, updates) => {
      set((state) => {
        const index = state.elements.findIndex((el) => el.id === id);
        if (index !== -1) {
          state.elements[index] = { ...state.elements[index], ...updates } as EditorElement;
          state.isDirty = true;
        }
      });
    },

    deleteElement: (id) => {
      set((state) => {
        state.elements = state.elements.filter((el) => el.id !== id);
        if (state.selectedElement === id) {
          state.selectedElement = null;
        }
        state.isDirty = true;
      });
      get().pushHistory();
    },

    duplicateElement: (id) => {
      const element = get().elements.find((el) => el.id === id);
      if (!element) return;

      const newElement: EditorElement = {
        ...JSON.parse(JSON.stringify(element)),
        id: nanoid(),
        x: element.x + 20,
        y: element.y + 20,
        zIndex: get().elements.length + 1,
      };

      set((state) => {
        state.elements.push(newElement);
        state.selectedElement = newElement.id;
        state.isDirty = true;
      });
      get().pushHistory();
    },

    selectElement: (id) => {
      set((state) => {
        state.selectedElement = id;
      });
    },

    setElements: (elements) => {
      set((state) => {
        state.elements = elements;
        state.isDirty = true;
      });
    },

    moveElement: (id, x, y) => {
      set((state) => {
        const element = state.elements.find((el) => el.id === id);
        if (element && !element.locked) {
          element.x = x;
          element.y = y;
          state.isDirty = true;
        }
      });
    },

    resizeElement: (id, width, height) => {
      set((state) => {
        const element = state.elements.find((el) => el.id === id);
        if (element && !element.locked) {
          element.width = width;
          element.height = height;
          state.isDirty = true;
        }
      });
    },

    reorderElement: (id, direction) => {
      set((state) => {
        const index = state.elements.findIndex((el) => el.id === id);
        if (index === -1) return;

        const element = state.elements[index];
        if (!element) return;
        
        let newIndex = index;

        switch (direction) {
          case 'up':
            newIndex = Math.min(index + 1, state.elements.length - 1);
            break;
          case 'down':
            newIndex = Math.max(index - 1, 0);
            break;
          case 'top':
            newIndex = state.elements.length - 1;
            break;
          case 'bottom':
            newIndex = 0;
            break;
        }

        if (newIndex !== index) {
          state.elements.splice(index, 1);
          state.elements.splice(newIndex, 0, element);
          // Update zIndex for all elements
          state.elements.forEach((el, i) => {
            el.zIndex = i + 1;
          });
          state.isDirty = true;
        }
      });
      get().pushHistory();
    },

    // ========================================================================
    // Tool Actions
    // ========================================================================

    setSelectedTool: (tool) => {
      set((state) => {
        state.selectedTool = tool;
      });
    },

    setActiveInteractiveTool: (tool) => {
      set((state) => {
        state.activeInteractiveTool = tool;
      });
    },

    // ========================================================================
    // View Actions
    // ========================================================================

    setZoom: (zoom) => {
      set((state) => {
        state.zoom = Math.max(10, Math.min(400, zoom));
      });
    },

    zoomIn: () => {
      set((state) => {
        state.zoom = Math.min(400, state.zoom + 10);
      });
    },

    zoomOut: () => {
      set((state) => {
        state.zoom = Math.max(10, state.zoom - 10);
      });
    },

    toggleGrid: () => {
      set((state) => {
        state.showGrid = !state.showGrid;
      });
    },

    toggleRulers: () => {
      set((state) => {
        state.showRulers = !state.showRulers;
      });
    },

    setSnapToGrid: (snap) => {
      set((state) => {
        state.snapToGrid = snap;
      });
    },

    setSnapToElements: (snap) => {
      set((state) => {
        state.snapToElements = snap;
      });
    },

    // ========================================================================
    // Page Actions
    // ========================================================================

    setPageConfig: (config) => {
      set((state) => {
        state.pageConfig = { ...state.pageConfig, ...config };
        state.isDirty = true;
      });
    },

    toggleHeader: () => {
      set((state) => {
        state.headerConfig.enabled = !state.headerConfig.enabled;
        state.isDirty = true;
      });
    },

    toggleFooter: () => {
      set((state) => {
        state.footerConfig.enabled = !state.footerConfig.enabled;
        state.isDirty = true;
      });
    },

    setHeaderConfig: (config) => {
      set((state) => {
        state.headerConfig = { ...state.headerConfig, ...config };
        state.isDirty = true;
      });
    },

    setFooterConfig: (config) => {
      set((state) => {
        state.footerConfig = { ...state.footerConfig, ...config };
        state.isDirty = true;
      });
    },

    // ========================================================================
    // Editing State Actions
    // ========================================================================

    startEditing: (elementId) => {
      set((state) => {
        state.isEditing = true;
        state.editingElementId = elementId;
      });
    },

    stopEditing: () => {
      set((state) => {
        state.isEditing = false;
        state.editingElementId = null;
      });
    },

    setDragging: (isDragging) => {
      set((state) => {
        state.isDragging = isDragging;
      });
    },

    // ========================================================================
    // History Actions
    // ========================================================================

    undo: () => {
      const { historyIndex, history } = get();
      if (historyIndex > 0) {
        const previousIndex = historyIndex - 1;
        const previousState = history[previousIndex];
        if (previousState) {
          set((state) => {
            state.elements = JSON.parse(JSON.stringify(previousState.elements));
            state.historyIndex = previousIndex;
            state.isDirty = true;
          });
        }
      }
    },

    redo: () => {
      const { historyIndex, history } = get();
      if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        const nextState = history[nextIndex];
        if (nextState) {
          set((state) => {
            state.elements = JSON.parse(JSON.stringify(nextState.elements));
            state.historyIndex = nextIndex;
            state.isDirty = true;
          });
        }
      }
    },

    canUndo: () => {
      return get().historyIndex > 0;
    },

    canRedo: () => {
      const { historyIndex, history } = get();
      return historyIndex < history.length - 1;
    },

    pushHistory: () => {
      set((state) => {
        const entry: HistoryEntry = {
          elements: JSON.parse(JSON.stringify(state.elements)),
          timestamp: Date.now(),
        };

        // Remove future history if we're not at the end
        if (state.historyIndex < state.history.length - 1) {
          state.history = state.history.slice(0, state.historyIndex + 1);
        }

        // Add new entry
        state.history.push(entry);

        // Limit history length
        if (state.history.length > MAX_HISTORY_LENGTH) {
          state.history = state.history.slice(-MAX_HISTORY_LENGTH);
        }

        state.historyIndex = state.history.length - 1;
      });
    },

    // ========================================================================
    // Form Data Actions
    // ========================================================================

    setFormData: (data) => {
      set((state) => {
        state.formData = { ...state.formData, ...data };
        state.isDirty = true;
      });
    },

    setBOQData: (data) => {
      set((state) => {
        state.boqData = data;
        state.isDirty = true;
      });
    },

    addBOQCategory: (category) => {
      set((state) => {
        state.boqData.push(category);
        state.isDirty = true;
      });
    },

    updateBOQCategory: (categoryId, updates) => {
      set((state) => {
        const index = state.boqData.findIndex((cat) => cat.id === categoryId);
        if (index !== -1) {
          const existing = state.boqData[index];
          if (existing) {
            state.boqData[index] = { ...existing, ...updates } as BOQCategory;
            state.isDirty = true;
          }
        }
      });
    },

    deleteBOQCategory: (categoryId) => {
      set((state) => {
        state.boqData = state.boqData.filter((cat) => cat.id !== categoryId);
        state.isDirty = true;
      });
    },

    addBOQItem: (categoryId, item) => {
      set((state) => {
        const category = state.boqData.find((cat) => cat.id === categoryId);
        if (category) {
          category.items.push(item);
          state.isDirty = true;
        }
      });
    },

    updateBOQItem: (categoryId, itemId, updates) => {
      set((state) => {
        const category = state.boqData.find((cat) => cat.id === categoryId);
        if (category) {
          const itemIndex = category.items.findIndex((item) => item.id === itemId);
          if (itemIndex !== -1) {
            const existing = category.items[itemIndex];
            if (existing) {
              category.items[itemIndex] = { ...existing, ...updates } as BOQItem;
              state.isDirty = true;
            }
          }
        }
      });
    },

    deleteBOQItem: (categoryId, itemId) => {
      set((state) => {
        const category = state.boqData.find((cat) => cat.id === categoryId);
        if (category) {
          category.items = category.items.filter((item) => item.id !== itemId);
          state.isDirty = true;
        }
      });
    },

    generateFromForm: () => {
      const { formData, boqData } = get();
      
      // Calculate totals
      let subtotal = 0;
      boqData.forEach((category) => {
        category.items.forEach((item) => {
          subtotal += item.total;
        });
      });
      
      const taxAmount = subtotal * (formData.taxRate / 100);
      const totalAmount = subtotal + taxAmount;

      set((state) => {
        state.formData.subtotal = subtotal;
        state.formData.taxAmount = taxAmount;
        state.formData.totalAmount = totalAmount;
        state.activeTab = 'editor';
        state.isDirty = true;
      });
    },

    // ========================================================================
    // Tab Navigation
    // ========================================================================

    setActiveTab: (tab) => {
      set((state) => {
        state.activeTab = tab;
      });
    },

    // ========================================================================
    // Persistence Actions
    // ========================================================================

    saveToLocalStorage: () => {
      const state = get();
      const data = {
        elements: state.elements,
        pageConfig: state.pageConfig,
        headerConfig: state.headerConfig,
        footerConfig: state.footerConfig,
        formData: state.formData,
        boqData: state.boqData,
      };
      
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        set((s) => {
          s.isDirty = false;
          s.lastSaved = new Date().toISOString();
        });
      } catch (error) {
        console.error('Failed to save to localStorage:', error);
      }
    },

    loadFromLocalStorage: () => {
      try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) {
          const parsed = JSON.parse(data);
          set((state) => {
            if (parsed.elements) state.elements = parsed.elements;
            if (parsed.pageConfig) state.pageConfig = parsed.pageConfig;
            if (parsed.headerConfig) state.headerConfig = parsed.headerConfig;
            if (parsed.footerConfig) state.footerConfig = parsed.footerConfig;
            if (parsed.formData) state.formData = parsed.formData;
            if (parsed.boqData) state.boqData = parsed.boqData;
            state.isDirty = false;
          });
          return true;
        }
      } catch (error) {
        console.error('Failed to load from localStorage:', error);
      }
      return false;
    },

    exportToJSON: () => {
      const state = get();
      return JSON.stringify({
        elements: state.elements,
        pageConfig: state.pageConfig,
        headerConfig: state.headerConfig,
        footerConfig: state.footerConfig,
        formData: state.formData,
        boqData: state.boqData,
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
      }, null, 2);
    },

    importFromJSON: (json) => {
      try {
        const data = JSON.parse(json);
        set((state) => {
          if (data.elements) state.elements = data.elements;
          if (data.pageConfig) state.pageConfig = data.pageConfig;
          if (data.headerConfig) state.headerConfig = data.headerConfig;
          if (data.footerConfig) state.footerConfig = data.footerConfig;
          if (data.formData) state.formData = data.formData;
          if (data.boqData) state.boqData = data.boqData;
          state.isDirty = true;
        });
        get().pushHistory();
        return true;
      } catch (error) {
        console.error('Failed to import JSON:', error);
        return false;
      }
    },

    markAsSaved: () => {
      set((state) => {
        state.isDirty = false;
        state.lastSaved = new Date().toISOString();
      });
    },

    // ========================================================================
    // Reset
    // ========================================================================

    reset: () => {
      set(() => ({ ...initialState }));
    },
  }))
);

// Export for external use
export { initialFormData, initialBOQData, initialPageConfig };
