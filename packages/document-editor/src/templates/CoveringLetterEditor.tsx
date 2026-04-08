'use client';


// Import from document-editor package
import {
  Grid,
  Rulers,
  useRulerGutters,
  AlignmentGuides,
  HeaderFooterArea,
  RichTextEditor,
  SignaturePad,
  Calculator,
  PropertyPanel,
  useEditorStore,
  useAutoSave,
  useSnap,
  useKeyboardShortcuts,
  exportToPDF,
  exportToJSON,
  importFromJSON,
  PAGE_LAYOUTS,
  defaultTextStyle,
} from '@provacx/document-editor';
import type {
  EditorElement,
  TextElement,
  AlignmentGuide,
  ToolType,
} from '@provacx/document-editor';
import {
  Download,
  Upload,
  Save,
  FileText,
  Layout,
  Type,
  Image,
  Square,
  Circle,
  Minus,
  PenTool,
  MousePointer,
  ZoomIn,
  ZoomOut,
  Grid as GridIcon,
  Eye,
  EyeOff,
  Lock,
  Layers,
  Undo,
  Redo,
  Calculator as CalcIcon,
  FileJson,
  Printer,
} from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';

function sanitizeRichTextHtml(html: string): string {
  if (typeof window === 'undefined') {
    return html;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc
    .querySelectorAll('script,iframe,object,embed,link,meta,style')
    .forEach((node) => node.remove());

  doc.querySelectorAll('*').forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        continue;
      }

      if (
        (name === 'src' || name === 'href' || name === 'xlink:href') &&
        /^javascript:/i.test(value)
      ) {
        node.removeAttribute(attr.name);
      }
    }
  });

  return doc.body.innerHTML;
}

/**
 * HVAC Covering Letter Editor
 * Full-featured document editor for creating quotation covering letters.
 */
