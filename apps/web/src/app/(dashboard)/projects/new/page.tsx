"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { trpc } from "@/lib/trpc";

const projectSchema = z.object({
  name: z.string().min(1, "Project name is required").max(200),
  description: z.string().max(1000).optional(),
  clientName: z.string().max(200).optional(),
  clientEmail: z.string().email().optional().or(z.literal("")),
  location: z.string().max(500).optional(),
  workflow: z.enum(["FULL", "BOQ", "QUICK"]).default("FULL"),
});

type ProjectFormData = z.infer<typeof projectSchema>;

export default function NewProjectPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const { data: organizations, isLoading } = trpc.user.getOrganizations.useQuery();
  const orgId = organizations?.[0]?.id;

  const createProject = trpc.project.create.useMutation({
    onSuccess: (project) => {
      router.push(`/projects/${project.id}/drawing`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      workflow: "FULL",
    },
  });

  const onSubmit = (data: ProjectFormData) => {
    if (!orgId) {
      setError("No organization found. Please create one first.");
      return;
    }
    setError(null);
    createProject.mutate({
      ...data,
      clientEmail: data.clientEmail || undefined,
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (!orgId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-gray-500">No organization found. Please create one first.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Create New Project</h1>
        <p className="mt-2 text-gray-600">
          Start a new HVAC design project
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 rounded-lg bg-white p-6 shadow">
        {error && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
            Project Name *
          </label>
          <input
            {...register("name")}
            type="text"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Office Building HVAC System"
          />
          {errors.name && (
            <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
          )}
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            {...register("description")}
            rows={3}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Brief description of the project..."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="clientName" className="block text-sm font-medium text-gray-700">
              Client Name
            </label>
            <input
              {...register("clientName")}
              type="text"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="ABC Corporation"
            />
          </div>

          <div>
            <label htmlFor="clientEmail" className="block text-sm font-medium text-gray-700">
              Client Email
            </label>
            <input
              {...register("clientEmail")}
              type="email"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="client@example.com"
            />
          </div>
        </div>

        <div>
          <label htmlFor="location" className="block text-sm font-medium text-gray-700">
            Project Location
          </label>
          <input
            {...register("location")}
            type="text"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="123 Main Street, City, Country"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Workflow Type
          </label>
          <div className="grid grid-cols-3 gap-4">
            <label className="flex cursor-pointer items-center rounded-lg border border-gray-300 p-4 hover:bg-gray-50 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50">
              <input
                {...register("workflow")}
                type="radio"
                value="FULL"
                className="sr-only"
              />
              <div>
                <p className="font-medium text-gray-900">Full Workflow</p>
                <p className="text-xs text-gray-500">Drawing → BOQ → Pricing → Proposal</p>
              </div>
            </label>

            <label className="flex cursor-pointer items-center rounded-lg border border-gray-300 p-4 hover:bg-gray-50 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50">
              <input
                {...register("workflow")}
                type="radio"
                value="BOQ"
                className="sr-only"
              />
              <div>
                <p className="font-medium text-gray-900">BOQ Only</p>
                <p className="text-xs text-gray-500">Manual BOQ entry</p>
              </div>
            </label>

            <label className="flex cursor-pointer items-center rounded-lg border border-gray-300 p-4 hover:bg-gray-50 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50">
              <input
                {...register("workflow")}
                type="radio"
                value="QUICK"
                className="sr-only"
              />
              <div>
                <p className="font-medium text-gray-900">Quick Quote</p>
                <p className="text-xs text-gray-500">Fast estimate</p>
              </div>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-4 pt-4">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createProject.isPending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {createProject.isPending ? "Creating..." : "Create Project"}
          </button>
        </div>
      </form>
    </div>
  );
}
