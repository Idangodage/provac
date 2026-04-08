<p align="center">
  <h1 align="center">ProvacX</h1>
  <p align="center">
    <strong>End-to-End HVAC Design-to-Proposal Platform</strong>
  </p>
  <p align="center">
    A unified SaaS platform that transforms HVAC estimating workflows from fragmented tools into a seamless experience.
  </p>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#services--infrastructure">Services</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#api-reference">API Reference</a> •
  <a href="#deployment">Deployment</a> •
  <a href="#data-storage">Data Storage</a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Services & Infrastructure](#services--infrastructure)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Database Schema](#database-schema)
- [HTTP Endpoints](#http-endpoints)
- [API Reference](#api-reference)
  - [Complete API Procedures List](#complete-api-procedures-list)
  - [Usage Examples](#usage-examples)
- [Scripts](#scripts)
- [Project Workflows](#project-workflows)
- [Deployment](#deployment)
- [Data Storage](#data-storage)
- [Development Roadmap](#development-roadmap)
- [Package Details](#package-details)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Overview

**ProvacX** consolidates HVAC design, estimation, and proposal generation into a single platform. Instead of juggling CAD software, spreadsheets, pricing catalogs, and document editors, contractors and MEP teams can complete their entire workflow in one place.

### The Problem

HVAC estimating traditionally requires:
- CAD software for layout design
- Spreadsheets for Bill of Quantities (BOQ)
- Separate pricing catalogs and databases
- Manual document assembly for proposals
- Multiple rounds of data re-entry between tools

### The Solution

ProvacX provides:
1. **Smart Drawing Editor** - CAD-like interface with 60+ HVAC component symbols
2. **Automated BOQ Generation** - Extract quantities directly from drawings
3. **Pricing Engine** - Apply unit rates, markups, and rules automatically
4. **Proposal Generation** - Create professional PDFs with one click

---

## Features

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **Multi-tenant Organizations** | Role-based access control (Owner, Admin, Member, Viewer) |
| **Smart 2D Drawing Editor** | Fabric.js + Konva-powered CAD interface with HVAC symbols |
| **Auto BOQ Extraction** | Generate Bill of Quantities from drawing components |
| **Pricing Rules Engine** | Markups, discounts, overhead, profit, tax calculations |
| **Proposal Management** | Version control, status tracking, PDF generation |
| **Project Workflows** | Full design, BOQ-only, quick quote, or import modes |
| **File Management** | Upload drawings, technical documents, site photos |
| **Technical Library** | Store and index manufacturer specifications |

### HVAC Component Types

The drawing editor supports 60+ component types following SMACNA standards:

- **Ductwork**: Rectangular, Round, Oval, Flexible
- **Fittings**: Elbows, Tees, Reducers, Transitions, Offsets
- **Terminals**: Diffusers, Grilles, Registers, VAV Boxes
- **Equipment**: AHUs, FCUs, Chillers, Cooling Towers, Pumps
- **VRF Systems**: Outdoor Units, Indoor Units, Piping
- **Accessories**: Dampers, Filters, Silencers, Access Doors

---

## Services & Infrastructure

ProvacX uses a modern, cloud-native stack with **all free-tier services** for cost-effective deployment.

### Decided Services

| Category | Service | Provider | Purpose | Free Tier |
|----------|---------|----------|---------|-----------|
| **Database** | PostgreSQL (Serverless) | [Neon](https://neon.tech) | Primary data storage | 0.5GB storage |
| **App Hosting** | Next.js Serverless | [Vercel](https://vercel.com) | Application hosting | 100GB bandwidth/mo |
| **Authentication** | NextAuth v5 | Self-hosted | Login, sessions, JWT | Unlimited |
| **OAuth Provider** | Google Sign-in | [Google Cloud](https://console.cloud.google.com) | Social login | Unlimited |
| **File Storage** | S3-compatible | [Cloudflare R2](https://cloudflare.com) | Drawings, PDFs, photos | 10GB storage |
| **AI/ML** | Gemini API | [Google AI Studio](https://aistudio.google.com) | BOQ extraction, compliance | 60 req/min free |
| **Email** | Transactional | [Resend](https://resend.com) | Auth emails, notifications | 3,000 emails/mo |

### Service Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PROVACX INFRASTRUCTURE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│    ┌───────────────────────────────────────────────────────────┐       │
│    │                      VERCEL (Free)                        │       │
│    │                   App Hosting & CDN                       │       │
│    │                                                           │       │
│    │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │       │
│    │  │  Next.js    │  │   tRPC      │  │  NextAuth   │       │       │
│    │  │  Frontend   │  │   API       │  │   Auth      │       │       │
│    │  └─────────────┘  └─────────────┘  └─────────────┘       │       │
│    └───────────────────────────────────────────────────────────┘       │
│                │                │                │                      │
│                ▼                ▼                ▼                      │
│    ┌───────────────┐  ┌───────────────┐  ┌───────────────┐             │
│    │     NEON      │  │ CLOUDFLARE R2 │  │    RESEND     │             │
│    │   (Free)      │  │    (Free)     │  │    (Free)     │             │
│    │               │  │               │  │               │             │
│    │  PostgreSQL   │  │  File Storage │  │    Email      │             │
│    │  Database     │  │  - Drawings   │  │  - Auth       │             │
│    │  - Users      │  │  - PDFs       │  │  - Invites    │             │
│    │  - Projects   │  │  - Photos     │  │  - Alerts     │             │
│    │  - BOQ        │  │  - Manuals    │  │               │             │
│    └───────────────┘  └───────────────┘  └───────────────┘             │
│                                                                         │
│    ┌───────────────┐  ┌───────────────┐                                │
│    │ GOOGLE GEMINI │  │ GOOGLE CLOUD  │                                │
│    │    (Free)     │  │    (Free)     │                                │
│    │               │  │               │                                │
│    │  Gemini API   │  │  OAuth 2.0    │                                │
│    │  - BOQ AI     │  │  - Google     │                                │
│    │  - Compliance │  │    Sign-in    │                                │
│    └───────────────┘  └───────────────┘                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Service Details

#### Neon (Database)
- **Type**: Serverless PostgreSQL
- **Why chosen**: Auto-scaling, generous free tier, Prisma compatible
- **Free limits**: 0.5GB storage, 1 project, auto-suspend after inactivity
- **Connection**: `postgresql://user:pass@ep-xxx.neon.tech/provacx?sslmode=require`

#### Vercel (Hosting)
- **Type**: Serverless Next.js hosting
- **Why chosen**: Zero-config for Next.js, automatic HTTPS, preview deployments
- **Free limits**: 100GB bandwidth, 100 deployments/day
- **Domain**: `your-app.vercel.app` (free subdomain)

#### Cloudflare R2 (File Storage)
- **Type**: S3-compatible object storage
- **Why chosen**: No egress fees, S3-compatible API, generous free tier
- **Free limits**: 10GB storage, 1M Class A ops, 10M Class B ops
- **Bucket structure**:
  ```
  provacx-files/
  ├── drawings/{orgId}/{projectId}/
  ├── photos/{orgId}/{projectId}/
  ├── pdfs/{orgId}/{proposalId}/
  ├── docs/{orgId}/
  ├── avatars/{userId}/
  └── logos/{orgId}/
  ```

#### NextAuth v5 (Authentication)
- **Type**: Self-hosted authentication
- **Why chosen**: Full control, multiple providers, JWT sessions
- **Providers configured**:
  - Email/Password (Credentials)
  - Google OAuth 2.0
- **Session strategy**: JWT (stateless)

#### Google Gemini (AI)
- **Type**: Large Language Model API
- **Why chosen**: Generous free tier, multimodal capabilities for drawings
- **Use cases**:
  - Auto-extract BOQ from uploaded drawings
  - Compliance checking
  - Technical document parsing
- **Free tier**: 60 requests/minute, 1M tokens/minute

#### Resend (Email)
- **Type**: Transactional email API
- **Why chosen**: Developer-friendly, React Email support, good deliverability
- **Free limits**: 3,000 emails/month, 100/day
- **Use cases**:
  - Authentication emails
  - Organization invitations
  - Proposal notifications

### Cost Summary

| Environment | Monthly Cost |
|-------------|--------------|
| **Development** | $0 |
| **Small Production** (<1000 users) | $0 |
| **Medium Production** | $20-50 |
| **Large Production** | $100+ |

### Service Sign-up Links

| Service | Sign-up URL |
|---------|-------------|
| Neon | https://neon.tech/signup |
| Vercel | https://vercel.com/signup |
| Cloudflare | https://dash.cloudflare.com/sign-up |
| Google Cloud | https://console.cloud.google.com |
| Google AI Studio | https://aistudio.google.com |
| Resend | https://resend.com/signup |

---

## Quick Start

### Prerequisites

- **Node.js** 20 or higher
- **pnpm** 10.0.0 or higher
- **PostgreSQL** (local, Docker, or hosted like Neon)

### Installation

```bash
# Clone the repository
git clone https://github.com/Idangodage/provacx.git
cd provacx

# Install dependencies
pnpm install

# Set up environment variables
pnpm setup:env
# Edit these files with your values:
# - apps/web/.env.local
# - packages/database/.env

# Validate your local setup
pnpm setup:check

# Generate Prisma client
pnpm db:generate
# If Windows shows EPERM on Prisma engine rename, stop running dev servers and retry.

# Push schema to database
pnpm db:push

# Start development server
pnpm dev
```

### Environment Variables

Create `apps/web/.env.local` with the following:

```env
# Required
DATABASE_URL="postgresql://user:password@localhost:5432/provacx"
AUTH_URL="http://localhost:3000"
NEXTAUTH_URL="http://localhost:3000"
AUTH_SECRET="your-secret-key-min-32-chars"

# Optional - Google OAuth
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# Optional - File Storage (Cloudflare R2)
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET_NAME=""
R2_PUBLIC_URL=""

# Optional - AI Features (Google Gemini)
GOOGLE_AI_API_KEY=""

# Optional - Email (Resend)
RESEND_API_KEY=""
EMAIL_FROM="noreply@yourdomain.com"
```

---

## Architecture

### Monorepo Structure

```
provacx/
├── apps/
│   └── web/                      # Next.js 14 application
│       ├── src/
│       │   ├── app/              # App Router pages
│       │   │   ├── (auth)/       # Login, Register
│       │   │   ├── (dashboard)/  # Protected routes
│       │   │   └── api/          # API routes
│       │   ├── components/       # React components
│       │   ├── lib/              # Utilities
│       │   └── providers/        # Context providers
│       └── public/               # Static assets
│
├── packages/
│   ├── api/                      # tRPC routers & procedures
│   ├── database/                 # Prisma schema & client
│   ├── drawing-engine/           # HVAC CAD editor
│   ├── boq-engine/               # BOQ editor & state
│   ├── document-editor/          # Covering letter editor
│   ├── pdf-generator/            # React PDF templates
│   ├── ocr-engine/               # OCR utilities
│   ├── shared/                   # Shared types & constants
│   ├── ui/                       # UI component library
│   ├── config-eslint/            # ESLint configuration
│   └── config-typescript/        # TypeScript configuration
│
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Browser                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   NextAuth  │  │  tRPC Client│  │  Zustand    │  │   Editors   │    │
│  │   Session   │  │  React Query│  │   Stores    │  │   (Canvas)  │    │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┘  └─────────────┘    │
└─────────┼────────────────┼─────────────────────────────────────────────┘
          │                │
          ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Next.js App (apps/web)                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    API Routes (/api/...)                         │   │
│  │  ┌──────────────────┐  ┌────────────────────────────────────┐   │   │
│  │  │  /api/auth/[...] │  │  /api/trpc (httpBatchLink)         │   │   │
│  │  │  NextAuth Handler│  │  tRPC Handler                      │   │   │
│  │  └──────────────────┘  └────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       tRPC Server (packages/api)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │    User     │  │Organization │  │   Project   │  │   Drawing   │    │
│  │   Router    │  │   Router    │  │   Router    │  │   Router    │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                     │
│  │    BOQ      │  │   Pricing   │  │  Proposal   │                     │
│  │   Router    │  │   Router    │  │   Router    │                     │
│  └─────────────┘  └─────────────┘  └─────────────┘                     │
│                                                                         │
│  Middleware: publicProcedure → protectedProcedure → organizationProcedure│
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Prisma Client (packages/database)                    │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           PostgreSQL Database                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | Next.js 14 (App Router) |
| **Language** | TypeScript 5 |
| **UI** | React 18, Tailwind CSS, Radix UI |
| **State** | Zustand, React Query (TanStack) |
| **API** | tRPC v11 (end-to-end type safety) |
| **Database** | PostgreSQL via Prisma 5 |
| **Auth** | NextAuth v5 (Credentials + OAuth) |
| **Drawing** | Fabric.js 6, Konva, React Konva |
| **PDF** | @react-pdf/renderer |
| **OCR** | Tesseract.js, PDF.js |
| **Validation** | Zod |
| **Monorepo** | Turborepo, pnpm |

---

## Database Schema

### Core Entities

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│       User       │────<│ OrganizationUser │>────│   Organization   │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                                           │
                                                           │
                         ┌──────────────────┐              │
                         │     Project      │<─────────────┘
                         └──────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│     Drawing      │   │     BOQItem      │   │    Proposal      │
└──────────────────┘   └──────────────────┘   └──────────────────┘
          │
          ▼
┌──────────────────┐
│DrawingComponent  │
└──────────────────┘
```

### Key Models

| Model | Purpose |
|-------|---------|
| `User` | User accounts with email/password or OAuth |
| `Organization` | Multi-tenant company/team entity |
| `OrganizationUser` | Membership with roles (OWNER, ADMIN, MEMBER, VIEWER) |
| `Project` | Main work unit with status and workflow type |
| `Drawing` | Canvas state for plan/section/elevation views |
| `DrawingComponent` | Individual HVAC components on drawings |
| `BOQItem` | Line items with quantities and costs |
| `UnitRate` | Organization-level pricing database |
| `PricingRule` | Project-level pricing logic |
| `Proposal` | Generated proposals with versioning |
| `Subscription` | SaaS plan with usage limits |

### Enums

```typescript
// Project Status Lifecycle
enum ProjectStatus {
  DRAFT, IN_PROGRESS, SUBMITTED, APPROVED,
  REJECTED, COMPLETED, ARCHIVED
}

// Project Workflow Types
enum ProjectWorkflow {
  FULL,     // Drawing → BOQ → Pricing → Proposal
  BOQ,      // BOQ → Pricing → Proposal
  QUICK,    // Quick Quote
  IMPORT    // Import Existing
}

// BOQ Categories
enum BOQCategory {
  DUCTWORK, FITTINGS, TERMINALS, EQUIPMENT,
  VRF_PIPING, INSULATION, SUPPORTS, ACCESSORIES,
  ELECTRICAL, CONTROLS, TESTING, MISCELLANEOUS
}

// Pricing Types
enum PricingType {
  MARKUP_PERCENTAGE, MARKUP_FIXED,
  DISCOUNT_PERCENTAGE, DISCOUNT_FIXED,
  OVERHEAD, PROFIT, CONTINGENCY
}
```

---

## HTTP Endpoints

### REST API Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/trpc/[trpc]` | GET, POST | tRPC handler for all API procedures |
| `/api/auth/[...nextauth]` | GET, POST | NextAuth authentication handlers (login, logout, session) |
| `/api/auth/register` | POST | User registration with email/password credentials |

### Authentication Flow

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Client    │────>│ /api/auth/register  │────>│  Create User    │
└─────────────┘     └─────────────────────┘     └─────────────────┘

┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Client    │────>│ /api/auth/[...next] │────>│  NextAuth       │
│             │     │   /signin           │     │  Session        │
└─────────────┘     └─────────────────────┘     └─────────────────┘

┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Client    │────>│ /api/trpc/*         │────>│  tRPC Router    │
│  + Session  │     │ + x-organization-id │     │  + Middleware   │
└─────────────┘     └─────────────────────┘     └─────────────────┘
```

---

## API Reference

### Procedure Types

| Type | Description | Header Required |
|------|-------------|-----------------|
| `publicProcedure` | No authentication required | None |
| `protectedProcedure` | Requires logged-in user | Session cookie |
| `organizationProcedure` | Requires org membership | `x-organization-id` |
| `adminProcedure` | Requires ADMIN or OWNER role | `x-organization-id` |
| `ownerProcedure` | Requires OWNER role | `x-organization-id` |

### Complete API Procedures List

#### User Router (`user.*`) - 5 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `user.me` | query | protected | - | Get current authenticated user |
| `user.updateProfile` | mutation | protected | `{ name?, image? }` | Update user profile |
| `user.getOrganizations` | query | protected | - | List all organizations user belongs to |
| `user.getOnboardingStatus` | query | protected | - | Get onboarding completion status |
| `user.checkEmail` | mutation | public | `{ email }` | Check if email already exists |

#### Organization Router (`organization.*`) - 9 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `organization.create` | mutation | protected | `{ name, slug, logo?, address?, phone?, website?, timezone?, currency? }` | Create new organization |
| `organization.getCurrent` | query | org | - | Get current organization details |
| `organization.update` | mutation | admin | `{ name?, logo?, address?, phone?, website?, timezone?, currency? }` | Update organization |
| `organization.delete` | mutation | owner | - | Delete organization |
| `organization.getMembers` | query | org | - | List all organization members |
| `organization.inviteMember` | mutation | admin | `{ email, role }` | Invite new member |
| `organization.removeMember` | mutation | admin | `{ userId }` | Remove member from organization |
| `organization.updateMemberRole` | mutation | admin | `{ userId, role }` | Change member's role |
| `organization.transferOwnership` | mutation | owner | `{ newOwnerId }` | Transfer ownership to another member |

#### Project Router (`project.*`) - 7 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `project.list` | query | org | `{ status?, search?, limit?, cursor? }` | List projects with pagination |
| `project.getById` | query | org | `{ id }` | Get project with calculated totals |
| `project.create` | mutation | org | `{ name, description?, clientName?, clientEmail?, clientPhone?, location?, workflow?, layoutTemplate?, layoutSettings? }` | Create new project |
| `project.update` | mutation | org | `{ id, name?, description?, clientName?, clientEmail?, clientPhone?, location?, status?, taxRate?, validityDays?, warrantyMonths?, defaultTerms? }` | Update project |
| `project.delete` | mutation | org | `{ id }` | Delete project |
| `project.duplicate` | mutation | org | `{ id, name }` | Duplicate project with BOQ and pricing |
| `project.getProgress` | query | org | `{ id }` | Get workflow completion status |

#### Drawing Router (`drawing.*`) - 11 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `drawing.listByProject` | query | org | `{ projectId }` | List drawings for a project |
| `drawing.getById` | query | org | `{ id }` | Get drawing with all components |
| `drawing.create` | mutation | org | `{ projectId, name, description?, viewType?, canvasData? }` | Create new drawing |
| `drawing.update` | mutation | org | `{ id, name?, description?, viewType?, canvasData?, thumbnail? }` | Update drawing (auto-increments version) |
| `drawing.delete` | mutation | org | `{ id }` | Delete drawing |
| `drawing.addComponent` | mutation | org | `{ drawingId, type, name?, properties, position, layerId?, groupId? }` | Add HVAC component to drawing |
| `drawing.updateComponent` | mutation | org | `{ id, name?, properties?, position?, isLocked?, isVisible? }` | Update component |
| `drawing.deleteComponent` | mutation | org | `{ id }` | Delete component |
| `drawing.addConnection` | mutation | org | `{ drawingId, fromComponentId, toComponentId, connectionType, properties? }` | Connect two components |
| `drawing.addCutLine` | mutation | org | `{ drawingId, name, startX, startY, endX, endY, direction? }` | Add section cut line |
| `drawing.addDetailArea` | mutation | org | `{ drawingId, name, x, y, width, height, scale? }` | Add detail zoom area |

#### BOQ Router (`boq.*`) - 6 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `boq.listByProject` | query | org | `{ projectId, category? }` | List BOQ items grouped by category with totals |
| `boq.create` | mutation | org | `{ projectId, componentId?, category, itemNumber?, description, specification?, unit, quantity, unitRate?, materialCost?, labourCost?, notes? }` | Add BOQ item |
| `boq.update` | mutation | org | `{ id, category?, itemNumber?, description?, specification?, unit?, quantity?, unitRate?, materialCost?, labourCost?, notes?, sortOrder? }` | Update BOQ item |
| `boq.delete` | mutation | org | `{ id }` | Delete BOQ item |
| `boq.extractFromDrawing` | mutation | org | `{ drawingId }` | Auto-generate BOQ from drawing components |
| `boq.bulkUpdateOrder` | mutation | org | `{ projectId, items: [{ id, sortOrder }] }` | Reorder BOQ items |

#### Pricing Router (`pricing.*`) - 10 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `pricing.getUnitRates` | query | org | `{ category?, search?, limit?, cursor? }` | Get organization unit rates |
| `pricing.createUnitRate` | mutation | admin | `{ category, itemCode?, description, unit, materialRate, labourRate, currency? }` | Create unit rate |
| `pricing.updateUnitRate` | mutation | admin | `{ id, category?, itemCode?, description?, unit?, materialRate?, labourRate?, isActive? }` | Update unit rate |
| `pricing.deleteUnitRate` | mutation | admin | `{ id }` | Delete unit rate |
| `pricing.getProjectRules` | query | org | `{ projectId }` | Get project pricing rules |
| `pricing.createRule` | mutation | org | `{ projectId, name, type, scope, category?, value, priority? }` | Create pricing rule |
| `pricing.updateRule` | mutation | org | `{ id, name?, type?, scope?, category?, value?, priority?, isActive? }` | Update pricing rule |
| `pricing.deleteRule` | mutation | org | `{ id }` | Delete pricing rule |
| `pricing.applyRatesToBoq` | mutation | org | `{ projectId }` | Apply unit rates and rules to all BOQ items |
| `pricing.calculateTotals` | query | org | `{ projectId }` | Calculate full totals with overhead, profit, tax |

#### Proposal Router (`proposal.*`) - 8 procedures

| Procedure | Type | Auth Level | Input | Description |
|-----------|------|------------|-------|-------------|
| `proposal.listByProject` | query | org | `{ projectId }` | List all proposals for a project |
| `proposal.getById` | query | org | `{ id }` | Get proposal with project details |
| `proposal.create` | mutation | org | `{ projectId, coverLetter?, terms?, notes? }` | Create proposal with BOQ snapshot |
| `proposal.update` | mutation | org | `{ id, coverLetter?, terms?, notes?, status? }` | Update proposal content/status |
| `proposal.updateTotals` | mutation | org | `{ projectId }` | Recalculate totals from current BOQ |
| `proposal.markAsSent` | mutation | org | `{ id }` | Mark proposal as sent to client |
| `proposal.delete` | mutation | org | `{ id }` | Delete proposal |
| `proposal.generatePdf` | mutation | org | `{ id }` | Generate PDF (stub - needs implementation) |

### API Summary

| Router | Procedures | Description |
|--------|------------|-------------|
| `user` | 5 | User profile and onboarding |
| `organization` | 9 | Multi-tenant organization management |
| `project` | 7 | Project CRUD and workflow |
| `drawing` | 11 | Drawing canvas and components |
| `boq` | 6 | Bill of quantities management |
| `pricing` | 10 | Unit rates and pricing rules |
| `proposal` | 8 | Proposal generation and tracking |
| **Total** | **56** | **Complete API surface** |

### Usage Examples

#### User Router

```typescript
// Get current user
const user = await trpc.user.me.query();

// Update profile
await trpc.user.updateProfile.mutate({ name: "John Doe" });

// Get organizations
const orgs = await trpc.user.getOrganizations.query();

// Check onboarding status
const status = await trpc.user.getOnboardingStatus.query();
```

#### Organization Router

```typescript
// Create organization
const org = await trpc.organization.create.mutate({
  name: "HVAC Solutions Inc",
  slug: "hvac-solutions",
  currency: "USD",
  timezone: "America/New_York"
});

// Get current organization
const current = await trpc.organization.getCurrent.query();

// Invite member
await trpc.organization.inviteMember.mutate({
  email: "new@member.com",
  role: "MEMBER"
});

// Update member role
await trpc.organization.updateMemberRole.mutate({
  userId: "user_123",
  role: "ADMIN"
});
```

#### Project Router

```typescript
// List projects (paginated)
const projects = await trpc.project.list.query({
  limit: 10,
  status: "IN_PROGRESS"
});

// Create project
const project = await trpc.project.create.mutate({
  name: "Office Building HVAC",
  clientName: "ABC Corp",
  workflow: "FULL"
});

// Get project with calculated totals
const details = await trpc.project.getById.query({ id: "proj_123" });

// Duplicate project
const copy = await trpc.project.duplicate.mutate({
  id: "proj_123",
  name: "Office Building HVAC (Copy)"
});
```

#### Drawing Router

```typescript
// Create drawing
const drawing = await trpc.drawing.create.mutate({
  projectId: "proj_123",
  name: "Ground Floor Plan",
  viewType: "PLAN"
});

// Add component
await trpc.drawing.addComponent.mutate({
  drawingId: "draw_123",
  type: "RECTANGULAR_DUCT",
  properties: {
    width: 400,
    height: 200,
    length: 3000
  },
  position: { x: 100, y: 200, z: 0, rotation: 0 }
});

// Update canvas state
await trpc.drawing.update.mutate({
  id: "draw_123",
  canvasData: { /* Fabric.js JSON */ }
});
```

#### BOQ Router

```typescript
// List BOQ items with totals
const boq = await trpc.boq.listByProject.query({ projectId: "proj_123" });

// Create item
await trpc.boq.create.mutate({
  projectId: "proj_123",
  category: "DUCTWORK",
  description: "Rectangular Duct 400x200",
  quantity: 25,
  unit: "LM",
  unitRate: 45.00
});

// Extract BOQ from drawing
await trpc.boq.extractFromDrawing.mutate({ drawingId: "draw_123" });
```

#### Pricing Router

```typescript
// Get organization unit rates
const rates = await trpc.pricing.getUnitRates.query({ category: "DUCTWORK" });

// Create unit rate
await trpc.pricing.createUnitRate.mutate({
  category: "DUCTWORK",
  description: "Rectangular Duct (per LM)",
  unit: "LM",
  materialRate: 30.00,
  labourRate: 15.00
});

// Apply rates to BOQ
await trpc.pricing.applyRatesToBoq.mutate({ projectId: "proj_123" });

// Calculate totals with overhead/profit/tax
const totals = await trpc.pricing.calculateTotals.query({
  projectId: "proj_123"
});
```

#### Proposal Router

```typescript
// Create proposal
const proposal = await trpc.proposal.create.mutate({
  projectId: "proj_123",
  coverLetter: "Dear Client...",
  terms: "Payment terms..."
});

// Update proposal
await trpc.proposal.update.mutate({
  id: "prop_123",
  status: "PENDING_REVIEW"
});

// Mark as sent
await trpc.proposal.markAsSent.mutate({ id: "prop_123" });

// Generate PDF
const { pdfUrl } = await trpc.proposal.generatePdf.mutate({ id: "prop_123" });
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all dev servers via Turbo |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint all packages |
| `pnpm type-check` | TypeScript validation |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:push` | Push schema to database |
| `pnpm db:studio` | Open Prisma Studio GUI |
| `pnpm format` | Format with Prettier |
| `pnpm clean` | Clean all build outputs |

### Filtering

Run commands for specific packages:

```bash
# Run only web app
pnpm --filter @provacx/web dev

# Build only API package
pnpm --filter @provacx/api build

# Type-check database package
pnpm --filter @provacx/database type-check
```

---

## Project Workflows

ProvacX supports four distinct workflows to accommodate different use cases:

### 1. Full Workflow (`FULL`)

```
Drawing → BOQ Extraction → Pricing → Proposal
```

Complete end-to-end process from CAD design to client proposal.

### 2. BOQ-Only Workflow (`BOQ`)

```
Manual BOQ Entry → Pricing → Proposal
```

For projects where drawings are done externally or already exist.

### 3. Quick Quote Workflow (`QUICK`)

```
Quick Estimate → Proposal
```

Rapid estimation without detailed BOQ breakdowns.

### 4. Import Workflow (`IMPORT`)

```
Import Existing → Review → Proposal
```

Import data from external sources (spreadsheets, other systems).

---

## Deployment

### Deployment Options

| Platform | Type | Best For |
|----------|------|----------|
| **Vercel** | Serverless | Production (recommended) |
| **Railway** | Container | Full-stack with database |
| **Docker** | Container | Self-hosted |
| **AWS/GCP** | Cloud | Enterprise |

### Vercel Deployment (Recommended)

1. **Connect Repository**
   ```bash
   # Install Vercel CLI
   npm i -g vercel

   # Link project
   vercel link
   ```

2. **Configure Build Settings**
   ```json
   {
     "framework": "nextjs",
     "buildCommand": "pnpm build",
     "outputDirectory": "apps/web/.next",
     "installCommand": "pnpm install"
   }
   ```

3. **Set Environment Variables**
   ```bash
   vercel env add DATABASE_URL
   vercel env add NEXTAUTH_URL
   vercel env add AUTH_SECRET
   ```

4. **Deploy**
   ```bash
   vercel --prod
   ```

### Docker Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine AS base

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/*/package.json ./packages/*/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm db:generate
RUN pnpm build

# Production
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

```bash
# Build and run
docker build -t provacx .
docker run -p 3000:3000 --env-file .env provacx
```

### Self-Hosted Deployment

```bash
# 1. Clone and install
git clone https://github.com/Idangodage/provacx.git
cd provacx
pnpm install

# 2. Configure environment
pnpm setup:env
# Edit env files with production values
pnpm setup:check

# 3. Build
pnpm db:generate
pnpm build

# 4. Start production server
pnpm --filter @provacx/web start
```

### Database Options

| Provider | Type | Connection String |
|----------|------|-------------------|
| **Neon** (Recommended) | Serverless PostgreSQL | `postgresql://user:pass@ep-xxx.region.aws.neon.tech/provacx?sslmode=require` |
| **Supabase** | PostgreSQL + extras | `postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres` |
| **Railway** | Managed PostgreSQL | `postgresql://postgres:pass@containers.railway.app:5432/railway` |
| **Self-hosted** | PostgreSQL 14+ | `postgresql://user:pass@localhost:5432/provacx` |

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `AUTH_URL` | Application base URL (preferred) | `https://provacx.com` |
| `NEXTAUTH_URL` | Base URL fallback for compatibility | `https://provacx.com` |
| `AUTH_SECRET` | Session encryption key (32+ chars) | `your-super-secret-key-here` |

### Optional Environment Variables

| Variable | Description | Service |
|----------|-------------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret | Google Cloud |
| `R2_ACCOUNT_ID` | Cloudflare account ID | Cloudflare R2 |
| `R2_ACCESS_KEY_ID` | R2 access key | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | R2 secret key | Cloudflare R2 |
| `R2_BUCKET_NAME` | R2 bucket name | Cloudflare R2 |
| `R2_PUBLIC_URL` | R2 public URL | Cloudflare R2 |
| `GOOGLE_AI_API_KEY` | AI features API key | Google AI Studio |
| `RESEND_API_KEY` | Email service API key | Resend |
| `EMAIL_FROM` | Sender email address | Resend |

---

## Data Storage

### Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Data Storage Locations                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │   PostgreSQL    │  │   localStorage  │  │  Cloudflare R2  │         │
│  │   (Primary DB)  │  │   (Client-side) │  │  (File Storage) │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                   │
│           ▼                    ▼                    ▼                   │
│  • Users & Auth       • Editor drafts      • Uploaded drawings          │
│  • Organizations      • Current org ID     • Site photos                │
│  • Projects           • UI preferences     • Generated PDFs             │
│  • Drawings           • Session state      • Technical manuals          │
│  • BOQ Items                                                            │
│  • Pricing Rules                                                        │
│  • Proposals                                                            │
│  • Subscriptions                                                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Primary Database (PostgreSQL)

| Data Category | Tables | Description |
|---------------|--------|-------------|
| **Authentication** | `User`, `Account`, `Session`, `VerificationToken` | User accounts, OAuth, sessions |
| **Organizations** | `Organization`, `OrganizationUser`, `OrganizationInvitation` | Multi-tenant data |
| **Projects** | `Project` | Project metadata, settings, status |
| **Drawings** | `Drawing`, `DrawingComponent`, `Connection`, `CutLine`, `DetailArea` | Canvas state, components |
| **BOQ** | `BOQItem` | Line items, quantities, costs |
| **Pricing** | `UnitRate`, `PricingRule` | Rates and pricing rules |
| **Proposals** | `Proposal` | Versions, totals, PDF URLs |
| **Files** | `FileUpload` | File metadata (URLs) |
| **Technical Docs** | `TechnicalDocument`, `DocumentChunk`, `ExtractedProduct` | Indexed specs |
| **Subscriptions** | `Subscription`, `UsageRecord` | Plans & usage |
| **Site Tracking** | `SiteProgress`, `FaultReport`, `MaterialUsage` | Field data |
| **Audit** | `AuditLog`, `PlatformAdmin` | Admin trails |
| **Messaging** | `Message` | In-project communication |

### Client-Side Storage (localStorage)

| Key | Data Type | Description |
|-----|-----------|-------------|
| `provacx-org-id` | `string` | Current organization ID |
| `provacx-drawing-draft-{id}` | `JSON` | Unsaved drawing changes |
| `provacx-boq-draft-{id}` | `JSON` | Unsaved BOQ changes |
| `provacx-theme` | `string` | UI theme preference |

### File Storage (Cloudflare R2)

| File Type | Bucket Path | Purpose |
|-----------|-------------|---------|
| Drawing imports | `/drawings/{orgId}/{projectId}/` | Uploaded CAD files |
| Site photos | `/photos/{orgId}/{projectId}/` | Project documentation |
| Generated PDFs | `/pdfs/{orgId}/{proposalId}/` | Proposals & BOQ exports |
| Technical manuals | `/docs/{orgId}/` | Manufacturer specs |
| User avatars | `/avatars/{userId}/` | Profile images |
| Organization logos | `/logos/{orgId}/` | Company branding |

### Data Flow Diagram

```
┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
│  Browser │───>│  Next.js App │───>│  tRPC Server  │───>│  PostgreSQL  │
│          │    │  (apps/web)  │    │ (packages/api)│    │   Database   │
└──────────┘    └──────────────┘    └───────────────┘    └──────────────┘
     │                │                     │
     │                │                     │
     ▼                ▼                     ▼
┌──────────┐    ┌──────────────┐    ┌───────────────┐
│ localStorage│ │   Cookies    │    │ Cloudflare R2 │
│  (drafts) │    │  (session)   │    │   (files)     │
└──────────┘    └──────────────┘    └───────────────┘
```

### Database Connection

```typescript
// packages/database/src/client.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

### Backup & Recovery

```bash
# PostgreSQL backup
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Restore
psql $DATABASE_URL < backup_20240101.sql

# Prisma seed (development)
pnpm db:seed
```

---

## Development Roadmap

### Implemented

- [x] Multi-tenant authentication & organizations
- [x] Project management with workflows
- [x] Smart drawing editor with HVAC symbols
- [x] BOQ editor with categories
- [x] Pricing engine with rules
- [x] Proposal management
- [x] tRPC API layer (56 procedures)
- [x] Database schema (20+ models)

### In Progress

- [ ] PDF generation integration
- [ ] OCR/AI drawing recognition
- [ ] Editor-to-API persistence
- [ ] Email notifications

### Planned

- [ ] Mobile app for site tracking
- [ ] Advanced analytics dashboard
- [ ] Team collaboration features
- [ ] Stripe billing integration
- [ ] API documentation (OpenAPI)
- [ ] CI/CD pipeline
- [ ] E2E testing suite

---

## Package Details

### @provacx/drawing-engine

Smart HVAC CAD editor built with Fabric.js and Konva.

**Components:**
- `SmartDrawingEditor` - Main editor container
- `DrawingCanvas` - Canvas rendering layer
- `Toolbar` - Drawing tools
- `SymbolPalette` - HVAC component library
- `LayersPanel` - Layer management
- `PropertiesPanel` - Component properties

**Features:**
- Grid snapping and alignment guides
- Multi-view support (Plan, Section, Elevation, Detail)
- Component connections and routing
- Undo/redo history
- Export to JSON/SVG

### @provacx/boq-engine

Bill of Quantities editor with state management.

**Features:**
- Category-based organization
- Automatic calculations
- Drag-and-drop reordering
- Import/export capabilities
- Real-time cost updates

### @provacx/document-editor

Covering letter and proposal document editor.

**Components:**
- `RichTextEditor` - WYSIWYG text editing
- `CoveringLetterEditor` - Template-based letters
- `SignaturePad` - Digital signatures
- `PropertyPanel` - Document settings

### @provacx/pdf-generator

PDF generation using React PDF.

**Templates:**
- BOQ export
- Proposal document
- Covering letter
- Summary reports

### @provacx/ocr-engine

OCR and document extraction utilities.

**Capabilities:**
- Image text extraction (Tesseract.js)
- PDF text extraction (PDF.js)
- Drawing recognition (planned)
- Table extraction (planned)

---

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow existing code style (ESLint + Prettier)
- Write TypeScript with strict types
- Add tests for new features
- Update documentation as needed
- Keep PRs focused and atomic

### Code Style

```bash
# Format code
pnpm format

# Lint code
pnpm lint

# Type check
pnpm type-check
```

---

## Troubleshooting

### Common Issues

**Database connection fails**
```bash
# Check DATABASE_URL format
postgresql://user:password@host:5432/database

# Ensure PostgreSQL is running
pg_isready -h localhost -p 5432
```

**Prisma client not generated**
```bash
pnpm db:generate
```

**Port already in use**
```bash
# Kill process on port 3000
npx kill-port 3000
```

**Module not found errors**
```bash
# Clean and reinstall
pnpm clean
pnpm install
pnpm db:generate
```

**tRPC errors**
```bash
# Check x-organization-id header is set for org-scoped procedures
# Verify session cookie exists for protected procedures
```

---

## FAQ

**Q: Can I use MySQL instead of PostgreSQL?**

A: The schema is designed for PostgreSQL. While Prisma supports MySQL, some features may need adjustment.

**Q: How do I add custom HVAC components?**

A: Extend the `ComponentType` enum in the Prisma schema and add corresponding rendering in the drawing engine.

**Q: Is there a demo environment?**

A: Not yet. You can run locally using the quick start guide.

**Q: How do I reset the database?**

A: Run `pnpm db:push --force-reset` (this will delete all data).

**Q: What's the API rate limit?**

A: Currently no rate limiting is implemented. Add middleware for production use.

**Q: How do I add a new API endpoint?**

A: Add a new procedure to the appropriate router in `packages/api/src/routers/`.

---

## License

This project is proprietary software. See [LICENSE](LICENSE) for details.

---

## Support

- **Issues**: [GitHub Issues](https://github.com/Idangodage/provacx/issues)
- **Documentation**: This README and inline code comments
- **Email**: Contact the maintainers

---

<p align="center">
  Built with precision for HVAC professionals
</p>
