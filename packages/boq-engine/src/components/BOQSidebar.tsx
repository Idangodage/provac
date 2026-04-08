/**
 * BOQ Sidebar Component
 * Summary panel with currency settings and statistics
 */

'use client';

import React from 'react';

import { useBOQStore } from '../store';
import { BOQ_CURRENCIES } from '../types';

interface BOQSidebarProps {
  className?: string;
}

export function BOQSidebar({ className = '' }: BOQSidebarProps) {
  const {
    categories,
    currency,
    taxRate,
    setCurrency,
    setTaxRate,
    getSummary,
  } = useBOQStore();

  const { grandTotal, totalItems, totalCategories } = getSummary();

  return (
    <div className={`bg-white p-4 ${className}`}>
      <h3 className="mb-4 font-semibold text-gray-800">Summary</h3>

      <div className="space-y-4">
        {/* Currency Selection */}
        <div>
          <label className="mb-1 block text-sm text-gray-600">Currency</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded border px-3 py-2"
          >
            {BOQ_CURRENCIES.map((curr) => (
              <option key={curr.code} value={curr.code}>
                {curr.code} - {curr.name}
              </option>
            ))}
          </select>
        </div>

        {/* Default Tax Rate */}
        <div>
          <label className="mb-1 block text-sm text-gray-600">Default Tax Rate (%)</label>
          <input
            type="number"
            value={taxRate}
            onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
            className="w-full rounded border px-3 py-2"
          />
        </div>

        {/* Stats */}
        <div className="rounded bg-gray-50 p-3">
          <div className="mb-2 text-sm font-medium text-gray-700">Statistics</div>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Categories:</span>
              <span className="font-medium">{totalCategories}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Total Items:</span>
              <span className="font-medium">{totalItems}</span>
            </div>
          </div>
        </div>

        {/* Category Breakdown */}
        <div>
          <div className="mb-2 text-sm font-medium text-gray-700">By Category</div>
          <div className="space-y-2">
            {categories.map((cat) => {
              const catTotal = cat.items.reduce((acc, item) => acc + item.total, 0);
              const percentage = grandTotal > 0 ? (catTotal / grandTotal) * 100 : 0;
              return (
                <div key={cat.id} className="text-sm">
                  <div className="flex justify-between text-gray-600">
                    <span className="truncate" title={cat.category}>
                      {cat.category}
                    </span>
                    <span className="font-medium">{catTotal.toFixed(0)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full rounded-full bg-blue-600"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
