import { Document, Page, View, Text, Image } from "@react-pdf/renderer";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { Table, formatCurrency, type TableColumn } from "../components/Table";
import { styles } from "../styles";
import type { ProposalData } from "../types";

interface ProposalTemplateProps {
  data: ProposalData;
  showCoverPage?: boolean;
  showTableOfContents?: boolean;
}

export function ProposalTemplate({
  data,
  showCoverPage = true,
  showTableOfContents: _showTableOfContents = false,
}: ProposalTemplateProps) {
  const { organization, project, coverLetter, boq, totals, terms, drawingThumbnail } =
    data;

  // BOQ table columns
  const boqColumns: TableColumn[] = [
    { key: "itemNo", header: "Item", width: "8%", align: "center" },
    { key: "description", header: "Description", width: "35%" },
    { key: "unit", header: "Unit", width: "8%", align: "center" },
    { key: "quantity", header: "Qty", width: "10%", align: "right" },
    {
      key: "unitRate",
      header: "Rate",
      width: "12%",
      align: "right",
      format: (v) => formatCurrency(v, totals.currency),
    },
    {
      key: "totalCost",
      header: "Amount",
      width: "15%",
      align: "right",
      format: (v) => formatCurrency(v, totals.currency),
    },
  ];

  // Format date
  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <Document>
      {/* Cover Page */}
      {showCoverPage && (
        <Page size="A4" style={styles.page}>
          <View style={styles.coverPage}>
            {/* Logo */}
            {organization.logo && (
              <Image src={organization.logo} style={styles.coverLogo} />
            )}

            {/* Title */}
            <Text style={styles.coverTitle}>PROPOSAL</Text>
            <Text style={styles.coverSubtitle}>{project.name}</Text>

            {/* Project Info Box */}
            <View style={styles.coverInfo}>
              <View style={{ marginBottom: 10 }}>
                <Text style={styles.label}>Prepared For:</Text>
                <Text style={styles.value}>{project.clientName}</Text>
                {project.clientAddress && (
                  <Text style={styles.text}>{project.clientAddress}</Text>
                )}
              </View>

              <View style={{ marginBottom: 10 }}>
                <Text style={styles.label}>Project Location:</Text>
                <Text style={styles.value}>{project.location}</Text>
              </View>

              <View style={{ marginBottom: 10 }}>
                <Text style={styles.label}>Date:</Text>
                <Text style={styles.value}>{formatDate(project.date)}</Text>
              </View>

              <View>
                <Text style={styles.label}>Reference:</Text>
                <Text style={styles.value}>{project.reference || "—"}</Text>
              </View>
            </View>

            {/* Company Info */}
            <View style={{ marginTop: 60 }}>
              <Text style={styles.companyName}>{organization.name}</Text>
              {organization.address && (
                <Text style={styles.text}>{organization.address}</Text>
              )}
            </View>
          </View>
        </Page>
      )}

      {/* Cover Letter Page */}
      {coverLetter && (
        <Page size="A4" style={styles.page}>
          <Header organization={organization} />

          {/* Date and Reference */}
          <View style={styles.infoBox}>
            <View style={styles.infoColumn}>
              <Text style={styles.label}>Date:</Text>
              <Text style={styles.value}>{formatDate(project.date)}</Text>
            </View>
            <View style={styles.infoColumn}>
              <Text style={styles.label}>Reference:</Text>
              <Text style={styles.value}>{project.reference || "—"}</Text>
            </View>
          </View>

          {/* Recipient */}
          <View style={{ marginBottom: 20 }}>
            <Text style={styles.value}>{project.clientName}</Text>
            {project.clientContact && (
              <Text style={styles.text}>{project.clientContact}</Text>
            )}
            {project.clientAddress && (
              <Text style={styles.text}>{project.clientAddress}</Text>
            )}
          </View>

          {/* Subject */}
          <View style={{ marginBottom: 20 }}>
            <Text style={styles.label}>Subject:</Text>
            <Text style={styles.value}>Proposal for {project.name}</Text>
          </View>

          {/* Letter Content */}
          <View style={{ marginBottom: 30 }}>
            <Text style={styles.text}>{coverLetter}</Text>
          </View>

          <Footer organization={organization} />
        </Page>
      )}

      {/* BOQ Pages */}
      <Page size="A4" style={styles.page}>
        <Header organization={organization} />

        <Text style={styles.sectionTitle}>BILL OF QUANTITIES</Text>

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

        {/* BOQ by Category */}
        {boq.categories.map((category, catIndex) => (
          <View key={catIndex} wrap={false}>
            <Text style={styles.subtitle}>{category.name}</Text>
            <Table
              columns={boqColumns}
              data={category.items as unknown as Record<string, unknown>[]}
            />
            <View style={[styles.totalRow, { marginTop: 4 }]}>
              <Text style={styles.totalLabel}>Category Subtotal:</Text>
              <Text style={styles.totalValue}>
                {formatCurrency(category.subtotal, totals.currency)}
              </Text>
            </View>
          </View>
        ))}

        {/* Totals Section */}
        <View style={styles.totalsBox}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal:</Text>
            <Text style={styles.totalValue}>
              {formatCurrency(totals.subtotal, totals.currency)}
            </Text>
          </View>

          {totals.overhead !== undefined && totals.overhead > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                Overhead ({totals.overheadRate}%):
              </Text>
              <Text style={styles.totalValue}>
                {formatCurrency(totals.overhead, totals.currency)}
              </Text>
            </View>
          )}

          {totals.profit !== undefined && totals.profit > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                Profit ({totals.profitRate}%):
              </Text>
              <Text style={styles.totalValue}>
                {formatCurrency(totals.profit, totals.currency)}
              </Text>
            </View>
          )}

          {totals.contingency !== undefined && totals.contingency > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                Contingency ({totals.contingencyRate}%):
              </Text>
              <Text style={styles.totalValue}>
                {formatCurrency(totals.contingency, totals.currency)}
              </Text>
            </View>
          )}

          {totals.taxAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tax ({totals.taxRate}%):</Text>
              <Text style={styles.totalValue}>
                {formatCurrency(totals.taxAmount, totals.currency)}
              </Text>
            </View>
          )}

          <View
            style={[
              styles.totalRow,
              {
                marginTop: 10,
                paddingTop: 10,
                borderTopWidth: 1,
                borderTopColor: "#1e40af",
              },
            ]}
          >
            <Text style={[styles.totalLabel, styles.grandTotal]}>
              GRAND TOTAL:
            </Text>
            <Text style={[styles.totalValue, styles.grandTotal]}>
              {formatCurrency(totals.total, totals.currency)}
            </Text>
          </View>
        </View>

        <Footer organization={organization} />
      </Page>

      {/* Terms & Conditions Page */}
      {data.includeTerms && (
        <Page size="A4" style={styles.page}>
          <Header organization={organization} />

          <Text style={styles.sectionTitle}>TERMS & CONDITIONS</Text>

          <View style={{ marginBottom: 15 }}>
            <Text style={styles.subtitle}>Validity</Text>
            <Text style={styles.text}>
              This proposal is valid for {terms.validity} days from the date of
              issue.
            </Text>
          </View>

          {terms.paymentTerms && (
            <View style={{ marginBottom: 15 }}>
              <Text style={styles.subtitle}>Payment Terms</Text>
              <Text style={styles.text}>{terms.paymentTerms}</Text>
            </View>
          )}

          {terms.deliveryTerms && (
            <View style={{ marginBottom: 15 }}>
              <Text style={styles.subtitle}>Delivery</Text>
              <Text style={styles.text}>{terms.deliveryTerms}</Text>
            </View>
          )}

          {terms.warrantyPeriod && (
            <View style={{ marginBottom: 15 }}>
              <Text style={styles.subtitle}>Warranty</Text>
              <Text style={styles.text}>{terms.warrantyPeriod}</Text>
            </View>
          )}

          {terms.additionalTerms && terms.additionalTerms.length > 0 && (
            <View style={{ marginBottom: 15 }}>
              <Text style={styles.subtitle}>Additional Terms</Text>
              {terms.additionalTerms.map((term, index) => (
                <Text key={index} style={styles.text}>
                  • {term}
                </Text>
              ))}
            </View>
          )}

          <Footer organization={organization} />
        </Page>
      )}

      {/* Drawing Preview Page */}
      {data.includeDrawings && drawingThumbnail && (
        <Page size="A4" orientation="landscape" style={styles.page}>
          <Header organization={organization} />

          <Text style={styles.sectionTitle}>DRAWING PREVIEW</Text>

          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              marginVertical: 20,
            }}
          >
            <Image
              src={drawingThumbnail}
              style={{
                maxWidth: "100%",
                maxHeight: 400,
                objectFit: "contain",
              }}
            />
          </View>

          <Text style={[styles.text, { textAlign: "center", marginTop: 10 }]}>
            Note: This is a preview only. Detailed drawings will be provided
            upon project award.
          </Text>

          <Footer organization={organization} />
        </Page>
      )}
    </Document>
  );
}

export default ProposalTemplate;
