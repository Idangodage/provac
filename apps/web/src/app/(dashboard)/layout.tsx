import Link from "next/link";
import { redirect } from "next/navigation";

import AppRibbon from "@/components/navigation/AppRibbon";
import { auth, signOut } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Navigation */}
      <nav className="border-b bg-white">
        <div className="flex h-16 items-center justify-between px-6">
          <Link href="/dashboard" className="text-xl font-bold text-blue-600">
            ProvacX
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{session.user.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </nav>

      {/* Ribbon + Content */}
      <div className="flex min-h-[calc(100vh-4rem)] w-full">
        <AppRibbon />

        <main className="flex-1 min-w-0 p-4">{children}</main>
      </div>
    </div>
  );
}
