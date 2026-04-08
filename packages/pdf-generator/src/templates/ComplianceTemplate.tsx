import { Document, Page, View, Text } from "@react-pdf/renderer";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { styles } from "../styles";
import type { ComplianceSheetData, ComplianceItem } from "../types";

interface ComplianceTemplateProps {
  data: ComplianceSheetData;
}

function StatusBadge({ status }: { status: ComplianceItem["status"] }) {
  const getStatusStyle = () => {
    switch (status) {
      case "COMPLY":
        return styles.statusComply;
      case "NOT_COMPLY":
        return styles.statusNotComply;
      case "PARTIAL":
        return styles.statusPartial;
      case "REVIEW":
        return styles.statusReview;
      default:
        return {};
    }
  };

  const getStatusText = () => {
    switch (status) {
      case "COMPLY":
        return "COMPLY";
      case "NOT_COMPLY":
        return "NON-COMPLY";
      case "PARTIAL":
        return "PARTIAL";
      case "REVIEW":
        return "REVIEW";
      default:
        return status;
    }
  };

  return (
    <Text style={[styles.complianceStatus, getStatusStyle()]}>
      {getStatusText()}
    </Text>
  );
}

export function ComplianceTemplate({ data }: ComplianceTemplateProps) {
  const { organization, project, items, summary } = data;

  // Format date
  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  // Calculate compliance percentage
  const compliancePercent = Math.round((summary.comply / summary.total) * 100);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Header organization={organization} />

        {/* Title */}
        <Text style={styles.title}>TECHNICAL COMPLIANCE SHEET</Text>

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
            <Text style={styles.label}>Date:</Text>
            <Text style={styles.value}>{formatDate(project.date)}</Text>
          </View>
        </View>

        {/* Summary Box */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-around",
            padding: 15,
            marginBottom: 20,
            backgroundColor: "#f9fafb",
            borderRadius: 4,
          }}
        >
          <View style={{ alignItems: "center" }}>
            <Text style={[styles.value, { fontSize: 24, color: "#1e40af" }]}>
              {compliancePercent}%
            </Text>
            <Text style={styles.label}>Compliance Rate</Text>
          </View>
          <View style={{ alignItems: "center" }}>
            <Text style={[styles.value, { fontSize: 24, color: "#16a34a" }]}>
              {summary.comply}
            </Text>
            <Text style={styles.label}>Comply</Text>
          </View>
          <View style={{ alignItems: "center" }}>
            <Text style={[styles.value, { fontSize: 24, color: "#dc2626" }]}>
              {summary.notComply}
            </Text>
            <Text style={styles.label}>Non-Comply</Text>
          </View>
          <View style={{ alignItems: "center" }}>
            <Text style={[styles.value, { fontSize: 24, color: "#d97706" }]}>
              {summary.partial}
            </Text>
            <Text style={styles.label}>Partial</Text>
          </View>
          <View style={{ alignItems: "center" }}>
            <Text style={[styles.value, { fontSize: 24, color: "#6b7280" }]}>
              {summary.review}
            </Text>
            <Text style={styles.label}>Review</Text>
          </View>
        </View>

        {/* Compliance Table Header */}
        <View
          style={[
            styles.tableHeader,
            { marginTop: 10 },
          ]}
        >
          <Text style={[styles.tableCell, { width: "8%" }]}>No.</Text>
          <Text style={[styles.tableCell, { width: "30%" }]}>Requirement</Text>
          <Text style={[styles.tableCell, { width: "15%" }]}>Required</Text>
          <Text style={[styles.tableCell, { width: "15%" }]}>Offered</Text>
          <Text style={[styles.tableCell, { width: "12%" }]}>Product</Text>
          <Text style={[styles.tableCell, { width: "10%" }]}>Status</Text>
        </View>

        {/* Compliance Items */}
        {items.map((item, index) => (
          <View
            key={item.requirementId}
            style={[
              styles.tableRow,
              index % 2 === 1 ? styles.tableRowAlt : {},
            ]}
            wrap={false}
          >
            <Text style={[styles.tableCell, { width: "8%" }]}>
              {item.requirementId}
            </Text>
            <View style={[styles.tableCell, { width: "30%" }]}>
              <Text>{item.requirement}</Text>
              {item.notes && (
                <Text style={{ fontSize: 7, color: "#6b7280", marginTop: 2 }}>
                  Note: {item.notes}
                </Text>
              )}
            </View>
            <Text style={[styles.tableCell, { width: "15%" }]}>
              {item.requiredValue}
            </Text>
            <Text style={[styles.tableCell, { width: "15%" }]}>
              {item.offeredValue}
            </Text>
            <View style={[styles.tableCell, { width: "12%" }]}>
              <Text style={{ fontSize: 8 }}>{item.offeredProduct || "—"}</Text>
              {item.catalogReference && (
                <Text style={{ fontSize: 6, color: "#9ca3af" }}>
                  Ref: {item.catalogReference}
                </Text>
              )}
            </View>
            <View style={[styles.tableCell, { width: "10%" }]}>
              <StatusBadge status={item.status} />
            </View>
          </View>
        ))}

        {/* Legend */}
        <View
          style={{
            marginTop: 20,
            padding: 10,
            flexDirection: "row",
            justifyContent: "flex-start",
            gap: 15,
          }}
        >
          <Text style={styles.label}>Legend:</Text>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={[
                styles.complianceStatus,
                styles.statusComply,
                { marginRight: 4, padding: 2 },
              ]}
            >
              <Text style={{ fontSize: 7 }}>COMPLY</Text>
            </View>
            <Text style={styles.label}>Meets requirement</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={[
                styles.complianceStatus,
                styles.statusPartial,
                { marginRight: 4, padding: 2 },
              ]}
            >
              <Text style={{ fontSize: 7 }}>PARTIAL</Text>
            </View>
            <Text style={styles.label}>Partially meets</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View
              style={[
                styles.complianceStatus,
                styles.statusNotComply,
                { marginRight: 4, padding: 2 },
              ]}
            >
              <Text style={{ fontSize: 7 }}>NON-COMPLY</Text>
            </View>
            <Text style={styles.label}>Does not meet</Text>
          </View>
        </View>

        <Footer organization={organization} />
      </Page>
    </Document>
  );
}

export default ComplianceTemplate;
