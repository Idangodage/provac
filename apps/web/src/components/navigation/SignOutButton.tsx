"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  const handleSignOut = async () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("provacx-organization-id");
    }
    // Clear all auth-related cookies and redirect to login
    await signOut({
      callbackUrl: "/login",
      redirect: true,
    });
  };

  return (
    <button
      onClick={handleSignOut}
      className="text-sm text-gray-500 hover:text-gray-700"
    >
      Sign out
    </button>
  );
}
