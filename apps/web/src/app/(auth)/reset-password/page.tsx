"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const schema = z
  .object({
    password: z.string().min(12, "Password must be at least 12 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type FormData = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setEmail(params.get("email") ?? "");
    setToken(params.get("token") ?? "");
  }, []);

  const onSubmit = async (data: FormData) => {
    setIsLoading(true);
    setError(null);
    setNotice(null);

    if (!email || !token) {
      setError("This reset link is invalid.");
      setIsLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.toLowerCase(),
          token,
          password: data.password,
        }),
      });

      if (res.status === 429) {
        setError("Too many requests. Please try again later.");
        return;
      }

      if (!res.ok) {
        setError("This reset link is invalid or expired.");
        return;
      }

      setNotice("Password updated. Redirecting to sign in...");
      router.push("/login?reset=1");
    } catch {
      setError("Failed to reset password. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-8 rounded-xl bg-white p-8 shadow-lg">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            ProvacX
          </Link>
          <h2 className="mt-4 text-2xl font-semibold text-gray-900">
            Choose a new password
          </h2>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-6">
          {notice && (
            <div className="rounded-md bg-blue-50 p-4 text-sm text-blue-700">
              {notice}
            </div>
          )}
          {error && (
            <div className="rounded-md bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                New password
              </label>
              <input
                {...register("password")}
                type="password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="********"
              />
              <p className="mt-1 text-xs text-gray-500">
                Use 12+ characters. A long passphrase is recommended.
              </p>
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm password
              </label>
              <input
                {...register("confirmPassword")}
                type="password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="********"
              />
              {errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.confirmPassword.message}
                </p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? "Updating..." : "Update password"}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600">
          <Link href="/login" className="text-blue-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
