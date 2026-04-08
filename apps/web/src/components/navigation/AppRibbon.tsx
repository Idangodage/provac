"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const navItems = [
  { id: "projects", label: "Projects", emoji: "\u{1F4C1}", href: "/dashboard" },
  { id: "reports", label: "Reports", emoji: "\u{1F4CA}", href: "/dashboard/reports" },
  { id: "pricing", label: "Pricing", emoji: "\u{1F4B0}", href: "/dashboard/pricing" },
  { id: "settings", label: "Settings", emoji: "\u{2699}\u{FE0F}", href: "/settings" },
];

export default function AppRibbon() {
  const pathname = usePathname();
  const ribbonRef = useRef<HTMLDivElement>(null);
  const minWidth = 96;
  const [maxWidth, setMaxWidth] = useState(280);
  const [ribbonWidth, setRibbonWidth] = useState(minWidth);
  const [isResizing, setIsResizing] = useState(false);
  const expandThreshold = Math.max(minWidth + 32, Math.min(180, maxWidth - 32));
  const isExpanded = ribbonWidth >= expandThreshold;

  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard" || pathname.startsWith("/projects");
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  useEffect(() => {
    const updateBounds = () => {
      const viewport = typeof window !== "undefined" ? window.innerWidth : maxWidth;
      const nextMax = Math.max(minWidth, Math.min(320, Math.floor(viewport * 0.4)));
      setMaxWidth(nextMax);
      setRibbonWidth((current) => Math.min(current, nextMax));
    };

    updateBounds();
    window.addEventListener("resize", updateBounds);

    return () => {
      window.removeEventListener("resize", updateBounds);
    };
  }, [minWidth, maxWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (event: PointerEvent) => {
      const rect = ribbonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = Math.min(Math.max(event.clientX - rect.left, minWidth), maxWidth);
      setRibbonWidth(next);
    };

    const handleUp = () => {
      setIsResizing(false);
    };

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing, minWidth, maxWidth]);

  return (
    <aside
      ref={ribbonRef}
      className={`relative shrink-0 z-30 overflow-hidden ${
        isResizing ? "transition-none" : "transition-[width] duration-200"
      }`}
      style={{ width: ribbonWidth }}
    >
      {/* Collapsed ribbon */}
      <div
        className={`absolute inset-0 flex h-full flex-col items-center gap-6 bg-[#fbf7ee] border-r border-amber-200/70 py-5 transition-opacity duration-200 ${
          isExpanded ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        <div className="flex w-full items-center justify-center px-3">
          <button
            type="button"
            onClick={() => setRibbonWidth(maxWidth)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-200/80 bg-white/80 text-slate-600 hover:bg-amber-50"
            title="Expand ribbon"
          >
            <ChevronsRight size={16} />
          </button>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-400 text-amber-950 text-sm font-bold">
          PX
        </div>
        <nav className="flex flex-col items-center gap-3">
          {navItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              title={item.label}
              className={`flex h-11 w-11 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80 text-xl transition-colors hover:bg-amber-50 ${
                isActive(item.href) ? "bg-amber-100 text-amber-900" : "text-slate-700"
              }`}
            >
              <span aria-hidden>{item.emoji}</span>
              <span className="sr-only">{item.label}</span>
            </Link>
          ))}
        </nav>
      </div>

      {/* Expanded ribbon */}
      <div
        className={`absolute inset-0 h-full w-full bg-[#fbf7ee] border-r border-amber-200/70 shadow-2xl transition-all duration-200 z-40 ${
          isExpanded
            ? "opacity-100 pointer-events-auto translate-x-0"
            : "opacity-0 pointer-events-none -translate-x-2"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="px-4 pt-3">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setRibbonWidth(minWidth)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-200/80 bg-white/80 text-slate-600 hover:bg-amber-50"
                title="Collapse ribbon"
              >
                <ChevronsLeft size={16} />
              </button>
            </div>
          </div>
          <div className="px-4 py-4 border-b border-amber-200/70">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400 text-amber-950 text-sm font-bold">
                  PX
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Workspace</p>
                  <p className="text-sm font-semibold text-slate-800">ProvacX</p>
                </div>
              </div>
            </div>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? "bg-amber-100 text-amber-900"
                    : "text-slate-700 hover:bg-amber-50"
                }`}
              >
                <span className="text-lg" aria-hidden>
                  {item.emoji}
                </span>
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          <div className="px-3 pb-4" />
        </div>
      </div>

      <div
        className="absolute right-0 top-0 h-full w-2 cursor-col-resize bg-amber-200/40 hover:bg-amber-200 z-50"
        onPointerDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
        title="Resize ribbon"
      />
    </aside>
  );
}
