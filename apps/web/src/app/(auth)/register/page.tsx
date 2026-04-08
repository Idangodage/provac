"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(12, "Password must be at least 12 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type RegisterFormData = z.infer<typeof registerSchema>;

type RegistrationState = "form" | "success" | "redirecting";

export default function RegisterPage() {
  const router = useRouter();
  const { status } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [registrationState, setRegistrationState] = useState<RegistrationState>("form");
  const [userName, setUserName] = useState("");
  const [countdown, setCountdown] = useState(3);

  // Redirect if already authenticated
  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    }
  }, [router, status]);

  // Countdown and redirect after successful registration
  useEffect(() => {
    if (registrationState === "success") {
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            setRegistrationState("redirecting");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [registrationState]);

  // Redirect after countdown
  useEffect(() => {
    if (registrationState === "redirecting") {
      router.push("/onboarding/organization");
    }
  }, [registrationState, router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = async (data: RegisterFormData) => {
    setIsLoading(true);
    setError(null);

    try {
      // Create user via API (validates + hashes password on server)
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          email: data.email,
          password: data.password,
        }),
      });

      if (response.status === 429) {
        setError("Too many attempts. Please try again later.");
        setIsLoading(false);
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message = body?.error ?? "Registration failed";
        if (message === "User already exists") {
          setError("An account with this email already exists.");
        } else {
          setError(message);
        }
        setIsLoading(false);
        return;
      }

      // Sign in silently (redirect: false)
      const signInResult = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (signInResult?.error) {
        throw new Error("Sign in failed");
      }

      // Show success state
      setUserName(data.name.split(" ")[0] ?? ""); // First name only
      setRegistrationState("success");
    } catch {
      setError("Registration failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      await signIn("google", { callbackUrl: "/onboarding/organization" });
    } catch {
      setError("Failed to sign in with Google. Please try again.");
      setIsGoogleLoading(false);
    }
  };

  // Success Screen
  if (registrationState === "success" || registrationState === "redirecting") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="w-full max-w-md space-y-8 rounded-xl bg-white p-8 shadow-lg text-center">
          {/* Success Icon */}
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg
              className="h-8 w-8 text-green-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>

          {/* Welcome Message */}
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              Welcome to ProvacX{userName ? `, ${userName}` : ""}!
            </h2>
            <p className="mt-2 text-gray-600">
              Your account has been created successfully.
            </p>
          </div>

          {/* Progress Indicator */}
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              {registrationState === "redirecting"
                ? "Redirecting you now..."
                : `Setting up your workspace in ${countdown}...`}
            </p>

            {/* Loading Animation */}
            <div className="flex justify-center">
              <div className="flex space-x-2">
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-600" style={{ animationDelay: "0ms" }} />
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-600" style={{ animationDelay: "150ms" }} />
                <div className="h-2 w-2 animate-bounce rounded-full bg-blue-600" style={{ animationDelay: "300ms" }} />
              </div>
            </div>

            {/* Skip Button */}
            <button
              onClick={() => router.push("/onboarding/organization")}
              className="text-sm text-blue-600 hover:underline"
            >
              Continue now
            </button>
          </div>

          {/* What's Next */}
          <div className="rounded-lg bg-blue-50 p-4 text-left">
            <h3 className="text-sm font-medium text-blue-900">What&apos;s next?</h3>
            <ul className="mt-2 space-y-1 text-sm text-blue-700">
              <li className="flex items-center gap-2">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Set up your organization
              </li>
              <li className="flex items-center gap-2">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Create your first project
              </li>
              <li className="flex items-center gap-2">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Invite your team members
              </li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Registration Form
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-8 rounded-xl bg-white p-8 shadow-lg">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            ProvacX
          </Link>
          <h2 className="mt-4 text-2xl font-semibold text-gray-900">
            Create your account
          </h2>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-6">
          {error && (
            <div className="rounded-md bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                Full Name
              </label>
              <input
                {...register("name")}
                type="text"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="John Doe"
              />
              {errors.name && (
                <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                {...register("email")}
                type="email"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="you@example.com"
              />
              {errors.email && (
                <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                {...register("password")}
                type="password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="••••••••••••"
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
                Confirm Password
              </label>
              <input
                {...register("confirmPassword")}
                type="password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="••••••••••••"
              />
              {errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? "Creating account..." : "Create Account"}
          </button>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-white px-2 text-gray-500">or</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {isGoogleLoading ? (
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            {isGoogleLoading ? "Signing up..." : "Continue with Google"}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link href="/login" className="text-blue-600 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
