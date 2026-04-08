"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getProviders, signIn, useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof loginSchema>;

function getAuthErrorMessage(error: string) {
  switch (error) {
    case "Configuration":
      return "Authentication is misconfigured. Please try again later.";
    case "AccessDenied":
      return "Access denied. Please try a different account.";
    case "OAuthAccountNotLinked":
      return "This email is already linked to another sign-in method.";
    case "OAuthCallback":
    case "OAuthCreateAccount":
    case "OAuthSignin":
      return "Google sign-in failed. Please try again.";
    case "CredentialsSignin":
      return "Invalid email or password.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const { status } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const showGoogleButton = providersLoaded && googleEnabled;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    }
  }, [router, status]);

  useEffect(() => {
    const errorParam = new URLSearchParams(window.location.search).get("error");
    if (!errorParam) return;
    setError(getAuthErrorMessage(errorParam));
  }, []);

  useEffect(() => {
    getProviders()
      .then((providers) => {
        setGoogleEnabled(Boolean(providers?.google));
      })
      .finally(() => {
        setProvidersLoaded(true);
      });
  }, []);

  // Listen for OAuth callback messages from popup (with origin check)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only accept messages from same origin to prevent cross-origin attacks
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "oauth-callback" && event.data?.success) {
        router.push("/dashboard");
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [router]);

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password");
      } else {
        router.push("/dashboard");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      // Use direct redirect to Google OAuth
      await signIn("google", { callbackUrl: "/dashboard" });
    } catch {
      setError("Failed to sign in with Google. Please try again.");
      setIsGoogleLoading(false);
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
            Welcome Back
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
                placeholder="••••••••"
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? "Signing in..." : "Sign In"}
          </button>

          {showGoogleButton && (
            <>
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
                {isGoogleLoading ? "Signing in..." : "Continue with Google"}
              </button>
            </>
          )}
        </form>

        <div className="text-center space-y-2">
          <p className="text-sm text-gray-600">
            <Link href="/forgot-password" className="text-blue-600 hover:underline">
              Forgot your password?
            </Link>
          </p>
          <p className="text-sm text-gray-600">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="text-blue-600 hover:underline">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
