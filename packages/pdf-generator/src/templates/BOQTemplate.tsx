import { Document, Page, View, Text } from "@react-pdf/renderer";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { Table, formatCurrency, type TableColumn } from "../components/Table";
import { styles } from "../styles";
import type { OrganizationInfo, ProjectInfo, BOQSummary, ProposalTotals } from "../types";

interface BOQTemplateProps {
  organization: OrganizationInfo;
  project: ProjectInfo;
  boq: BOQSummary;
  totals?: ProposalTotals;
  showPricing?: boolean;
}

export function BOQTemplate({
  organization,
  project,
  boq,
  totals,
  showPricing = true,
}: BOQTemplateProps) {
  const currency = totals?.currency || "USD";

  // Format date
  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  // BOQ columns with or without pricing
  const boqColumns: TableColumn[] = showPricing
    ? [
        { key: "itemNo", header: "Item", width: "6%", align: "center" },
        { key: "description", header: "Description", width: "32%" },
        { key: "specification", header: "Specification", width: "18%" },
        { key: "unit", header: "Unit", width: "6%", align: "center" },
        { key: "quantity", header: "Qty", width: "8%", align: "right" },
        {
          key: "unitRate",
          header: "Rate",
          width: "10%",
          align: "right",
          format: (v) => formatCurrency(v, currency),
        },
        {
          key: "totalCost",
          header: "Amount",
          width: "12%",
          align: "right",
          format: (v) => formatCurrency(v, currency),
        },
      ]
    : [
        { key: "itemNo", header: "Item", width: "8%", align: "center" },
        { key: "description", header: "Description", width: "42%" },
        { key: "specification", header: "Specification", width: "28%" },
        { key: "unit", header: "Unit", width: "10%", align: "center" },
        { key: "quantity", header: "Qty", width: "12%", align: "right" },
      ];

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Header organization={organization} />

        {/* Title */}
        <Text style={styles.title}>BILL OF QUANTITIES</Text>

        {/* Project Info */}
        <View style={styles.infoBox}>
          <View style={styles.infoColumn}>
            <Text style={styles.label}>Project:</Text>
            <Text style={styles.value}>{project.name}</Text>
          </View>
          <View style={styles.infoColumn}>
            <Text style={styles.label}>Client:</Text>
            <Text style={styles.value}>{project.clientName}</Text>
          </View>
          <View style={styles.infoColumn}>
            <Text style={styles.label}>Location:</Text>
            <Text style={styles.value}>{project.location}</Text>
          </View>
        </View>

        <View style={[styles.infoBox, { marginTop: -10 }]}>
          <View style={styles.infoColumn}>
            <Text style={styles.label}>Date:</Text>
            <Text style={styles.value}>{formatDate(project.date)}</Text>
          </View>
          <View style={styles.infoColumn}>
            <Text style={styles.label}>Reference:</Text>
            <Text style={styles.value}>{project.reference || "—"}</Text>
          </View>
          <View style={styles.infoColumn} />
        </View>

        {/* BOQ Content by Category */}
        {boq.categories.map((category, catIndex) => (
          <View key={catIndex} wrap={false}>
            <Text style={styles.sectionTitle}>{category.name}</Text>
            <Table
              columns={boqColumns}
              data={category.items as unknown as Record<string, unknown>[]}
            />

            {/* Category Subtotal */}
            {showPricing && (
              <View
                style={[
                  styles.totalRow,
                  {
                    marginTop: 4,
                    paddingTop: 4,
                    borderTopWidth: 0.5,
                    borderTopColor: "#e5e7eb",
                  },
                ]}
              >
                <Text style={[styles.totalLabel, { fontWeight: "bold" }]}>
                  {category.name} Subtotal:
                </Text>
                <Text style={[styles.totalValue, { fontWeight: "bold" }]}>
                  {formatCurrency(category.subtotal, currency)}
                </Text>
              </View>
            )}
          </View>
        ))}

        {/* Grand Totals */}
        {showPricing && totals && (
          <View style={styles.totalsBox}>
            {/* Summary Row */}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Net Total:</Text>
              <Text style={styles.totalValue}>
                {formatCurrency(boq.subtotal, currency)}
              </Text>
            </View>

            {/* Tax */}
            {totals.taxAmount > 0 && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>
                  VAT/Tax ({totals.taxRate}%):
                </Text>
                <Text style={styles.totalValue}>
                  {formatCurrency(totals.taxAmount, currency)}
                </Text>
              </View>
            )}

            {/* Grand Total */}
            <View
              style={[
                styles.totalRow,
                {
                  marginTop: 8,
                  paddingTop: 8,
                  borderTopWidth: 2,
                  borderTopColor: "#1e40af",
                },
              ]}
            >
              <Text style={[styles.totalLabel, styles.grandTotal]}>
                GRAND TOTAL:
              </Text>
              <Text style={[styles.totalValue, styles.grandTotal]}>
                {formatCurrency(totals.total, currency)}
              </Text>
            </View>
          </View>
        )}

        {/* Summary Statistics */}
        <View
          style={{
            marginTop: 30,
            padding: 15,
            backgroundColor: "#f9fafb",
            borderRadius: 4,
          }}
        >
          <Text style={styles.subtitle}>Summary</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <View>
              <Text style={styles.label}>Total Categories:</Text>
              <Text style={styles.value}>{boq.categories.length}</Text>
            </View>
            <View>
              <Text style={styles.label}>Total Items:</Text>
              <Text style={styles.value}>
                {boq.categories.reduce((sum, cat) => sum + cat.items.length, 0)}
              </Text>
            </View>
            {showPricing && (
              <View>
                <Text style={styles.label}>Total Value:</Text>
                <Text style={[styles.value, { color: "#1e40af" }]}>
                  {formatCurrency(totals?.total || boq.subtotal, currency)}
                </Text>
              </View>
            )}
          </View>
        </View>

        <Footer organization={organization} />
      </Page>
    </Document>
  );
}

export default BOQTemplate;
