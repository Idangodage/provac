"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useOrganization } from "@/lib/organization-context";
import { trpc } from "@/lib/trpc";

const organizationSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Only lowercase letters, numbers, and hyphens allowed"),
});

type OrganizationFormData = z.infer<typeof organizationSchema>;

export default function OnboardingOrganizationPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { setOrganizationId } = useOrganization();

  const createOrg = trpc.organization.create.useMutation({
    onSuccess: (org) => {
      // Set the organization ID for future API calls
      setOrganizationId(org.id);
      router.push("/dashboard");
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<OrganizationFormData>({
    resolver: zodResolver(organizationSchema),
  });

  // Auto-generate slug from name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    setValue("slug", slug);
  };

  const onSubmit = (data: OrganizationFormData) => {
    setError(null);
    createOrg.mutate(data);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Create Your Organization</h1>
          <p className="mt-2 text-gray-600">
            Set up your company to start creating HVAC projects
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {error && (
            <div className="rounded-md bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Organization Name
            </label>
            <input
              {...register("name", { onChange: handleNameChange })}
              type="text"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="ACME HVAC Solutions"
            />
            {errors.name && (
              <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="slug" className="block text-sm font-medium text-gray-700">
              URL Slug
            </label>
            <div className="mt-1 flex rounded-lg border border-gray-300 shadow-sm focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
              <span className="inline-flex items-center rounded-l-lg bg-gray-50 px-3 text-sm text-gray-500">
                provacx.com/
              </span>
              <input
                {...register("slug")}
                type="text"
                className="block w-full rounded-r-lg border-0 px-3 py-2 focus:outline-none"
                placeholder="acme-hvac"
              />
            </div>
            {errors.slug && (
              <p className="mt-1 text-sm text-red-600">{errors.slug.message}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={createOrg.isPending}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {createOrg.isPending ? "Creating..." : "Create Organization"}
          </button>
        </form>
      </div>
    </div>
  );
}
