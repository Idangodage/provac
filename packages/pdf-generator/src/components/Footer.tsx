import { View, Text } from "@react-pdf/renderer";

import { styles } from "../styles";
import type { OrganizationInfo } from "../types";

interface FooterProps {
  organization: OrganizationInfo;
  showPageNumber?: boolean;
}

export function Footer({
  organization,
  showPageNumber = true,
}: FooterProps) {
  return (
    <View style={styles.footer} fixed>
      {/* Company name */}
      <Text>{organization.name}</Text>

      {/* Page number */}
      {showPageNumber && (
        <Text
          style={styles.pageNumber}
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          }
        />
      )}

      {/* Registration number if available */}
      <Text>{organization.registrationNumber || ""}</Text>
    </View>
  );
}

export default Footer;
