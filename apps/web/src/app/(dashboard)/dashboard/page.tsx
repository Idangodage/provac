"use client";

import Link from "next/link";
import { useEffect } from "react";

import { useOrganization } from "@/lib/organization-context";
import { trpc } from "@/lib/trpc";

export default function DashboardPage() {
  const { data: organizations, isLoading } = trpc.user.getOrganizations.useQuery();
  const { organizationId, setOrganizationId } = useOrganization();

  // Auto-select first organization if none selected
  useEffect(() => {
    if (organizations?.length && !organizationId) {
      setOrganizationId(organizations[0].id);
    }
  }, [organizations, organizationId, setOrganizationId]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  // If no organization, redirect to create one
  if (!organizations?.length) {
    return (
      <div className="rounded-lg bg-white p-8 text-center shadow">
        <h2 className="mb-4 text-xl font-semibold">Welcome to ProvacX!</h2>
        <p className="mb-6 text-gray-600">
          Create your organization to get started with your first project.
        </p>
        <Link
          href="/onboarding/organization"
          className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
        >
          Create Organization
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Your Projects</h1>
        <Link
          href="/projects/new"
          className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          + New Project
        </Link>
      </div>

      {/* Projects list would go here */}
      <div className="rounded-lg bg-white p-6 shadow">
        <p className="text-center text-gray-500">
          No projects yet. Create your first project to get started.
        </p>
      </div>
    </div>
  );
}
