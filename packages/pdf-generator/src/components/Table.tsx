import { View, Text } from "@react-pdf/renderer";

import { styles } from "../styles";

export interface TableColumn {
  key: string;
  header: string;
  width: number | string;
  align?: "left" | "center" | "right";
  format?: (value: unknown) => string;
}

interface TableProps {
  columns: TableColumn[];
  data: Record<string, unknown>[];
  showHeader?: boolean;
  alternateRows?: boolean;
}

export function Table({
  columns,
  data,
  showHeader = true,
  alternateRows = true,
}: TableProps) {
  const formatValue = (column: TableColumn, value: unknown): string => {
    if (column.format) {
      return column.format(value);
    }
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "number") {
      return value.toLocaleString();
    }
    return String(value);
  };

  const getCellStyle = (column: TableColumn) => {
    const baseStyle = { ...styles.tableCell, width: column.width };

    if (column.align === "right") {
      return { ...baseStyle, ...styles.tableCellRight };
    }
    if (column.align === "center") {
      return { ...baseStyle, textAlign: "center" as const };
    }
    return baseStyle;
  };

  return (
    <View style={styles.table}>
      {/* Header Row */}
      {showHeader && (
        <View style={styles.tableHeader}>
          {columns.map((column) => (
            <Text key={column.key} style={getCellStyle(column)}>
              {column.header}
            </Text>
          ))}
        </View>
      )}

      {/* Data Rows */}
      {data.map((row, rowIndex) => (
        <View
          key={rowIndex}
          style={[
            styles.tableRow,
            alternateRows && rowIndex % 2 === 1 ? styles.tableRowAlt : {},
          ]}
        >
          {columns.map((column) => (
            <Text key={column.key} style={getCellStyle(column)}>
              {formatValue(column, row[column.key])}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

// Currency formatter
export function formatCurrency(value: unknown, currency = "USD"): string {
  if (typeof value !== "number") return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

// Number formatter
export function formatNumber(value: unknown, decimals = 2): string {
  if (typeof value !== "number") return "";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Percentage formatter
export function formatPercent(value: unknown, decimals = 1): string {
  if (typeof value !== "number") return "";
  return `${(value * 100).toFixed(decimals)}%`;
}

export default Table;
