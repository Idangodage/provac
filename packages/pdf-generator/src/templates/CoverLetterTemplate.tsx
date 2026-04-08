import { Document, Page, View, Text, Image } from "@react-pdf/renderer";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { styles } from "../styles";
import type { CoverLetterData } from "../types";

interface CoverLetterTemplateProps {
  data: CoverLetterData;
}

export function CoverLetterTemplate({ data }: CoverLetterTemplateProps) {
  const { organization, project, recipientName, recipientTitle, content, signatory } =
    data;

  // Format date
  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  // Parse content into paragraphs
  const paragraphs = content.split("\n\n").filter((p) => p.trim());

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Header organization={organization} />

        {/* Date */}
        <View style={{ marginBottom: 20 }}>
          <Text style={styles.text}>{formatDate(project.date)}</Text>
        </View>

        {/* Reference */}
        {project.reference && (
          <View style={{ marginBottom: 20 }}>
            <Text style={styles.label}>Ref: {project.reference}</Text>
          </View>
        )}

        {/* Recipient */}
        <View style={{ marginBottom: 30 }}>
          {recipientName && <Text style={styles.value}>{recipientName}</Text>}
          {recipientTitle && <Text style={styles.text}>{recipientTitle}</Text>}
          <Text style={styles.value}>{project.clientName}</Text>
          {project.clientAddress && (
            <Text style={styles.text}>{project.clientAddress}</Text>
          )}
        </View>

        {/* Subject Line */}
        <View style={{ marginBottom: 20 }}>
          <Text style={styles.text}>
            <Text style={{ fontWeight: "bold" }}>Subject: </Text>
            Proposal for {project.name}
          </Text>
        </View>

        {/* Salutation */}
        <View style={{ marginBottom: 15 }}>
          <Text style={styles.text}>
            Dear {recipientName ? recipientName.split(" ")[0] : "Sir/Madam"},
          </Text>
        </View>

        {/* Letter Body */}
        <View style={{ marginBottom: 30 }}>
          {paragraphs.map((paragraph, index) => (
            <Text
              key={index}
              style={[
                styles.text,
                {
                  marginBottom: 12,
                  textAlign: "justify",
                  lineHeight: 1.6,
                },
              ]}
            >
              {paragraph}
            </Text>
          ))}
        </View>

        {/* Closing */}
        <View style={{ marginBottom: 30 }}>
          <Text style={styles.text}>
            We look forward to the opportunity of working with you on this project.
          </Text>
        </View>

        <View style={{ marginBottom: 10 }}>
          <Text style={styles.text}>Yours sincerely,</Text>
        </View>

        {/* Signature */}
        <View style={styles.signature}>
          {/* Signature Image (if available) */}
          {signatory?.signature && (
            <Image
              src={signatory.signature}
              style={{ width: 150, height: 50, marginBottom: 5 }}
            />
          )}

          {/* Signature Line */}
          <View style={styles.signatureLine} />

          {/* Signatory Details */}
          {signatory ? (
            <>
              <Text style={styles.signatureName}>{signatory.name}</Text>
              <Text style={styles.signatureTitle}>{signatory.title}</Text>
            </>
          ) : (
            <>
              <Text style={styles.signatureName}>Authorized Signatory</Text>
              <Text style={styles.signatureTitle}>{organization.name}</Text>
            </>
          )}
        </View>

        {/* Company Contact */}
        <View
          style={{
            marginTop: 40,
            padding: 15,
            backgroundColor: "#f9fafb",
            borderRadius: 4,
          }}
        >
          <Text style={[styles.label, { marginBottom: 5 }]}>For any queries:</Text>
          {organization.phone && (
            <Text style={styles.text}>Phone: {organization.phone}</Text>
          )}
          {organization.email && (
            <Text style={styles.text}>Email: {organization.email}</Text>
          )}
          {organization.website && (
            <Text style={styles.text}>Website: {organization.website}</Text>
          )}
        </View>

        <Footer organization={organization} />
      </Page>
    </Document>
  );
}

export default CoverLetterTemplate;
