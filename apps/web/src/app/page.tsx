import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* Navigation */}
      <nav className="container mx-auto flex items-center justify-between py-6">
        <div className="text-2xl font-bold text-blue-600">ProvacX</div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="px-4 py-2 text-gray-600 hover:text-gray-900"
          >
            Login
          </Link>
          <Link
            href="/register"
            className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="container mx-auto px-4 py-20 text-center">
        <h1 className="mb-6 text-5xl font-bold text-gray-900">
          HVAC Design to Proposal
          <br />
          <span className="text-blue-600">in One Platform</span>
        </h1>
        <p className="mx-auto mb-8 max-w-2xl text-xl text-gray-600">
          Draw ducted ventilation layouts, auto-generate BOQ, apply pricing,
          and export complete proposals - all in one intelligent platform.
        </p>
        <Link
          href="/register"
          className="inline-block rounded-lg bg-blue-600 px-8 py-4 text-lg font-semibold text-white hover:bg-blue-700"
        >
          Start Free Trial
        </Link>

        {/* Features Grid */}
        <div className="mt-20 grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-4xl">📐</div>
            <h3 className="mb-2 text-lg font-semibold">Smart Drawing</h3>
            <p className="text-gray-600">
              2D HVAC layouts with multiple views - Plan, Section, Elevation, Detail
            </p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-4xl">📊</div>
            <h3 className="mb-2 text-lg font-semibold">Auto BOQ</h3>
            <p className="text-gray-600">
              Extract quantities automatically from drawings with AI assistance
            </p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-4xl">💰</div>
            <h3 className="mb-2 text-lg font-semibold">Pricing & Costing</h3>
            <p className="text-gray-600">
              Manage unit rates, apply markups, and calculate totals instantly
            </p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-lg">
            <div className="mb-4 text-4xl">📄</div>
            <h3 className="mb-2 text-lg font-semibold">Proposal Export</h3>
            <p className="text-gray-600">
              Generate complete PDF proposals with cover letters and compliance
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="container mx-auto py-10 text-center text-gray-500">
        <p>&copy; {new Date().getFullYear()} ProvacX. All rights reserved.</p>
      </footer>
    </div>
  );
}
