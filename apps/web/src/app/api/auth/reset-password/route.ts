import { prisma } from "@provacx/database";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { consumeRateLimit } from "@/lib/rate-limit";
import { getClientIpFromHeaders, isSameOriginRequest } from "@/lib/request";
import { sha256 } from "@/lib/tokens";

const schema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  token: z.string().min(10),
  password: z.string().min(12).max(200),
});

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === "production" && !isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const ip = getClientIpFromHeaders(request.headers) ?? "unknown";
    const ipLimit = consumeRateLimit({
      key: `auth:pw-reset:do:ip:${ip}`,
      windowMs: 15 * 60 * 1000,
      max: 20,
    });
    if (!ipLimit.ok) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const identifier = `reset:${parsed.data.email}`;
    const tokenHash = sha256(parsed.data.token);
    const record = await prisma.verificationToken.findUnique({
      where: { token: tokenHash },
    });

    if (
      !record ||
      record.identifier !== identifier ||
      record.expires < new Date()
    ) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(parsed.data.password, 12);

    await prisma.$transaction([
      prisma.user.updateMany({
        where: { email: parsed.data.email },
        data: {
          password: hashedPassword,
          emailVerified: new Date(),
        },
      }),
      prisma.verificationToken.deleteMany({ where: { identifier } }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Password reset error:", error);
    return NextResponse.json({ error: "Reset failed" }, { status: 500 });
  }
}
