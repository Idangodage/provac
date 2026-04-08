import { View, Text, Image } from "@react-pdf/renderer";

import { styles } from "../styles";
import type { OrganizationInfo } from "../types";

interface HeaderProps {
  organization: OrganizationInfo;
  showLogo?: boolean;
}

export function Header({ organization, showLogo = true }: HeaderProps) {
  return (
    <View style={styles.header}>
      {/* Logo */}
      {showLogo && organization.logo && (
        <Image src={organization.logo} style={styles.logo} />
      )}

      {/* Company Info */}
      <View style={styles.companyInfo}>
        <Text style={styles.companyName}>{organization.name}</Text>
        {organization.address && (
          <Text style={styles.companyDetails}>{organization.address}</Text>
        )}
        {organization.phone && (
          <Text style={styles.companyDetails}>Tel: {organization.phone}</Text>
        )}
        {organization.email && (
          <Text style={styles.companyDetails}>{organization.email}</Text>
        )}
        {organization.website && (
          <Text style={styles.companyDetails}>{organization.website}</Text>
        )}
      </View>
    </View>
  );
}

export default Header;