export const CoveringLetterEditor: React.FC = () => {
  // Zustand store
  const {
    elements,
    selectedElement,
    selectedTool,
    zoom,
    showGrid,
    showRulers,
    snapToGrid,
    snapToElements,
    pageConfig,
    headerConfig,
    footerConfig,
    isEditing,
    editingElementId,
    isDragging,
    formData,
    boqData,
    activeTab,
    isDirty,
    lastSaved,
    // Actions
    addElement,
    updateElement,
    deleteElement,
    duplicateElement,
    selectElement,
    setElements,
    moveElement,
    reorderElement,
    setSelectedTool,
    zoomIn,
    zoomOut,
    toggleGrid,
    toggleRulers,
    setPageConfig,
    toggleHeader,
    toggleFooter,
    startEditing,
    stopEditing,
    setDragging,
    undo,
    redo,
    canUndo,
    canRedo,
    setFormData,
    setBOQData,
    generateFromForm,
    setActiveTab,
    loadFromLocalStorage,
    pushHistory,
  } = useEditorStore();

  // Local state
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [signatureTargetElement, setSignatureTargetElement] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hooks
  const { save: manualSave } = useAutoSave({ interval: 30, enabled: true });
  
  const { calculateSnapPosition } = useSnap({
    snapToGrid,
    snapToElements,
    zoom,
    showGrid,
  });
  
  useKeyboardShortcuts({ enabled: true, onSave: manualSave });

  // Calculate ruler gutters
  const {
    gutterTop,
    gutterLeft,
    gutterRight,
    gutterBottom,
    basePaddingTop,
    basePaddingLeft,
    basePaddingRight,
    basePaddingBottom,
  } = useRulerGutters(pageConfig.width, pageConfig.height, zoom, showRulers);

  // Initialize default elements
  useEffect(() => {
    if (elements.length === 0) {
      const loaded = loadFromLocalStorage();
      if (!loaded || useEditorStore.getState().elements.length === 0) {
        initializeDefaultElements();
      }
    }
  }, []);

  // Initialize default covering letter template
  const initializeDefaultElements = () => {
    const defaultElements: EditorElement[] = [
      {
        id: 'header-logo',
        type: 'image',
        x: 50,
        y: 30,
        width: 150,
        height: 60,
        src: null,
        placeholder: 'Company Logo',
        objectFit: 'contain',
        locked: false,
        visible: true,
        zIndex: 1,
      },
      {
        id: 'header-company',
        type: 'text',
        x: 220,
        y: 35,
        width: 350,
        height: 50,
        content: 'HVAC Solutions International\nP.O. Box 12345, Dubai, UAE\nTel: +971 4 123 4567 | Email: info@hvacsolutions.com',
        textStyle: { ...defaultTextStyle, fontSize: 12, color: '#333333' },
        locked: false,
        visible: true,
        zIndex: 2,
      },
      {
        id: 'title',
        type: 'text',
        x: 50,
        y: 140,
        width: 716,
        height: 40,
        content: 'QUOTATION FOR HVAC SYSTEM',
        textStyle: { ...defaultTextStyle, fontSize: 20, color: '#003366', bold: true, align: 'center' },
        locked: false,
        visible: true,
        zIndex: 3,
      },
      {
        id: 'date-ref',
        type: 'text',
        x: 50,
        y: 190,
        width: 300,
        height: 60,
        content: `Date: ${new Date().toLocaleDateString()}\nQuotation No: QT-2026-001\nValidity: 30 days`,
        textStyle: { ...defaultTextStyle, fontSize: 11, color: '#333333' },
        locked: false,
        visible: true,
        zIndex: 4,
      },
      {
        id: 'customer-details',
        type: 'text',
        x: 50,
        y: 270,
        width: 350,
        height: 100,
        content: 'To:\nABC Corporation Ltd.\n123 Business Street\nIndustrial Area, Dubai, UAE\n\nAttn: Mr. Ahmed Ali',
        textStyle: { ...defaultTextStyle, fontSize: 11, color: '#333333' },
        locked: false,
        visible: true,
        zIndex: 5,
      },
      {
        id: 'project-details',
        type: 'text',
        x: 450,
        y: 270,
        width: 316,
        height: 100,
        content: 'Project: Office Building HVAC System\nLocation: Dubai Marina, Dubai\nArea: 5000 sq.ft\nBuilding Type: Commercial Office',
        textStyle: { ...defaultTextStyle, fontSize: 11, color: '#333333' },
        locked: false,
        visible: true,
        zIndex: 6,
      },
      {
        id: 'introduction',
        type: 'text',
        x: 50,
        y: 390,
        width: 716,
        height: 80,
        content: 'Dear Sir,\n\nThank you for your interest in our HVAC solutions. We are pleased to submit our quotation for the supply and installation of air conditioning system for your project. Our proposal includes premium quality equipment with comprehensive warranty and professional installation services.',
        textStyle: { ...defaultTextStyle, fontSize: 11, color: '#333333', align: 'justify' },
        locked: false,
        visible: true,
        zIndex: 7,
      },
      {
        id: 'boq-table',
        type: 'table',
        x: 50,
        y: 490,
        width: 716,
        height: 300,
        data: 'boq',
        locked: false,
        visible: true,
        zIndex: 8,
      },
      {
        id: 'terms-title',
        type: 'text',
        x: 50,
        y: 810,
        width: 716,
        height: 25,
        content: 'TERMS & CONDITIONS',
        textStyle: { ...defaultTextStyle, fontSize: 13, color: '#003366', bold: true, underline: true },
        locked: false,
        visible: true,
        zIndex: 9,
      },
      {
        id: 'terms-content',
        type: 'text',
        x: 50,
        y: 845,
        width: 716,
        height: 120,
        content: '• Delivery Period: 4-6 weeks from order confirmation\n• Warranty: 2 years comprehensive warranty on all equipment and 1 year on installation\n• Payment Terms: 30% advance, 50% on delivery, 20% after installation\n• All prices are in AED and include 5% VAT\n• Prices are valid for 30 days from quotation date\n• Installation will be carried out by certified technicians',
        textStyle: { ...defaultTextStyle, fontSize: 10, color: '#333333' },
        locked: false,
        visible: true,
        zIndex: 10,
      },
      {
        id: 'signature',
        type: 'signature',
        x: 450,
        y: 980,
        width: 316,
        height: 60,
        signatureData: null,
        placeholder: 'Click to add signature',
        locked: false,
        visible: true,
        zIndex: 11,
      },
    ];
    setElements(defaultElements);
    pushHistory();
  };

  const pageLayoutId =
    PAGE_LAYOUTS.find((layout) => layout.width === pageConfig.width && layout.height === pageConfig.height)?.id ?? 'custom';

  const handleLayoutChange = (layoutId: string) => {
    const layout = PAGE_LAYOUTS.find((item) => item.id === layoutId);
    if (!layout) return;
    setPageConfig({
      width: layout.width,
      height: layout.height,
      orientation: layout.orientation,
    });
  };

  // Handle canvas mouse events
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / (zoom / 100);
    const y = (e.clientY - rect.top) / (zoom / 100);

    if (selectedTool === 'select') {
      const clickedElement = [...elements]
        .reverse()
        .find((el) => {
          if (!el.visible || el.locked) return false;
          return x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height;
        });

      if (clickedElement) {
        selectElement(clickedElement.id);
        setDragging(true);
        setDragOffset({ x: x - clickedElement.x, y: y - clickedElement.y });
      } else {
        selectElement(null);
      }
    } else {
      addNewElement(selectedTool, x, y);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !selectedElement || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const targetX = (e.clientX - rect.left) / (zoom / 100) - dragOffset.x;
    const targetY = (e.clientY - rect.top) / (zoom / 100) - dragOffset.y;

    const movingElement = elements.find((el: EditorElement) => el.id === selectedElement);
    if (!movingElement) return;

    const { x, y, guides } = calculateSnapPosition(movingElement, targetX, targetY, elements);
    setAlignmentGuides(guides);
    moveElement(selectedElement, x, y);
  };

  const handleCanvasMouseUp = () => {
    if (isDragging) {
      setDragging(false);
      setAlignmentGuides([]);
      pushHistory();
    }
  };

  // Add new element
  const addNewElement = (tool: ToolType, x: number, y: number) => {
    let newElement: EditorElement;
    const id = `element-${Date.now()}`;
    const zIndex = elements.length + 1;

    switch (tool) {
      case 'text':
        newElement = {
          id,
          type: 'text',
          x,
          y,
          width: 200,
          height: 40,
          content: 'New Text',
          textStyle: { ...defaultTextStyle },
          locked: false,
          visible: true,
          zIndex,
        };
        break;
      case 'rectangle':
        newElement = {
          id,
          type: 'rectangle',
          x,
          y,
          width: 150,
          height: 100,
          fillColor: '#ffffff',
          strokeColor: '#000000',
          strokeWidth: 2,
          locked: false,
          visible: true,
          zIndex,
        };
        break;
      case 'circle':
        newElement = {
          id,
          type: 'circle',
          x,
          y,
          width: 100,
          height: 100,
          radius: 50,
          fillColor: '#ffffff',
          strokeColor: '#000000',
          strokeWidth: 2,
          locked: false,
          visible: true,
          zIndex,
        };
        break;
      case 'line':
        newElement = {
          id,
          type: 'line',
          x,
          y,
          width: 100,
          height: 2,
          x2: x + 100,
          y2: y,
          strokeColor: '#000000',
          strokeWidth: 2,
          lineStyle: 'solid',
          arrowStart: false,
          arrowEnd: false,
          locked: false,
          visible: true,
          zIndex,
        };
        break;
      case 'image':
        newElement = {
          id,
          type: 'image',
          x,
          y,
          width: 200,
          height: 150,
          src: null,
          placeholder: 'Upload Image',
          objectFit: 'contain',
          locked: false,
          visible: true,
          zIndex,
        };
        break;
      case 'signature':
        newElement = {
          id,
          type: 'signature',
          x,
          y,
          width: 200,
          height: 80,
          signatureData: null,
          placeholder: 'Click to sign',
          locked: false,
          visible: true,
          zIndex,
        };
        break;
      default:
        return;
    }

    addElement(newElement);
    setSelectedTool('select');
  };

  // Handle element double click for editing
  const handleElementDoubleClick = (elementId: string) => {
    const element = elements.find((el: EditorElement) => el.id === elementId);
    if (!element) return;

    if (element.type === 'text') {
      startEditing(elementId);
    } else if (element.type === 'signature') {
      setSignatureTargetElement(elementId);
      setShowSignaturePad(true);
    }
  };

  // Handle signature save
  const handleSignatureSave = (signatureData: string, signedBy?: string) => {
    if (signatureTargetElement) {
      updateElement(signatureTargetElement, {
        signatureData,
        signedBy,
        signedAt: new Date().toISOString(),
      } as any);
    }
    setShowSignaturePad(false);
    setSignatureTargetElement(null);
    pushHistory();
  };

  // Handle calculator insert
  const handleCalculatorInsert = (value: string) => {
    if (selectedElement) {
      const element = elements.find((el: EditorElement) => el.id === selectedElement);
      if (element?.type === 'text') {
        updateElement(selectedElement, {
          content: (element as TextElement).content + value,
        } as Partial<TextElement>);
      }
    }
    setShowCalculator(false);
  };

  // Handle export
  const handleExportPDF = async () => {
    await exportToPDF({
      elements,
      pageConfig,
      formData,
      boqData,
      filename: `quotation-${formData.quotationNumber}.pdf`,
      quality: 'high',
    });
  };

  const handleExportJSON = () => {
    const json = exportToJSON({ elements, pageConfig, formData, boqData });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quotation-${formData.quotationNumber}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const json = event.target?.result as string;
      const data = importFromJSON(json);
      if (data) {
        setElements(data.elements);
        setFormData(data.formData);
        setBOQData(data.boqData);
        setPageConfig(data.pageConfig);
        pushHistory();
      }
    };
    reader.readAsText(file);
  };

  // Render element on canvas
  const renderElement = (element: EditorElement): React.ReactNode => {
    const isSelected = selectedElement === element.id;
    const isCurrentlyEditing = isEditing && editingElementId === element.id;

    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      left: element.x,
      top: element.y,
      cursor: selectedTool === 'select' ? (element.locked ? 'not-allowed' : 'move') : 'crosshair',
      border: isSelected ? '2px dashed #0066cc' : 'none',
      zIndex: element.zIndex,
      display: element.visible ? 'block' : 'none',
      opacity: element.advancedStyle?.opacity ? element.advancedStyle.opacity / 100 : 1,
      transform: element.advancedStyle?.transform?.rotation
        ? `rotate(${element.advancedStyle.transform.rotation}deg)`
        : undefined,
      boxShadow: element.advancedStyle?.boxShadow
        ? `${element.advancedStyle.boxShadow.x}px ${element.advancedStyle.boxShadow.y}px ${element.advancedStyle.boxShadow.blur}px ${element.advancedStyle.boxShadow.spread}px ${element.advancedStyle.boxShadow.color}`
        : undefined,
      borderRadius: element.advancedStyle?.border?.radius ? `${element.advancedStyle.border.radius}px` : undefined,
    };

    switch (element.type) {
      case 'text': {
        const textEl = element as TextElement;
        const style = textEl.textStyle || defaultTextStyle;
        const safeRichContent = textEl.richContent
          ? sanitizeRichTextHtml(textEl.richContent)
          : null;

        if (isCurrentlyEditing) {
          return (
            <div
              key={element.id}
              style={{ ...baseStyle, width: textEl.width, minHeight: textEl.height }}
            >
              <RichTextEditor
                content={textEl.richContent || textEl.content}
                onChange={(html: string, text: string) => {
                  updateElement(
                    element.id,
                    {
                      content: text,
                      richContent: sanitizeRichTextHtml(html),
                    } as Partial<TextElement>
                  );
                }}
                onBlur={() => {
                  stopEditing();
                  pushHistory();
                }}
                style={{ width: '100%', minHeight: textEl.height }}
              />
            </div>
          );
        }

        return (
          <div
            key={element.id}
            style={{
              ...baseStyle,
              width: textEl.width,
              height: textEl.height,
              fontSize: style.fontSize,
              fontFamily: style.fontFamily,
              color: style.color,
              backgroundColor: style.backgroundColor !== 'transparent' ? style.backgroundColor : undefined,
              fontWeight: style.bold ? 'bold' : 'normal',
              fontStyle: style.italic ? 'italic' : 'normal',
              textDecoration: style.underline ? 'underline' : style.strikethrough ? 'line-through' : 'none',
              textAlign: style.align as any,
              lineHeight: style.lineHeight,
              letterSpacing: `${style.letterSpacing}px`,
              whiteSpace: 'pre-wrap',
              padding: '5px',
              pointerEvents: element.locked ? 'none' : 'auto',
              overflow: 'hidden',
            }}
            onClick={() => selectElement(element.id)}
            onDoubleClick={() => handleElementDoubleClick(element.id)}
            dangerouslySetInnerHTML={safeRichContent ? { __html: safeRichContent } : undefined}
          >
            {!safeRichContent && textEl.content}
          </div>
        );
      }

      case 'table':
        return (
          <div
            key={element.id}
            style={{ ...baseStyle, width: element.width, pointerEvents: element.locked ? 'none' : 'auto' }}
            onClick={() => selectElement(element.id)}
          >
            {renderBOQTable()}
          </div>
        );

      case 'rectangle':
        return (
          <div
            key={element.id}
            style={{
              ...baseStyle,
              width: element.width,
              height: element.height,
              backgroundColor: element.fillColor,
              border: `${element.strokeWidth}px solid ${element.strokeColor}`,
              pointerEvents: element.locked ? 'none' : 'auto',
            }}
            onClick={() => selectElement(element.id)}
          />
        );

      case 'circle':
        return (
          <div
            key={element.id}
            style={{
              ...baseStyle,
              width: element.radius * 2,
              height: element.radius * 2,
              borderRadius: '50%',
              backgroundColor: element.fillColor,
              border: `${element.strokeWidth}px solid ${element.strokeColor}`,
              pointerEvents: element.locked ? 'none' : 'auto',
            }}
            onClick={() => selectElement(element.id)}
          />
        );

      case 'line': {
        const length = Math.sqrt(Math.pow(element.x2 - element.x, 2) + Math.pow(element.y2 - element.y, 2));
        const angle = (Math.atan2(element.y2 - element.y, element.x2 - element.x) * 180) / Math.PI;
        return (
          <div
            key={element.id}
            style={{
              ...baseStyle,
              width: length,
              height: element.strokeWidth,
              backgroundColor: element.strokeColor,
              transform: `rotate(${angle}deg)`,
              transformOrigin: '0 0',
              pointerEvents: element.locked ? 'none' : 'auto',
            }}
            onClick={() => selectElement(element.id)}
          />
        );
      }

      case 'image':
        return (
          <div
            key={element.id}
            style={{
              ...baseStyle,
              width: element.width,
              height: element.height,
              border: element.src ? 'none' : '1px dashed #ccc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: element.src ? 'transparent' : '#f5f5f5',
              pointerEvents: element.locked ? 'none' : 'auto',
            }}
            onClick={() => selectElement(element.id)}
          >
            {element.src ? (
              <img src={element.src} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: element.objectFit }} />
            ) : (
              <span style={{ color: '#999', fontSize: 12, textAlign: 'center' }}>
                <Image size={24} style={{ marginBottom: 4 }} />
                <br />
                {element.placeholder}
              </span>
            )}
          </div>
        );

      case 'signature':
        return (
          <div
            key={element.id}
            style={{
              ...baseStyle,
              width: element.width,
              height: element.height,
              border: '1px dashed #0066cc',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: element.signatureData ? 'transparent' : '#f8f9fa',
              cursor: 'pointer',
              pointerEvents: element.locked ? 'none' : 'auto',
            }}
            onClick={() => {
              selectElement(element.id);
              if (!element.signatureData) {
                handleElementDoubleClick(element.id);
              }
            }}
          >
            {element.signatureData ? (
              <>
                <img src={element.signatureData} alt="Signature" style={{ maxWidth: '100%', maxHeight: '80%' }} />
                {element.signedBy && <span style={{ fontSize: 10, color: '#666' }}>Signed by: {element.signedBy}</span>}
              </>
            ) : (
              <>
                <PenTool size={24} color="#0066cc" />
                <span style={{ color: '#0066cc', fontSize: 11, marginTop: 4 }}>{element.placeholder}</span>
              </>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  // Render BOQ Table
  const renderBOQTable = () => (
    <div style={{ fontSize: 9, width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #333' }}>
        <thead>
          <tr style={{ backgroundColor: '#003366', color: 'white' }}>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'left', width: '5%' }}>S.No</th>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'left', width: '35%' }}>Description</th>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'left', width: '15%' }}>Model</th>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'center', width: '8%' }}>Qty</th>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'right', width: '12%' }}>Unit Price</th>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'right', width: '10%' }}>Tax %</th>
            <th style={{ border: '1px solid #333', padding: '6px', textAlign: 'right', width: '15%' }}>Total ({formData.currency})</th>
          </tr>
        </thead>
        <tbody>
          {boqData.map((category, catIndex) => (
            <React.Fragment key={category.id}>
              <tr style={{ backgroundColor: '#e6f2ff' }}>
                <td colSpan={7} style={{ border: '1px solid #333', padding: '6px', fontWeight: 'bold' }}>
                  {category.category}
                </td>
              </tr>
              {category.items.map((item, itemIndex) => (
                <tr key={item.id} style={{ backgroundColor: itemIndex % 2 === 0 ? '#ffffff' : '#f9f9f9' }}>
                  <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'center' }}>
                    {catIndex + 1}.{itemIndex + 1}
                  </td>
                  <td style={{ border: '1px solid #333', padding: '6px' }}>{item.description}</td>
                  <td style={{ border: '1px solid #333', padding: '6px' }}>{item.model}</td>
                  <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'center' }}>{item.quantity}</td>
                  <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>{item.unitPrice.toFixed(2)}</td>
                  <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>{item.tax}%</td>
                  <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>{item.total.toFixed(2)}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
          <tr style={{ backgroundColor: '#f0f0f0', fontWeight: 'bold' }}>
            <td colSpan={6} style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>Subtotal:</td>
            <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>{formData.subtotal.toFixed(2)}</td>
          </tr>
          <tr style={{ backgroundColor: '#f0f0f0' }}>
            <td colSpan={6} style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>Tax ({formData.taxRate}%):</td>
            <td style={{ border: '1px solid #333', padding: '6px', textAlign: 'right' }}>{formData.taxAmount.toFixed(2)}</td>
          </tr>
          <tr style={{ backgroundColor: '#003366', color: 'white', fontWeight: 'bold' }}>
            <td colSpan={6} style={{ border: '1px solid #333', padding: '8px', textAlign: 'right', fontSize: 11 }}>TOTAL AMOUNT:</td>
            <td style={{ border: '1px solid #333', padding: '8px', textAlign: 'right', fontSize: 11 }}>{formData.totalAmount.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'Arial, sans-serif', backgroundColor: '#f5f5f5' }}>
      {/* Top Navigation */}
      <div style={{ backgroundColor: '#003366', color: 'white', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>HVAC Quotation - Covering Letter</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          {['form', 'editor', 'preview'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              style={{
                padding: '8px 16px',
                backgroundColor: activeTab === tab ? '#0066cc' : 'transparent',
                color: 'white',
                border: '1px solid white',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {tab === 'form' && <FileText size={14} />}
              {tab === 'editor' && <Layout size={14} />}
              {tab === 'preview' && <Eye size={14} />}
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 11 }}>
          {isDirty && <span style={{ color: '#ffc107' }}>Unsaved changes</span>}
          {lastSaved && <span style={{ opacity: 0.7 }}>Last saved: {new Date(lastSaved).toLocaleTimeString()}</span>}
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Form Tab */}
        {activeTab === 'form' && (
          <FormTab formData={formData} setFormData={setFormData} generateFromForm={generateFromForm} />
        )}

        {/* Editor Tab */}
        {activeTab === 'editor' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {/* Toolbar */}
            <EditorToolbar
              canUndo={canUndo}
              canRedo={canRedo}
              undo={undo}
              redo={redo}
              selectedTool={selectedTool}
              setSelectedTool={setSelectedTool}
              showCalculator={showCalculator}
              setShowCalculator={setShowCalculator}
              showGrid={showGrid}
              toggleGrid={toggleGrid}
              showRulers={showRulers}
              toggleRulers={toggleRulers}
              zoom={zoom}
              zoomIn={zoomIn}
              zoomOut={zoomOut}
              pageLayoutId={pageLayoutId}
              handleLayoutChange={handleLayoutChange}
              headerConfig={headerConfig}
              footerConfig={footerConfig}
              toggleHeader={toggleHeader}
              toggleFooter={toggleFooter}
              manualSave={manualSave}
              handleExportJSON={handleExportJSON}
              handleExportPDF={handleExportPDF}
              fileInputRef={fileInputRef}
              handleImportJSON={handleImportJSON}
            />

            {/* Editor Area */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              {/* Canvas */}
              <div style={{ flex: 1, position: 'relative', backgroundColor: '#e0e0e0', overflow: 'hidden' }}>
                <div
                  ref={scrollRef}
                  style={{
                    position: 'absolute',
                    top: gutterTop,
                    left: gutterLeft,
                    right: gutterRight,
                    bottom: gutterBottom,
                    overflow: 'auto',
                  }}
                >
                  <div
                    style={{
                      paddingTop: basePaddingTop,
                      paddingRight: basePaddingRight,
                      paddingBottom: basePaddingBottom,
                      paddingLeft: basePaddingLeft,
                      display: 'flex',
                      justifyContent: 'center',
                    }}
                  >
                    <div
                      ref={canvasRef}
                      onMouseDown={handleCanvasMouseDown}
                      onMouseMove={handleCanvasMouseMove}
                      onMouseUp={handleCanvasMouseUp}
                      onMouseLeave={handleCanvasMouseUp}
                      style={{
                        width: pageConfig.width,
                        height: pageConfig.height,
                        backgroundColor: 'white',
                        boxShadow: '0 0 20px rgba(0,0,0,0.3)',
                        position: 'relative',
                        transform: `scale(${zoom / 100})`,
                        transformOrigin: 'top left',
                        cursor: selectedTool === 'select' ? 'default' : 'crosshair',
                      }}
                    >
                      {/* Grid */}
                      {showGrid && <Grid pageWidth={pageConfig.width} pageHeight={pageConfig.height} zoom={zoom} />}

                      {/* Header/Footer Areas */}
                      <HeaderFooterArea type="header" enabled={headerConfig.enabled} height={headerConfig.height} />
                      <HeaderFooterArea type="footer" enabled={footerConfig.enabled} height={footerConfig.height} />

                      {/* Alignment Guides */}
                      <AlignmentGuides guides={alignmentGuides} zoom={zoom} />

                      {/* Elements */}
                      {elements.map(renderElement)}
                    </div>
                  </div>

                  {/* Calculator Widget */}
                  {showCalculator && <Calculator onInsert={handleCalculatorInsert} onClose={() => setShowCalculator(false)} />}
                </div>

                {/* Rulers */}
                <Rulers
                  pageWidth={pageConfig.width}
                  pageHeight={pageConfig.height}
                  zoom={zoom}
                  scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
                  canvasRef={canvasRef as React.RefObject<HTMLDivElement>}
                  showRulers={showRulers}
                />
              </div>

              {/* Right Sidebar */}
              <RightSidebar
                elements={elements}
                selectedElement={selectedElement}
                selectElement={selectElement}
                updateElement={updateElement}
                deleteElement={deleteElement}
                duplicateElement={duplicateElement}
                reorderElement={reorderElement}
              />
            </div>
          </div>
        )}

        {/* Preview Tab */}
        {activeTab === 'preview' && (
          <PreviewTab
            pageConfig={pageConfig}
            elements={elements}
            renderElement={renderElement}
            handleExportPDF={handleExportPDF}
          />
        )}
      </div>

      {/* Signature Pad Modal */}
      {showSignaturePad && (
        <SignaturePad
          onSave={handleSignatureSave}
          onCancel={() => {
            setShowSignaturePad(false);
            setSignatureTargetElement(null);
          }}
          initialData={signatureTargetElement ? (elements.find((el) => el.id === signatureTargetElement) as any)?.signatureData : null}
        />
      )}
    </div>
  );
};

// Sub-components for organization
const FormTab: React.FC<{
  formData: any;
  setFormData: (data: any) => void;
  generateFromForm: () => void;
}> = ({ formData, setFormData, generateFromForm }) => (
  <div style={{ flex: 1, overflow: 'auto', padding: '30px', backgroundColor: 'white' }}>
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      <h3 style={{ marginTop: 0, color: '#003366', marginBottom: '25px' }}>Quotation Details Form</h3>

      {/* Customer Details */}
      <div style={{ marginBottom: '30px', padding: '20px', backgroundColor: '#f8f9fa', borderRadius: '8px' }}>
        <h4 style={{ marginTop: 0, color: '#003366', marginBottom: '15px' }}>Customer Details</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Company Name *</label>
            <input
              type="text"
              value={formData.customerName}
              onChange={(e) => setFormData({ customerName: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Contact Person *</label>
            <input
              type="text"
              value={formData.contactPerson}
              onChange={(e) => setFormData({ contactPerson: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Address *</label>
            <textarea
              value={formData.customerAddress}
              onChange={(e) => setFormData({ customerAddress: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px', minHeight: '60px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Email</label>
            <input
              type="email"
              value={formData.contactEmail}
              onChange={(e) => setFormData({ contactEmail: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Phone</label>
            <input
              type="tel"
              value={formData.contactPhone}
              onChange={(e) => setFormData({ contactPhone: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
        </div>
      </div>

      {/* Project Details */}
      <div style={{ marginBottom: '30px', padding: '20px', backgroundColor: '#e8f4f8', borderRadius: '8px', border: '2px solid #0066cc' }}>
        <h4 style={{ marginTop: 0, color: '#003366', marginBottom: '10px' }}>
          Project Details
          <span style={{ fontSize: 11, color: '#666', fontWeight: 'normal', marginLeft: '10px' }}>(Auto-filled from Heat Load Calculator)</span>
        </h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Project Name</label>
            <input
              type="text"
              value={formData.projectName}
              onChange={(e) => setFormData({ projectName: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Location</label>
            <input
              type="text"
              value={formData.projectLocation}
              onChange={(e) => setFormData({ projectLocation: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Total Area</label>
            <input
              type="text"
              value={formData.projectArea}
              onChange={(e) => setFormData({ projectArea: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Building Type</label>
            <select
              value={formData.buildingType}
              onChange={(e) => setFormData({ buildingType: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            >
              {['Commercial Office', 'Residential Villa', 'Retail Shop', 'Restaurant', 'Warehouse', 'Hospital', 'School'].map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Financial Details */}
      <div style={{ marginBottom: '30px', padding: '20px', backgroundColor: '#f8f9fa', borderRadius: '8px' }}>
        <h4 style={{ marginTop: 0, color: '#003366', marginBottom: '15px' }}>Financial Details</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Currency</label>
            <select
              value={formData.currency}
              onChange={(e) => setFormData({ currency: e.target.value })}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            >
              {['AED', 'USD', 'EUR', 'SAR'].map((curr) => (
                <option key={curr}>{curr}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Tax Rate (%)</label>
            <input
              type="number"
              value={formData.taxRate}
              onChange={(e) => {
                const rate = parseFloat(e.target.value) || 0;
                setFormData({
                  taxRate: rate,
                  taxAmount: formData.subtotal * (rate / 100),
                  totalAmount: formData.subtotal * (1 + rate / 100),
                });
              }}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Subtotal</label>
            <input
              type="number"
              value={formData.subtotal}
              onChange={(e) => {
                const sub = parseFloat(e.target.value) || 0;
                setFormData({
                  subtotal: sub,
                  taxAmount: sub * (formData.taxRate / 100),
                  totalAmount: sub * (1 + formData.taxRate / 100),
                });
              }}
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: 13, fontWeight: 'bold' }}>Total Amount</label>
            <input
              type="number"
              value={formData.totalAmount}
              readOnly
              style={{ width: '100%', padding: '8px', fontSize: 13, border: '2px solid #0066cc', borderRadius: '4px', backgroundColor: '#e8f4f8', fontWeight: 'bold' }}
            />
          </div>
        </div>
      </div>

      {/* Generate Button */}
      <div style={{ textAlign: 'center', paddingTop: '20px', borderTop: '2px solid #ddd' }}>
        <button
          onClick={generateFromForm}
          style={{
            padding: '15px 40px',
            fontSize: 15,
            backgroundColor: '#0066cc',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 'bold',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          }}
        >
          Generate Covering Letter →
        </button>
      </div>
    </div>
  </div>
);

const EditorToolbar: React.FC<{
  canUndo: () => boolean;
  canRedo: () => boolean;
  undo: () => void;
  redo: () => void;
  selectedTool: ToolType;
  setSelectedTool: (tool: ToolType) => void;
  showCalculator: boolean;
  setShowCalculator: (show: boolean) => void;
  showGrid: boolean;
  toggleGrid: () => void;
  showRulers: boolean;
  toggleRulers: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  pageLayoutId: string;
  handleLayoutChange: (id: string) => void;
  headerConfig: { enabled: boolean };
  footerConfig: { enabled: boolean };
  toggleHeader: () => void;
  toggleFooter: () => void;
  manualSave: () => void;
  handleExportJSON: () => void;
  handleExportPDF: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  handleImportJSON: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = (props) => {
  const toolButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px',
    backgroundColor: active ? '#0066cc' : '#f0f0f0',
    color: active ? 'white' : '#333',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  });

  return (
    <div style={{ backgroundColor: 'white', borderBottom: '1px solid #ddd', padding: '10px', display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' }}>
      {/* History */}
      <div style={{ display: 'flex', gap: '5px', borderRight: '1px solid #ddd', paddingRight: '10px' }}>
        <button onClick={props.undo} disabled={!props.canUndo()} title="Undo (Ctrl+Z)" style={toolButtonStyle(false)}>
          <Undo size={16} />
        </button>
        <button onClick={props.redo} disabled={!props.canRedo()} title="Redo (Ctrl+Y)" style={toolButtonStyle(false)}>
          <Redo size={16} />
        </button>
      </div>

      {/* Drawing Tools */}
      <div style={{ display: 'flex', gap: '5px', borderRight: '1px solid #ddd', paddingRight: '10px' }}>
        {([
          { tool: 'select' as ToolType, icon: <MousePointer size={16} />, title: 'Select' },
          { tool: 'text' as ToolType, icon: <Type size={16} />, title: 'Text' },
          { tool: 'rectangle' as ToolType, icon: <Square size={16} />, title: 'Rectangle' },
          { tool: 'circle' as ToolType, icon: <Circle size={16} />, title: 'Circle' },
          { tool: 'line' as ToolType, icon: <Minus size={16} />, title: 'Line' },
          { tool: 'image' as ToolType, icon: <Image size={16} />, title: 'Image' },
          { tool: 'signature' as ToolType, icon: <PenTool size={16} />, title: 'Signature' },
        ] as const).map(({ tool, icon, title }) => (
          <button key={tool} onClick={() => props.setSelectedTool(tool)} title={title} style={toolButtonStyle(props.selectedTool === tool)}>
            {icon}
          </button>
        ))}
      </div>

      {/* Interactive Tools */}
      <div style={{ display: 'flex', gap: '5px', borderRight: '1px solid #ddd', paddingRight: '10px' }}>
        <button onClick={() => props.setShowCalculator(!props.showCalculator)} title="Calculator" style={toolButtonStyle(props.showCalculator)}>
          <CalcIcon size={16} />
        </button>
      </div>

      {/* View Controls */}
      <div style={{ display: 'flex', gap: '5px', borderRight: '1px solid #ddd', paddingRight: '10px' }}>
        <button onClick={props.toggleGrid} title="Toggle Grid" style={toolButtonStyle(props.showGrid)}>
          <GridIcon size={16} />
        </button>
        <button onClick={props.toggleRulers} title="Toggle Rulers" style={toolButtonStyle(props.showRulers)}>
          {props.showRulers ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button onClick={props.zoomOut} title="Zoom Out" style={toolButtonStyle(false)}>
          <ZoomOut size={16} />
        </button>
        <span style={{ padding: '8px', fontSize: 13, minWidth: '60px', textAlign: 'center' }}>{props.zoom}%</span>
        <button onClick={props.zoomIn} title="Zoom In" style={toolButtonStyle(false)}>
          <ZoomIn size={16} />
        </button>
      </div>

      {/* Page Layout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', borderRight: '1px solid #ddd', paddingRight: '10px' }}>
        <span style={{ fontSize: 11, color: '#666' }}>Page</span>
        <select
          value={props.pageLayoutId}
          onChange={(e) => props.handleLayoutChange(e.target.value)}
          style={{ padding: '6px 8px', fontSize: 12, border: '1px solid #ccc', borderRadius: '4px', backgroundColor: 'white' }}
        >
          {PAGE_LAYOUTS.map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </div>

      {/* Header/Footer */}
      <div style={{ display: 'flex', gap: '5px', borderRight: '1px solid #ddd', paddingRight: '10px' }}>
        <button onClick={props.toggleHeader} style={toolButtonStyle(props.headerConfig.enabled)}>
          Header
        </button>
        <button onClick={props.toggleFooter} style={toolButtonStyle(props.footerConfig.enabled)}>
          Footer
        </button>
      </div>

      {/* Actions */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: '5px' }}>
        <button onClick={props.manualSave} style={{ padding: '8px 12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Save size={14} /> Save
        </button>
        <button onClick={props.handleExportJSON} style={{ padding: '8px 12px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FileJson size={14} /> JSON
        </button>
        <button onClick={props.handleExportPDF} style={{ padding: '8px 12px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Download size={14} /> PDF
        </button>
        <input ref={props.fileInputRef} type="file" accept=".json" onChange={props.handleImportJSON} style={{ display: 'none' }} />
        <button onClick={() => props.fileInputRef.current?.click()} style={{ padding: '8px 12px', backgroundColor: '#17a2b8', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Upload size={14} /> Import
        </button>
      </div>
    </div>
  );
};

const RightSidebar: React.FC<{
  elements: EditorElement[];
  selectedElement: string | null;
  selectElement: (id: string | null) => void;
  updateElement: (id: string, updates: Partial<EditorElement>) => void;
  deleteElement: (id: string) => void;
  duplicateElement: (id: string) => void;
  reorderElement: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void;
}> = (props) => (
  <div style={{ width: '300px', backgroundColor: 'white', borderLeft: '1px solid #ddd', display: 'flex', flexDirection: 'column' }}>
    {/* Layers Panel */}
    <div style={{ padding: '15px', borderBottom: '1px solid #ddd' }}>
      <h4 style={{ margin: 0, fontSize: 14 }}>Layers</h4>
    </div>
    <div style={{ flex: 1, overflowY: 'auto', padding: '10px', maxHeight: '200px' }}>
      {[...props.elements].reverse().map((el) => (
        <div
          key={el.id}
          onClick={() => props.selectElement(el.id)}
          style={{
            padding: '10px',
            marginBottom: '5px',
            backgroundColor: props.selectedElement === el.id ? '#e8f4f8' : '#f8f9fa',
            border: props.selectedElement === el.id ? '2px solid #0066cc' : '1px solid #ddd',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {el.type === 'text' && <Type size={14} />}
            {el.type === 'rectangle' && <Square size={14} />}
            {el.type === 'circle' && <Circle size={14} />}
            {el.type === 'line' && <Minus size={14} />}
            {el.type === 'image' && <Image size={14} />}
            {el.type === 'table' && <Layers size={14} />}
            {el.type === 'signature' && <PenTool size={14} />}
            <span>{el.name || el.id}</span>
          </div>
          <div style={{ display: 'flex', gap: '5px' }}>
            {el.locked && <Lock size={12} color="#ff6b6b" />}
            {!el.visible && <EyeOff size={12} color="#999" />}
          </div>
        </div>
      ))}
    </div>

    {/* Property Panel */}
    <div style={{ flex: 2, borderTop: '1px solid #ddd', overflowY: 'auto' }}>
      <PropertyPanel
        element={props.elements.find((el) => el.id === props.selectedElement) || null}
        onUpdate={props.updateElement}
        onDelete={props.deleteElement}
        onDuplicate={props.duplicateElement}
        onReorder={props.reorderElement}
      />
    </div>
  </div>
);

const PreviewTab: React.FC<{
  pageConfig: any;
  elements: EditorElement[];
  renderElement: (el: EditorElement) => React.ReactNode;
  handleExportPDF: () => void;
}> = (props) => (
  <div style={{ flex: 1, overflow: 'auto', backgroundColor: '#e0e0e0', padding: '40px' }}>
    <div style={{ maxWidth: props.pageConfig.width + 40, margin: '0 auto' }}>
      <div style={{ marginBottom: '20px', display: 'flex', gap: '10px', justifyContent: 'center' }}>
        <button onClick={props.handleExportPDF} style={{ padding: '12px 24px', backgroundColor: '#0066cc', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Download size={18} /> Export to PDF
        </button>
        <button onClick={() => window.print()} style={{ padding: '12px 24px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Printer size={18} /> Print
        </button>
      </div>
      <div
        style={{
          width: props.pageConfig.width,
          minHeight: props.pageConfig.height,
          backgroundColor: 'white',
          boxShadow: '0 0 20px rgba(0,0,0,0.3)',
          position: 'relative',
          margin: '0 auto',
        }}
      >
        {props.elements.filter((el) => el.visible).map(props.renderElement)}
      </div>
    </div>
  </div>
);

export default CoveringLetterEditor;
