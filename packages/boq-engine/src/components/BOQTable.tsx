/**
 * BOQ Table Component
 * Displays the editable BOQ table with categories and items
 */

'use client';

import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Copy,
} from 'lucide-react';
import React from 'react';

import { useBOQStore } from '../store';
import { BOQ_UNITS } from '../types';

interface BOQTableProps {
  className?: string;
}

export function BOQTable({ className = '' }: BOQTableProps) {
  const {
    categories,
    currency,
    selectedItemId,
    toggleCategory,
    updateCategoryName,
    addItem,
    deleteCategory,
    updateItem,
    deleteItem,
    duplicateItem,
    selectItem,
    addCategory,
    getSummary,
  } = useBOQStore();

  const { subtotal, taxAmount, grandTotal } = getSummary();

  return (
    <div className={`rounded-lg bg-white shadow ${className}`}>
      {/* Table Header */}
      <div className="grid grid-cols-12 gap-2 border-b bg-gray-800 px-4 py-3 text-sm font-medium text-white">
        <div className="col-span-4">Description</div>
        <div className="col-span-2">Model</div>
        <div className="col-span-1 text-center">Qty</div>
        <div className="col-span-1 text-center">Unit</div>
        <div className="col-span-1 text-right">Unit Price</div>
        <div className="col-span-1 text-center">Tax %</div>
        <div className="col-span-1 text-right">Total ({currency})</div>
        <div className="col-span-1 text-center">Actions</div>
      </div>

      {/* Categories & Items */}
      <div className="divide-y">
        {categories.map((category) => (
          <div key={category.id}>
            {/* Category Header */}
            <div
              className="flex cursor-pointer items-center gap-2 bg-blue-50 px-4 py-2 hover:bg-blue-100"
              onClick={() => toggleCategory(category.id)}
            >
              {category.expanded ? (
                <ChevronDown size={18} className="text-blue-600" />
              ) : (
                <ChevronRight size={18} className="text-blue-600" />
              )}
              <input
                type="text"
                value={category.category}
                onChange={(e) => updateCategoryName(category.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 bg-transparent font-semibold text-blue-800 focus:outline-none focus:ring-1 focus:ring-blue-400 rounded px-1"
              />
              <span className="text-sm text-gray-500">
                {category.items.length} item{category.items.length !== 1 ? 's' : ''}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  addItem(category.id);
                }}
                className="rounded bg-blue-600 p-1 text-white hover:bg-blue-700"
                title="Add Item"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('Delete this category and all items?')) {
                    deleteCategory(category.id);
                  }
                }}
                className="rounded bg-red-600 p-1 text-white hover:bg-red-700"
                title="Delete Category"
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/* Items */}
            {category.expanded && (
              <div className="divide-y divide-gray-100">
                {category.items.map((item, index) => (
                  <div
                    key={item.id}
                    className={`grid grid-cols-12 gap-2 px-4 py-2 text-sm ${
                      selectedItemId === item.id ? 'bg-blue-50' : index % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                    } hover:bg-blue-50`}
                    onClick={() => selectItem(item.id)}
                  >
                    <div className="col-span-4">
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) =>
                          updateItem(category.id, item.id, 'description', e.target.value)
                        }
                        className="w-full rounded border border-gray-200 px-2 py-1 focus:border-blue-400 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-2">
                      <input
                        type="text"
                        value={item.model}
                        onChange={(e) =>
                          updateItem(category.id, item.id, 'model', e.target.value)
                        }
                        className="w-full rounded border border-gray-200 px-2 py-1 focus:border-blue-400 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        value={item.quantity}
                        onChange={(e) =>
                          updateItem(category.id, item.id, 'quantity', parseFloat(e.target.value) || 0)
                        }
                        className="w-full rounded border border-gray-200 px-2 py-1 text-center focus:border-blue-400 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-1">
                      <select
                        value={item.unit}
                        onChange={(e) =>
                          updateItem(category.id, item.id, 'unit', e.target.value)
                        }
                        className="w-full rounded border border-gray-200 px-1 py-1 focus:border-blue-400 focus:outline-none"
                      >
                        {BOQ_UNITS.map((unit) => (
                          <option key={unit} value={unit}>{unit}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        value={item.unitPrice}
                        onChange={(e) =>
                          updateItem(category.id, item.id, 'unitPrice', parseFloat(e.target.value) || 0)
                        }
                        className="w-full rounded border border-gray-200 px-2 py-1 text-right focus:border-blue-400 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        value={item.tax}
                        onChange={(e) =>
                          updateItem(category.id, item.id, 'tax', parseFloat(e.target.value) || 0)
                        }
                        className="w-full rounded border border-gray-200 px-2 py-1 text-center focus:border-blue-400 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-1 flex items-center justify-end font-medium text-gray-800">
                      {item.total.toFixed(2)}
                    </div>
                    <div className="col-span-1 flex items-center justify-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          duplicateItem(category.id, item.id);
                        }}
                        className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-blue-600"
                        title="Duplicate"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteItem(category.id, item.id);
                        }}
                        className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {category.items.length === 0 && (
                  <div className="px-4 py-4 text-center text-sm text-gray-400">
                    No items in this category.{' '}
                    <button
                      onClick={() => addItem(category.id)}
                      className="text-blue-600 hover:underline"
                    >
                      Add one
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add Category Button */}
      <div className="border-t px-4 py-3">
        <button
          onClick={() => addCategory()}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
        >
          <Plus size={16} />
          Add Category
        </button>
      </div>

      {/* Totals */}
      <div className="border-t bg-gray-50 px-4 py-4">
        <div className="flex justify-end">
          <div className="w-72 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Subtotal:</span>
              <span className="font-medium">
                {currency} {subtotal.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Tax:</span>
              <span className="font-medium">
                {currency} {taxAmount.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between border-t pt-2 text-lg font-bold">
              <span>Grand Total:</span>
              <span className="text-blue-600">
                {currency} {grandTotal.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
