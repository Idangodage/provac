import { StyleSheet } from "@react-pdf/renderer";

import type { TemplateStyles } from "../types";

// Default template styles
export const defaultStyles: TemplateStyles = {
  primaryColor: "#1e40af", // Blue 800
  secondaryColor: "#374151", // Gray 700
  fontFamily: "Helvetica",
  fontSize: {
    title: 24,
    heading: 14,
    body: 10,
    small: 8,
  },
  spacing: {
    page: 40,
    section: 20,
    element: 10,
  },
};

// Create styles from template config
export function createStyles(config: Partial<TemplateStyles> = {}) {
  const styles = { ...defaultStyles, ...config };

  return StyleSheet.create({
    // Page styles
    page: {
      padding: styles.spacing.page,
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize.body,
      color: styles.secondaryColor,
    },

    // Header styles
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: styles.spacing.section,
      paddingBottom: styles.spacing.element,
      borderBottomWidth: 1,
      borderBottomColor: "#e5e7eb",
    },

    logo: {
      width: 120,
      height: 50,
      objectFit: "contain",
    },

    companyInfo: {
      textAlign: "right",
    },

    companyName: {
      fontSize: styles.fontSize.heading,
      fontWeight: "bold",
      color: styles.primaryColor,
      marginBottom: 4,
    },

    companyDetails: {
      fontSize: styles.fontSize.small,
      color: "#6b7280",
    },

    // Title styles
    title: {
      fontSize: styles.fontSize.title,
      fontWeight: "bold",
      color: styles.primaryColor,
      textAlign: "center",
      marginBottom: styles.spacing.section,
    },

    subtitle: {
      fontSize: styles.fontSize.heading,
      fontWeight: "bold",
      color: styles.secondaryColor,
      marginBottom: styles.spacing.element,
    },

    sectionTitle: {
      fontSize: styles.fontSize.heading,
      fontWeight: "bold",
      color: styles.primaryColor,
      marginTop: styles.spacing.section,
      marginBottom: styles.spacing.element,
      paddingBottom: 4,
      borderBottomWidth: 1,
      borderBottomColor: styles.primaryColor,
    },

    // Text styles
    text: {
      fontSize: styles.fontSize.body,
      lineHeight: 1.5,
      marginBottom: 4,
    },

    label: {
      fontSize: styles.fontSize.small,
      color: "#6b7280",
      marginBottom: 2,
    },

    value: {
      fontSize: styles.fontSize.body,
      fontWeight: "bold",
    },

    // Table styles
    table: {
      width: "100%",
      marginTop: styles.spacing.element,
      marginBottom: styles.spacing.element,
    },

    tableHeader: {
      flexDirection: "row",
      backgroundColor: styles.primaryColor,
      color: "#ffffff",
      fontWeight: "bold",
      fontSize: styles.fontSize.small,
    },

    tableRow: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderBottomColor: "#e5e7eb",
    },

    tableRowAlt: {
      backgroundColor: "#f9fafb",
    },

    tableCell: {
      padding: 6,
      fontSize: styles.fontSize.small,
    },

    tableCellRight: {
      textAlign: "right",
    },

    // Info box styles
    infoBox: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: styles.spacing.section,
      padding: styles.spacing.element,
      backgroundColor: "#f9fafb",
      borderRadius: 4,
    },

    infoColumn: {
      flex: 1,
    },

    // Totals styles
    totalsBox: {
      marginTop: styles.spacing.section,
      paddingTop: styles.spacing.element,
      borderTopWidth: 1,
      borderTopColor: "#e5e7eb",
    },

    totalRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      marginBottom: 4,
    },

    totalLabel: {
      width: 150,
      textAlign: "right",
      marginRight: 20,
    },

    totalValue: {
      width: 100,
      textAlign: "right",
    },

    grandTotal: {
      fontSize: styles.fontSize.heading,
      fontWeight: "bold",
      color: styles.primaryColor,
    },

    // Footer styles
    footer: {
      position: "absolute",
      bottom: 30,
      left: styles.spacing.page,
      right: styles.spacing.page,
      flexDirection: "row",
      justifyContent: "space-between",
      fontSize: styles.fontSize.small,
      color: "#9ca3af",
      borderTopWidth: 0.5,
      borderTopColor: "#e5e7eb",
      paddingTop: 10,
    },

    pageNumber: {
      textAlign: "center",
    },

    // Cover page styles
    coverPage: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: styles.spacing.page * 2,
    },

    coverLogo: {
      width: 200,
      height: 80,
      marginBottom: 40,
    },

    coverTitle: {
      fontSize: 32,
      fontWeight: "bold",
      color: styles.primaryColor,
      marginBottom: 20,
      textAlign: "center",
    },

    coverSubtitle: {
      fontSize: 18,
      color: styles.secondaryColor,
      marginBottom: 40,
      textAlign: "center",
    },

    coverInfo: {
      marginTop: 60,
      padding: 20,
      borderWidth: 1,
      borderColor: "#e5e7eb",
      borderRadius: 8,
    },

    // Signature styles
    signature: {
      marginTop: 40,
      alignItems: "flex-start",
    },

    signatureLine: {
      width: 200,
      borderBottomWidth: 1,
      borderBottomColor: styles.secondaryColor,
      marginBottom: 4,
    },

    signatureName: {
      fontSize: styles.fontSize.body,
      fontWeight: "bold",
    },

    signatureTitle: {
      fontSize: styles.fontSize.small,
      color: "#6b7280",
    },

    // Compliance styles
    complianceStatus: {
      padding: 2,
      borderRadius: 2,
      fontSize: styles.fontSize.small,
      textAlign: "center",
    },

    statusComply: {
      backgroundColor: "#dcfce7",
      color: "#166534",
    },

    statusNotComply: {
      backgroundColor: "#fee2e2",
      color: "#991b1b",
    },

    statusPartial: {
      backgroundColor: "#fef3c7",
      color: "#92400e",
    },

    statusReview: {
      backgroundColor: "#dbeafe",
      color: "#1e40af",
    },

    // Watermark
    watermark: {
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%) rotate(-45deg)",
      fontSize: 60,
      color: "#e5e7eb",
      opacity: 0.3,
    },
  });
}

// Export default styles
export const styles = createStyles();
