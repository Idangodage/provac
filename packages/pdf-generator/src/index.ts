// Types
export * from "./types";

// Styles
export { styles, createStyles, defaultStyles } from "./styles";

// Components
export { Header } from "./components/Header";
export { Footer } from "./components/Footer";
export { Table, formatCurrency, formatNumber, formatPercent } from "./components/Table";
export type { TableColumn } from "./components/Table";

// Templates
export { ProposalTemplate } from "./templates/ProposalTemplate";
export { BOQTemplate } from "./templates/BOQTemplate";
export { CoverLetterTemplate } from "./templates/CoverLetterTemplate";
export { ComplianceTemplate } from "./templates/ComplianceTemplate";

// Re-export @react-pdf/renderer utilities for convenience
export { pdf, renderToBuffer, renderToStream } from "@react-pdf/renderer";
