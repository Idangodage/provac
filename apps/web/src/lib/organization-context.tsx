"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useState, useEffect } from "react";

interface OrganizationContextType {
  organizationId: string | null;
  setOrganizationId: (id: string | null) => void;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

const STORAGE_KEY = "provacx-organization-id";

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const [organizationId, setOrganizationIdState] = useState<string | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setOrganizationIdState(stored);
    }
  }, []);

  const setOrganizationId = (id: string | null) => {
    setOrganizationIdState(id);
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  return (
    <OrganizationContext.Provider value={{ organizationId, setOrganizationId }}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error("useOrganization must be used within an OrganizationProvider");
  }
  return context;
}

export function getOrganizationId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}
